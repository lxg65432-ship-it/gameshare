#!/usr/bin/env node
/**
 * 信令地址可用性判据的验收（旧隧道邀请失效提示）。
 *
 * ## 这功能解决什么
 *
 * Cloudflare quick tunnel **每次重启都换一个随机地址**。之前发出的邀请全部作废，
 * 而客人看到的是 Socket.IO 的 `xhr poll error` —— 与「对方服务没起」**完全同一句话**，
 * 处置却相反：前者要「请对方重发邀请」，后者要「让对方开服务」。
 *
 * 判据是**主动探测那个地址现在返回的是不是本应用**。
 *
 * ## 为什么判据能测
 *
 * 判据本身是**纯函数**（`classifyProbe(status, body)`）：只吃状态码与响应体，
 * 不做 I/O。所以能穷举各种真实响应形状 —— 隧道活着、隧道没了、反代 502、
 * 有人把别的服务挂在同一地址上 —— 而不必真的去架一个隧道。
 *
 * 用法：
 *   node scripts/check-reachability.mjs
 */
/* global AbortController */
// `AbortController` 在 Node 18+ 是全局量（与浏览器同名同义）。
// 上面的 eslint 注释只是告诉 linter「这个全局量确实存在」——
// 不要为了消警告去 require 一个 shim 模块，那反而是给同一个东西造第二份来源。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const failures = [];
let total = 0;

function check(name, ok, detail = '') {
  total += 1;
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
    failures.push({ name, detail });
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

function loadTs(relPath) {
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  void createRequire;
  const absolute = path.join(root, relPath);
  const out = path.join(root, '.cache', `check-reachability-${path.basename(relPath)}.cjs`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  esbuild.buildSync({
    entryPoints: [absolute],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  return require(out);
}

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

const R = loadTs('packages/shared/src/reachability.ts');

/* ------------------------------------------------------------------ *
 * 1. classifyProbe —— 核心判据
 * ------------------------------------------------------------------ */

section('判据：那个地址现在返回的是不是本应用');

{
  const ALIVE = JSON.stringify({
    ok: true,
    service: 'game-share-signaling',
    protocolVersion: 1,
    rooms: 1,
  });
  check('服务在应答 ⇒ alive', R.classifyProbe(200, ALIVE) === 'alive');

  // 隧道重启后 trycloudflare 返回的是 Cloudflare 自己的错误页
  const CF_HTML = '<!DOCTYPE html><html><head><title>error code: 1033</title></head><body>cloudflare</body></html>';
  check('Cloudflare 错误页 ⇒ tunnel-gone', R.classifyProbe(530, CF_HTML) === 'tunnel-gone');

  check(
    'Cloudflare 的 JSON 错误体（无 service 字段）⇒ tunnel-gone',
    R.classifyProbe(404, JSON.stringify({ success: false, errors: [{ code: 1016 }] })) === 'tunnel-gone',
  );

  check('压根没应答 ⇒ unreachable（**不是** tunnel-gone）', R.classifyProbe(0, '') === 'unreachable');
  check('空响应体 + 0 状态 ⇒ unreachable', R.classifyProbe(0, '') === 'unreachable');

  // ⚠️ 这一条是本节最要紧的：unreachable 与 tunnel-gone 的处置相反，
  // 把前者算成后者会让用户去要新邀请，而真实病因是对方服务没起。
  check(
    'unreachable 绝不等于 tunnel-gone（反之亦然）',
    R.classifyProbe(0, '') !== R.classifyProbe(530, CF_HTML),
  );

  // 有人把别的服务挂在同一地址上，可能回 200
  check('别的服务回 200 ⇒ unknown（不是 alive）', R.classifyProbe(200, '<html>nginx</html>') === 'unknown');
  check(
    '同地址上的别的 JSON 服务 ⇒ unknown',
    R.classifyProbe(200, JSON.stringify({ service: 'some-other-app' })) === 'unknown',
  );
  check('反代 502 的通用错误页 ⇒ unknown（不硬猜）', R.classifyProbe(502, 'Bad Gateway') === 'unknown');

  // 认服务标识而不是认 200：cloudflare 出现在 body 里但也带 service 字段怎么办？
  // 理论上不该发生，但判据必须确定：以 service 标识为准。
  check(
    '带本应用标识的响应一律 alive（哪怕正文里也提到 cloudflare）',
    R.classifyProbe(200, JSON.stringify({ service: 'game-share-signaling', note: 'via cloudflare' })) === 'alive',
  );

  check('502 但正文含本应用标识 ⇒ alive（标识优先）', R.classifyProbe(502, ALIVE) === 'alive');

  // 空 body
  check('200 + 空 body ⇒ unknown', R.classifyProbe(200, '') === 'unknown');
  check('null body 不炸 ⇒ unknown', R.classifyProbe(200, null) === 'unknown');
}

/* ------------------------------------------------------------------ *
 * 2. looksLikeTunnelUrl
 * ------------------------------------------------------------------ */

section('识别隧道地址');

{
  check('标准隧道地址', R.looksLikeTunnelUrl('https://abc-def.trycloudflare.com') === true);
  // ⚠️ 别写「带端口的隧道地址应被排除」这种断言 —— WHATWG URL 会把默认端口
  // （https 的 443、http 的 80）规范化成空串，所以 `https://x:443` 解析出来
  // `port === ''`，与不带端口是同一个地址。显式写 `:443` 仍然是隧道地址。
  check('显式写 :443 仍被认成隧道（URL 把默认端口规范化了）', R.looksLikeTunnelUrl('https://abc.trycloudflare.com:443') === true);
  check('非默认端口则不算（真隧道不会那样）', R.looksLikeTunnelUrl('https://abc.trycloudflare.com:8443') === false);
  check('缺协议也能认', R.looksLikeTunnelUrl('abc.trycloudflare.com') === true);
  check('localhost 不是隧道', R.looksLikeTunnelUrl('http://localhost:8080') === false);
  check('局域网 IP 不是隧道', R.looksLikeTunnelUrl('http://192.168.1.5:8080') === false);
  check('相似域名不误判（evil-trycloudflare.com）', R.looksLikeTunnelUrl('https://x.evil-trycloudflare.com') === false);
  check('空串不炸', R.looksLikeTunnelUrl('') === false);
  check('纯垃圾输入不炸', R.looksLikeTunnelUrl('!!!') === false);
}

/* ------------------------------------------------------------------ *
 * 3. hostOf
 * ------------------------------------------------------------------ */

section('取主机名');

{
  check('标准地址', R.hostOf('https://abc.trycloudflare.com') === 'abc.trycloudflare.com');
  check('带端口', R.hostOf('http://192.168.1.5:8080') === '192.168.1.5');
  check('缺协议', R.hostOf('localhost:8080') === 'localhost');
  check('带路径', R.hostOf('http://a.example.com:8080/x/y') === 'a.example.com');
  check('空串返回空', R.hostOf('') === '');
  check('垃圾输入返回空而不是抛', R.hostOf(':::') === '');
}

/* ------------------------------------------------------------------ *
 * 4. 提示文案 —— 主机与客人的动作完全相反
 * ------------------------------------------------------------------ */

section('提示文案：主机与客人分岔');

{
  const URL_ = 'https://abc-def.trycloudflare.com';

  const guest = R.describeReachability('tunnel-gone', URL_, { isOwnTunnel: false });
  const host = R.describeReachability('tunnel-gone', URL_, { isOwnTunnel: true });

  check('客人文案说「让他重发邀请」', guest.includes('重发') || guest.includes('新的邀请'), guest.slice(0, 120));
  check('客人文案明说「你自己这边不用改」', guest.includes('你自己这边不用改'), guest.slice(0, 160));
  check('客人文案**不**让他去开隧道', !guest.includes('打开左侧「异地访问」'), guest.slice(0, 160));

  check('主机文案说「重新开隧道」', host.includes('异地访问'), host.slice(0, 160));
  check('主机文案说「把新地址的邀请重新发给对方」', host.includes('重新发'), host.slice(0, 200));
  check('主机文案**不**说「请他重发」（他是主机，没人可求）', !host.includes('请他'), host.slice(0, 200));

  check('两种身份文案不同（这是本节的核心）', guest !== host);
  check('unreachable 客人文案也不指向新邀请', !R.describeReachability('unreachable', URL_, { isOwnTunnel: false }).includes('重发'));
  check('unreachable 主机文案指向隧道开关', R.describeReachability('unreachable', URL_, { isOwnTunnel: true }).includes('异地访问'));

  const alive = R.describeReachability('alive', URL_, { isOwnTunnel: false });
  check('alive 的文案明说「不是地址失效」（避免误以为要重发邀请）', alive.includes('不是地址失效'), alive.slice(0, 140));

  const unknown = R.describeReachability('unknown', URL_, { isOwnTunnel: false });
  check('unknown 明说「不确定」', unknown.includes('不确定'), unknown.slice(0, 120));
  check('unknown 引用了服务标识（让人能自己核对）', unknown.includes('game-share-signaling'), unknown.slice(0, 200));

  // 文案里必须带上地址本身：用户常有多个地址，不知道在说哪个
  for (const kind of ['alive', 'tunnel-gone', 'unreachable', 'unknown']) {
    check(`${kind} 的文案带上了主机名`, R.describeReachability(kind, URL_, { isOwnTunnel: false }).includes('abc-def.trycloudflare.com'));
  }
}

/* ------------------------------------------------------------------ *
 * 5. 与运输层错误合并
 * ------------------------------------------------------------------ */

section('与运输层错误合并');

{
  const HINT = '原始错误：xhr poll error';

  const merged = R.mergeWithTransportError(HINT, 'tunnel-gone', 'https://a.trycloudflare.com', { isOwnTunnel: false });
  check(
    '合并后既有诊断也有原始错误',
    // 判据写「文案提到重发」而不是抄某一句原话 —— 改文案不该让验收变红，
    // 但「诊断与原始错误都在」这件事本身必须钉住。
    /重发|新的邀请/.test(merged) && merged.includes('xhr poll error'),
    merged.slice(0, 200),
  );
  check('合并结果是两行（诊断在前，原始错误在后）', merged.split('\n').length === 2, merged.slice(0, 200));

  const kept = R.mergeWithTransportError(HINT, 'unknown', 'https://a.trycloudflare.com', { isOwnTunnel: false });
  check('unknown 时原样返回原始错误（不叠加猜测）', kept === HINT, kept);

  const kept2 = R.mergeWithTransportError(HINT, 'unreachable', 'https://a.trycloudflare.com', { isOwnTunnel: false });
  check('unreachable 也保留原始错误（超时 vs 拒绝连接是条有用线索）', kept2.includes('xhr poll error'), kept2.slice(0, 200));
}

/* ------------------------------------------------------------------ *
 * 6. 端到端：真起一个服务 + 真探测
 * ------------------------------------------------------------------ */

section('端到端：真起 HTTP 服务，用真 fetch 探');

const e2e = await runProbeAgainstRealServer();
for (const item of e2e) check(item.name, item.ok, item.detail);

/* ------------------------------------------------------------------ *
 * 7. 与本项目 /health 的字段一致性
 * ------------------------------------------------------------------ */

section('与真实 /health 响应一致');

{
  // 判据认的是 `service` 字段的值。这个字段由 signaling-server 产生，
  // 改了那边而没改这边 ⇒ 判据永远返回 unknown，功能静默失效。
  const serverSrc = fs.readFileSync(
    path.join(root, 'apps/signaling/src/signaling-server.ts'),
    'utf8',
  );
  check(
    '信令服务确实在返回 service 字段',
    serverSrc.includes(`service: '${R.SIGNALING_SERVICE_ID}'`),
    '判据认这个标识；它不在响应里，功能会静默失效',
  );
  check('判据标识非空', typeof R.SIGNALING_SERVICE_ID === 'string' && R.SIGNALING_SERVICE_ID.length > 0);
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log('\n══════════════════════════════════════');
if (failures.length === 0) {
  console.log(`  ✓ 全部 ${total} 项通过`);
  console.log('══════════════════════════════════════');
  process.exit(0);
}
console.log(`  ✗ ${failures.length} 项未通过（共 ${total} 项）：`);
for (const f of failures) console.log(`      · ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
console.log('══════════════════════════════════════');
process.exit(1);

/* ------------------------------------------------------------------ *
 * 端到端
 * ------------------------------------------------------------------ */

async function runProbeAgainstRealServer() {
  const out = [];
  const http = require('node:http');

  // 探针的网络层在渲染层（依赖 DOM fetch + AbortController），
  // 这里只验「真起一个服务、真发一次 HTTP」这条链路，逻辑与 probe.ts 一致。
  async function probe(base) {
    const target = `${base.replace(/\/+$/, '')}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(target, { cache: 'no-store', signal: controller.signal });
      const body = await res.text();
      return { status: res.status, body };
    } catch {
      return { status: 0, body: '' };
    } finally {
      clearTimeout(timer);
    }
  }

  // 1) 真的信令服务
  const alive = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: R.SIGNALING_SERVICE_ID, protocolVersion: 1 }));
  });
  await new Promise((r) => alive.listen(0, '127.0.0.1', r));
  const alivePort = alive.address().port;
  const r1 = await probe(`http://127.0.0.1:${alivePort}`);
  out.push({
    name: '探到活着的信令服务 ⇒ alive',
    ok: R.classifyProbe(r1.status, r1.body) === 'alive',
    detail: `status=${r1.status}`,
  });
  out.push({
    name: '无 /health 路由时探到根路径拿到 404（服务没起 vs 路由不同）',
    ok: typeof r1.status === 'number',
  });
  await new Promise((r) => alive.close(r));

  // 2) 「隧道没了」的实际形态：服务器还在，但返回的不是本应用
  const gone = http.createServer((req, res) => {
    res.writeHead(530, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>error code: 1033</title></head><body>cloudflare</body></html>');
  });
  await new Promise((r) => gone.listen(0, '127.0.0.1', r));
  const gonePort = gone.address().port;
  const r2 = await probe(`http://127.0.0.1:${gonePort}`);
  out.push({
    name: '探到 Cloudflare 式错误页 ⇒ tunnel-gone',
    ok: R.classifyProbe(r2.status, r2.body) === 'tunnel-gone',
    detail: `status=${r2.status}`,
  });
  await new Promise((r) => gone.close(r));

  // 3) 真的什么都没有
  const deadPort = await findClosedPort();
  const r3 = await probe(`http://127.0.0.1:${deadPort}`);
  out.push({
    name: '探到没人监听的端口 ⇒ unreachable',
    ok: R.classifyProbe(r3.status, r3.body) === 'unreachable',
    detail: `status=${r3.status}`,
  });
  out.push({
    name: 'unreachable ≠ tunnel-gone（真探测也成立）',
    ok: R.classifyProbe(r3.status, r3.body) !== R.classifyProbe(530, 'cloudflare'),
  });

  // 4) 别的服务
  const other = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>It works!</body></html>');
  });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const otherPort = other.address().port;
  const r4 = await probe(`http://127.0.0.1:${otherPort}`);
  out.push({
    name: '探到别的服务（回 200）⇒ unknown，不是 alive',
    ok: R.classifyProbe(r4.status, r4.body) === 'unknown',
    detail: `status=${r4.status}`,
  });
  await new Promise((r) => other.close(r));

  return out;
}

/** 找一个确定没人监听的端口：先开再关 */
async function findClosedPort() {
  const http = require('node:http');
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
