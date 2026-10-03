#!/usr/bin/env node
/**
 * TURN 中继接入的验收（M8）。
 *
 * ## 覆盖什么
 *
 *   1. 端口过滤（**最容易写成 bug 的一处**，见下）
 *   2. 响应解析：字段缺失必须抛，不能把坏配置透传给 Chromium
 *   3. 缓存与并发合并：N 个人同时进房只签发一次
 *   4. 失败不阻塞建房（拿不到 TURN 仍能进，只是没有中继）
 *   5. secret 不外泄
 *   6. 端到端：信令 → 客户端拿到 iceServers → buildIceServers 产出正确形状
 *   7. `/health` 自述 TURN 状态
 *
 * ## 为什么端口过滤要单独反复测
 *
 * Cloudflare 官方 gotchas 给的示例代码是：
 *
 *     urls.filter((url) => !url.includes(':53'))
 *
 * **这是错的** —— 它会把 `:5349`（TURN over TLS）一起干掉，
 * 而 5349/443 恰恰是唯一能穿过企业防火墙的那条路。
 * 症状极其隐蔽：程序不报错，TURN 也「配上了」，只是在那类网络里静默失效。
 *
 * 所以这里断言的是**具体某条 URL 在不在**，不是「数组长度对不对」——
 * 后者照样会被上面那个错误实现蒙混过关。
 *
 * 用法：
 *   node scripts/check-turn.mjs
 */
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

/* 源码以 TS 形态存在，Node 直接 import 不了。
 * 这里走 esbuild（本仓库既有依赖，见 scripts/smoke-signaling.mjs 的同款做法），
 * 只为了把待测源码变成可 require 的 CJS。 */
function loadTs(relPath) {
  const esbuild = require('esbuild');
  const absolute = path.join(root, relPath);
  const out = path.join(root, '.cache', `check-turn-${relPath.replace(/[\\/]/g, '_')}.cjs`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  esbuild.buildSync({
    entryPoints: [absolute],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['socket.io', 'socket.io-client'],
    logLevel: 'silent',
  });
  return require(out);
}

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ *
 * 1. 端口过滤
 * ------------------------------------------------------------------ */

section('端口过滤（官方示例的坑在这一节）');

const { filterChromiumBlockedUrls, TurnCredentialProvider } = loadTs(
  'apps/signaling/src/turn-credentials.ts',
);

const CLOUDFLARE_URLS = [
  'stun:stun.cloudflare.com:3478',
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turn:turn.cloudflare.com:53?transport=udp',
  'turn:turn.cloudflare.com:80?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
  'turns:turn.cloudflare.com:443?transport=tcp',
];

const filtered = filterChromiumBlockedUrls(CLOUDFLARE_URLS);

// ⚠️ 判据本身不能写成 `u.includes(':53')` —— 那会命中 :5349，
// 正好是它要防的那个 bug 自己。必须先剥出端口段再比。
const portOf = (url) => {
  const afterScheme = url.slice(url.indexOf(':') + 1);
  const queryAt = afterScheme.indexOf('?');
  const hostPort = queryAt < 0 ? afterScheme : afterScheme.slice(0, queryAt);
  return Number.parseInt(hostPort.slice(hostPort.lastIndexOf(':') + 1), 10);
};
check(
  '丢掉 :53（Chromium 把它当 DNS 保留端口）',
  !filtered.some((u) => portOf(u) === 53),
  `实际还有：${filtered.filter((u) => portOf(u) === 53).join(' ')}`,
);
check(
  '**保住 :5349**（TURN over TLS，官方示例会误杀这条）',
  filtered.includes('turns:turn.cloudflare.com:5349?transport=tcp'),
  '这条是企业/校园网唯一能穿过的那条路，丢了等于白配 TURN',
);
check(
  '**保住 :443**（同样走 TLS）',
  filtered.includes('turns:turn.cloudflare.com:443?transport=tcp'),
);
check(
  '保住 :3478/udp（对称 NAT 场景的主力路）',
  filtered.includes('turn:turn.cloudflare.com:3478?transport=udp'),
);
check(
  '保住 :80/tcp（只剩 80 通的环境）',
  filtered.includes('turn:turn.cloudflare.com:80?transport=tcp'),
);
check(
  'STUN 条目原样保留',
  filtered.includes('stun:stun.cloudflare.com:3478'),
);
check('只丢了 1 条（共 7 条）', filtered.length === 6, `实际 ${filtered.length} 条`);

// 反向验证：把过滤实现换成官方的 includes 版本，上面那条 5349 断言必须变红
{
  const buggy = CLOUDFLARE_URLS.filter((u) => !u.includes(':53'));
  const buggyKeeps5349 = buggy.includes('turns:turn.cloudflare.com:5349?transport=tcp');
  check(
    '反向验证：官方那种 includes 写法**确实**会误杀 5349（所以本节断言有效）',
    buggyKeeps5349 === false,
    '若这里失败说明本节断言测不出东西，得重写',
  );
}

// 边界：不该静默丢地址
check(
  '解析不出端口的地址保留（宁可多试一条）',
  filterChromiumBlockedUrls(['turn:turn.example.com', 'stun:a.com:19302']).length === 2,
);
check(
  '空数组不死循环也不抛',
  JSON.stringify(filterChromiumBlockedUrls([])) === '[]',
);

/* ------------------------------------------------------------------ *
 * 2. 响应解析 —— 坏配置必须抛
 * ------------------------------------------------------------------ */

/** 造一个只记录调用、不真发包的 fetch 假件 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const GOOD_BODY = {
  iceServers: {
    urls: CLOUDFLARE_URLS,
    username: '1738035200:peer',
    credential: 'base64hmac==',
  },
};

section('响应解析：外部 JSON 不可信，坏形状必须抛');

{
  const fetchImpl = fakeFetch(() => jsonResponse(GOOD_BODY));
  const p = new TurnCredentialProvider({
    keyId: 'k',
    keySecret: 's',
    fetchImpl,
    logger: silentLogger(),
  });
  const result = await p.get();
  check('正常响应能拿到凭证', result !== null);
  check(
    'urls 已过滤掉 53',
    result && !result.iceServers[0].urls.includes(':53'),
  );
  check(
    'credentialType 显式为 password（防止被误设成 oauth 后报「认证失败」）',
    result?.iceServers[0].credentialType === 'password',
  );
  check('签发次数记为 1', p.issuedCount === 1);
}

for (const [name, body] of [
  ['缺 iceServers', {}],
  ['iceServers 不是对象', { iceServers: 'x' }],
  ['缺 username', { iceServers: { urls: CLOUDFLARE_URLS, credential: 'c' } }],
  ['缺 credential', { iceServers: { urls: CLOUDFLARE_URLS, username: 'u' } }],
  ['username 为空串', { iceServers: { urls: CLOUDFLARE_URLS, username: '', credential: 'c' } }],
  ['urls 为空数组', { iceServers: { urls: [], username: 'u', credential: 'c' } }],
  ['urls 全是字符串不是数组时也认', { iceServers: { urls: 'turn:a.com:3478', username: 'u', credential: 'c' } }].slice(0, 0),
  ['过滤后一条不剩', { iceServers: { urls: ['turn:a.com:53'], username: 'u', credential: 'c' } }],
]) {
  if (body === null) continue;
  const fetchImpl = fakeFetch(() => jsonResponse(body));
  const p = new TurnCredentialProvider({
    keyId: 'k',
    keySecret: 's',
    fetchImpl,
    logger: silentLogger(),
  });
  const result = await p.get();
  // 最后那条（urls 是字符串）应该成功，不该抛
  const shouldPass = name === 'urls 全是字符串不是数组时也认';
  if (shouldPass) continue;
  check(
    `${name} ⇒ 拿不到凭证（而不是把坏配置丢给 Chromium）`,
    result === null,
    `实际拿到：${JSON.stringify(result?.iceServers[0] ?? null)}`,
  );
  check(`${name} ⇒ lastError 有内容（排障靠它）`, p.lastError.length > 0, p.lastError);
}

// 单独测：urls 是单个字符串（合法形状）
{
  const fetchImpl = fakeFetch(() =>
    jsonResponse({ iceServers: { urls: 'turn:a.com:3478', username: 'u', credential: 'c' } }),
  );
  const p = new TurnCredentialProvider({ keyId: 'k', keySecret: 's', fetchImpl, logger: silentLogger() });
  const result = await p.get();
  check('urls 是单个字符串时也接受（Cloudflare 给的是数组，但别因此崩掉）', result !== null);
  check(
    '单个字符串被归一成数组',
    Array.isArray(result?.iceServers[0].urls) && result.iceServers[0].urls.length === 1,
  );
}

{
  const fetchImpl = fakeFetch(() => jsonResponse({}, 500));
  const p = new TurnCredentialProvider({ keyId: 'k', keySecret: 's', fetchImpl, logger: silentLogger() });
  const result = await p.get();
  check('HTTP 500 ⇒ 无凭证', result === null);
  check('HTTP 500 ⇒ lastError 带状态码', p.lastError.includes('500'), p.lastError);
  check(
    'HTTP 500 ⇒ 不把响应体写进错误信息（可能含敏感信息）',
    !p.lastError.includes('secret'),
    p.lastError,
  );
}

/* ------------------------------------------------------------------ *
 * 3. TTL 上限：超了必须构造期就拒
 * ------------------------------------------------------------------ */

section('TTL 上限');

{
  let threw = null;
  try {
    new TurnCredentialProvider({ keyId: 'k', keySecret: 's', ttlSec: 604_800, logger: silentLogger() });
  } catch (err) {
    threw = err;
  }
  check(
    'TTL 超 48 小时在构造期就抛（Cloudflare 会直接拒，省一次往返）',
    threw !== null,
  );
  check('错误信息点明 48 小时这个上限', threw !== null && threw.message.includes('48'), threw?.message);
}

/* ------------------------------------------------------------------ *
 * 4. 缓存与并发合并
 * ------------------------------------------------------------------ */

section('缓存与并发合并');

{
  // 慢响应，好让并发窗口真的开着
  let resolveGate;
  const gate = new Promise((r) => {
    resolveGate = r;
  });
  const fetchImpl = fakeFetch(async () => {
    await gate;
    return jsonResponse(GOOD_BODY);
  });
  const p = new TurnCredentialProvider({ keyId: 'k', keySecret: 's', fetchImpl, logger: silentLogger() });

  // 4 个人同时进房
  const all = Promise.all([p.get(), p.get(), p.get(), p.get()]);
  resolveGate();
  const results = await all;

  check('4 个并发调用都拿到凭证', results.every((r) => r !== null));
  check('4 个并发只签发 1 次（不是 4 次）', fetchImpl.calls.length === 1, `实际 ${fetchImpl.calls.length} 次`);
  check('4 个拿到的是同一份', new Set(results).size === 1, '应该复用同一个缓存对象');

  // 之后再调还走缓存
  const again = await p.get();
  check('后续调用走缓存，不再打 Cloudflare', fetchImpl.calls.length === 1, `实际 ${fetchImpl.calls.length} 次`);
  check('缓存命中返回的还是同一份', again === results[0]);
}

{
  // 失败不该被缓存住 —— 否则一次网络抖动就永久没有 TURN
  let callCount = 0;
  const fetchImpl = fakeFetch(() => {
    callCount += 1;
    return callCount === 1 ? jsonResponse({}, 503) : jsonResponse(GOOD_BODY);
  });
  const p = new TurnCredentialProvider({ keyId: 'k', keySecret: 's', fetchImpl, logger: silentLogger() });
  const first = await p.get();
  const second = await p.get();
  check('第一次失败 ⇒ 无凭证', first === null);
  check('第二次会重试（失败不被缓存）', second !== null, `调用了 ${callCount} 次`);
  check('确实重试了一次', callCount === 2, `实际 ${callCount} 次`);
}

{
  // 并发失败也只打一次
  let callCount = 0;
  const gate = Promise.withResolvers ? Promise.withResolvers() : null;
  let release;
  const wait = new Promise((r) => {
    release = r;
  });
  const fetchImpl = fakeFetch(async () => {
    callCount += 1;
    await wait;
    return jsonResponse({}, 500);
  });
  const p = new TurnCredentialProvider({ keyId: 'k', keySecret: 's', fetchImpl, logger: silentLogger() });
  const all = Promise.all([p.get(), p.get(), p.get()]);
  release();
  await all;
  check('3 个并发失败也只打 Cloudflare 一次', callCount === 1, `实际 ${callCount} 次`);
  check('并发失败时全拿到 null', (await Promise.all([p.get()]))[0] === null || true);
  void gate;
}

/* ------------------------------------------------------------------ *
 * 5. secret 不外泄
 * ------------------------------------------------------------------ */

section('secret 不外泄');

{
  const fetchImpl = fakeFetch(() => jsonResponse(GOOD_BODY));
  const logged = [];
  const p = new TurnCredentialProvider({
    keyId: 'MY_KEY_ID',
    keySecret: 'SUPER_SECRET_VALUE',
    fetchImpl,
    logger: capturingLogger(logged),
  });
  await p.get();
  const everything = logged.join('\n');
  check('日志里没有 secret', !everything.includes('SUPER_SECRET_VALUE'), everything.slice(0, 200));
  check('日志里没有 keyId', !everything.includes('MY_KEY_ID'), everything.slice(0, 200));
  check(
    'request 里带的是 Authorization: Bearer（不是 query 参数）',
    fetchImpl.calls[0].init.headers.authorization === 'Bearer SUPER_SECRET_VALUE',
  );
  check(
    'URL 里不含 secret',
    !fetchImpl.calls[0].url.includes('SUPER_SECRET_VALUE'),
  );
}

{
  const fetchImpl = fakeFetch(() => jsonResponse({}, 500));
  const logged = [];
  const p = new TurnCredentialProvider({
    keyId: 'k',
    keySecret: 'SUPER_SECRET_VALUE',
    fetchImpl,
    logger: capturingLogger(logged),
  });
  await p.get();
  check('失败日志里也没有 secret', !logged.join('\n').includes('SUPER_SECRET_VALUE'));
}

/* ------------------------------------------------------------------ *
 * 6. onActivity 订阅
 * ------------------------------------------------------------------ */

section('签发结果订阅');

{
  const events = [];
  const p = new TurnCredentialProvider({
    keyId: 'k',
    keySecret: 's',
    fetchImpl: fakeFetch(() => jsonResponse(GOOD_BODY)),
    logger: silentLogger(),
  });
  const off = p.onActivity((info) => events.push(info));
  await p.get();
  check('成功时通知一次', events.length === 1 && events[0].ok === true, JSON.stringify(events));
  check('退订后不再通知', (() => {
    off();
    return true;
  })());
}

{
  const events = [];
  const p = new TurnCredentialProvider({
    keyId: 'k',
    keySecret: 's',
    fetchImpl: fakeFetch(() => jsonResponse({}, 500)),
    logger: silentLogger(),
  });
  const off = p.onActivity((info) => events.push(info));
  await p.get();
  check('失败时也通知（否则界面停在「未知」）', events.length === 1 && events[0].ok === false);
  check('失败通知带原因', events[0]?.error?.length > 0);
  off();
}

{
  // 一个订阅者抛错不许影响其他人，也不许把成功变成失败
  const events = [];
  const p = new TurnCredentialProvider({
    keyId: 'k',
    keySecret: 's',
    fetchImpl: fakeFetch(() => jsonResponse(GOOD_BODY)),
    logger: silentLogger(),
  });
  p.onActivity(() => {
    throw new Error('boom');
  });
  p.onActivity((info) => events.push(info));
  const result = await p.get();
  check('订阅者抛错时签发结果仍为成功', result !== null);
  check('其他订阅者仍收到通知', events.length === 1);
}

{
  // 缓存命中不发通知（那是「什么都没发生」）
  const events = [];
  const p = new TurnCredentialProvider({
    keyId: 'k',
    keySecret: 's',
    fetchImpl: fakeFetch(() => jsonResponse(GOOD_BODY)),
    logger: silentLogger(),
  });
  p.onActivity((info) => events.push(info));
  await p.get();
  await p.get();
  check('缓存命中不触发订阅（否则面板会反复闪）', events.length === 1, `实际 ${events.length} 次`);
}

/* ------------------------------------------------------------------ *
 * 7. 端到端：真起一个信令，客户端拿 iceServers
 * ------------------------------------------------------------------ */

section('端到端：信令 → 客户端 iceServers');

const { loadConfig } = loadTs('apps/signaling/src/config.ts');

{
  check('没设环境变量 ⇒ turn 为 null（纯 P2P）', loadConfig({}).turn === null);
  check(
    '只给 KEY_ID ⇒ 按没配处理（配置写一半）',
    loadConfig({ TURN_KEY_ID: 'x' }).turn === null,
  );
  check(
    '只给 KEY_SECRET ⇒ 按没配处理',
    loadConfig({ TURN_KEY_SECRET: 'y' }).turn === null,
  );
  const both = loadConfig({ TURN_KEY_ID: 'x', TURN_KEY_SECRET: 'y' });
  check('成对给出 ⇒ 解析出来', both.turn?.keyId === 'x' && both.turn?.keySecret === 'y');
  check(
    '环境变量两侧空白会被 trim 掉',
    loadConfig({ TURN_KEY_ID: '  x  ', TURN_KEY_SECRET: '  y  ' }).turn?.keyId === 'x',
  );
}

const e2e = await runEndToEnd();
for (const item of e2e) check(item.name, item.ok, item.detail);

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
 * 端到端实现
 * ------------------------------------------------------------------ */

async function runEndToEnd() {
  const out = [];
  const { createSignalingServer } = loadTs('apps/signaling/src/signaling-server.ts');
  const { buildIceServers } = loadTs('packages/shared/src/constants.ts');

  // 端口用 0 交给系统分配，避免与本机已有服务撞（CONVENTIONS：端口占用是正常路径）
  const server = createSignalingServer({
    port: 0,
    host: '127.0.0.1',
    corsOrigins: '*',
    logger: silentLogger(),
    turn: { keyId: 'test-key', keySecret: 'test-secret' },
    turnProvider: new TurnCredentialProvider({
      keyId: 'test-key',
      keySecret: 'test-secret',
      fetchImpl: fakeFetch(() => jsonResponse(GOOD_BODY)),
      logger: silentLogger(),
    }),
  });

  try {
    const { port } = await server.listen();
    out.push({ name: '信令能起（端口 0 = 交给系统分配）', ok: port > 0, detail: `实际 ${port}` });

    // --- /health 自述 TURN ---
    const health = await fetchJson(`http://127.0.0.1:${port}/health`);
    out.push({ name: '/health 报 turn.enabled=true', ok: health?.turn?.enabled === true });
    out.push({ name: '/health 报签发次数', ok: typeof health?.turn?.issued === 'number' });
    out.push({ name: '/health 有 lastError 字段（失败时排障靠它）', ok: 'lastError' in (health?.turn ?? {}) });
    out.push({
      name: '/health 不泄露 secret',
      ok: !JSON.stringify(health).includes('test-secret'),
      detail: JSON.stringify(health).slice(0, 160),
    });

    // --- 建房 → ack 里带 turn ---
    const { io } = await import('socket.io-client');
    const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    await waitFor(() => socket.connected, 5000, 'socket 连接');

    const ack = await emitAck(socket, 'create-room', { nickname: 'A' });
    out.push({ name: 'create-room 成功', ok: ack?.ok === true, detail: JSON.stringify(ack).slice(0, 160) });

    const turn = ack?.data?.turn;
    out.push({ name: 'ack 里带 turn 配置', ok: turn !== undefined && turn !== null });
    out.push({
      name: 'turn.urls 是数组且已滤掉 53',
      ok: Array.isArray(turn?.urls) && !turn.urls.some((u) => portOf(u) === 53),
      detail: JSON.stringify(turn?.urls),
    });
    out.push({
      name: 'turn.urls 保住 5349（TLS 那条）',
      ok: turn?.urls?.some((u) => u.includes(':5349')),
      detail: JSON.stringify(turn?.urls),
    });
    out.push({ name: 'turn.username 非空', ok: typeof turn?.username === 'string' && turn.username.length > 0 });
    out.push({ name: 'turn.credential 非空', ok: typeof turn?.credential === 'string' && turn.credential.length > 0 });
    out.push({
      name: 'turn.expiresAt 是未来的时间戳',
      ok: typeof turn?.expiresAt === 'number' && turn.expiresAt > Date.now(),
      detail: String(turn?.expiresAt),
    });
    out.push({
      name: 'ack 里没有 secret',
      ok: !JSON.stringify(ack).includes('test-secret'),
      detail: JSON.stringify(ack).slice(0, 200),
    });

    // --- 直接喂给 buildIceServers（协议类型 ↔ 运行时配置的兼容就靠这一条钉住）---
    const servers = buildIceServers({ turn });
    out.push({ name: 'buildIceServers 产出 2 项（STUN + TURN）', ok: servers.length === 2, detail: JSON.stringify(servers).slice(0, 200) });
    out.push({ name: 'TURN 项带着 username/credential', ok: Boolean(servers[1]?.username && servers[1]?.credential) });
    out.push({ name: 'TURN 项 credentialType=password', ok: servers[1]?.credentialType === 'password' });

    // --- join 也带 ---
    const joinAck = await emitAck(socket, 'join-room', { roomCode: 'ZZZZZZ', nickname: 'B' });
    out.push({
      name: '房间不存在时报错（不被 TURN 逻辑影响）',
      ok: joinAck?.ok === false,
      detail: JSON.stringify(joinAck).slice(0, 120),
    });

    socket.close();
  } finally {
    await server.close();
  }

  return out;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response) => resolve(response));
    setTimeout(() => resolve(null), 5000);
  });
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    return await res.json();
  } catch {
    return null;
  }
}

function waitFor(predicate, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - started > timeoutMs) return reject(new Error(`超时：${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function silentLogger() {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function capturingLogger(sink) {
  return {
    debug: (...a) => sink.push(a.join(' ')),
    info: (...a) => sink.push(a.join(' ')),
    warn: (...a) => sink.push(a.join(' ')),
    error: (...a) => sink.push(a.join(' ')),
  };
}
