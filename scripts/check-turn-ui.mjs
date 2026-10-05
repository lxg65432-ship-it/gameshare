#!/usr/bin/env node
/**
 * TURN 界面化配置的验收（`npm run check:turn-ui`）。
 *
 * --- 这功能解决什么 ---
 *
 * 原来 TURN 只能从环境变量读（`TURN_KEY_ID` / `TURN_KEY_SECRET`），
 * 想用的人得开一个 PowerShell 窗口、设两个变量、再从那个窗口启动客户端。
 * 而 TURN 恰恰是**网络环境最差的那批人**才需要的（校园网 / 公司内网 / 手机流量）
 * —— 让最需要它的人做最麻烦的事，是把难度放错了地方。
 *
 * 所以做进界面：填 Cloudflare 账号 ID + 一个 Calls Write 权限的 token，
 * 程序调官方 API 建 TURN key、存本机、之后自动用同一组。
 *
 * --- 这个功能的安全判据（本验收的重点） ---
 *
 * `keySecret` 是**计费凭据**，而本项目的信令**没有鉴权** ——
 * 谁读到它，谁就能拿你的额度替别人中继。所以下面这几条是硬要求：
 *
 * 1. `turn:get` 的返回**不含 secret**，只有 key id 的前 6 位；
 * 2. 建 key 用的**账号 token 用完即弃、不落盘**（与 keySecret 处理刻意不同：
 *    keySecret 之后每次建房都要用，账号 token 建完就没用了）；
 * 3. **环境变量仍优先** —— 临时换一组凭据的路径没被堵死；
 * 4. 换凭据**必要时才重启**信令，且不擅自把服务拉起来。
 *
 * 第 1 条尤其要盯：它是「secret 会不会不小心漏到界面上」的唯一闸门，
 * 而界面一旦漏了，用户截图 / 录屏就带出去了。
 *
 * --- 为什么判据加载的是 turn-store.ts 而不是 turn-config.ts ---
 *
 * 后者 import 了 electron，而本机 `ELECTRON_RUN_AS_NODE` 是预设的 ——
 * electron 包在纯 node 下 import 就炸，判据根本跑不起来。
 * 所以判据拆成了两层：`turn-store.ts`（纯逻辑，能跑）验存储与打码；
 * 建 key 那部分用「剥掉 import 后单独 bundle」的办法验。
 *
 * 用法：
 *   node scripts/check-turn-ui.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
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

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

function loadTs(relPath) {
  const absolute = path.join(root, relPath);
  const out = path.join(root, '.cache', `check-turn-ui-${path.basename(relPath)}.cjs`);
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

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const S = loadTs('apps/desktop/electron/turn-store.ts');
const storeSrc = read('apps/desktop/electron/turn-store.ts');
const cfgSrc = read('apps/desktop/electron/turn-config.ts');
const mainSrc = read('apps/desktop/electron/main.ts');
const appSrc = read('apps/desktop/src/App.tsx');
const i18nSrc = read('apps/desktop/src/i18n.ts');
const typesSrc = read('apps/desktop/src/types/global.d.ts');
const embSrc = read('apps/desktop/electron/embedded-server.ts');

/* ------------------------------------------------------------------ *
 * 1. maskKeyId —— 界面上唯一能看到的凭据片段
 * ------------------------------------------------------------------ */

section('Key ID 打码：界面上永远看不到完整 id');

{
  check('长 id 只给前 6 位', S.maskKeyId('abcdef1234567890') === 'abcdef…', `实得 ${S.maskKeyId('abcdef1234567890')}`);
  check('短 id（≤6）原样返回', S.maskKeyId('abc') === 'abc');
  check('正好 6 位原样返回', S.maskKeyId('abcdef') === 'abcdef');
  check('7 位开始打码', S.maskKeyId('abcdefg') === 'abcdef…');
  check('打码结果里不含完整 id', !S.maskKeyId('abcdef1234567890').includes('1234567890'));
  check('空串不炸', S.maskKeyId('') === '');
}

/* ------------------------------------------------------------------ *
 * 2. 解析 —— 坏数据一律当「没配」
 * ------------------------------------------------------------------ */

section('解析：只认成对的两个字段');

{
  const good = { keyId: 'uid123', keySecret: 'secret456' };
  check('成对给出 ⇒ 解析出来', JSON.stringify(S.parsePersisted(good)) === JSON.stringify(good));

  // 半套凭据必须判「没配」—— 拿半套去签发只会得到一个必然失败的请求，
  // 而界面上分不清是「配错了」还是「网络不通」
  check('只有 keyId ⇒ null', S.parsePersisted({ keyId: 'uid123' }) === null);
  check('只有 keySecret ⇒ null', S.parsePersisted({ keySecret: 'secret456' }) === null);
  check('两个空串 ⇒ null', S.parsePersisted({ keyId: '', keySecret: '' }) === null);
  check('两个空白串 ⇒ null', S.parsePersisted({ keyId: '  ', keySecret: '  ' }) === null);
  check('null ⇒ null', S.parsePersisted(null) === null);
  check('undefined ⇒ null', S.parsePersisted(undefined) === null);
  check('字符串 ⇒ null', S.parsePersisted('uid123') === null);
  check('数组 ⇒ null', S.parsePersisted(['uid123', 'secret456']) === null);

  // 字段会 trim：复制粘贴最常见的坏法就是带上换行 / 空格
  const trimmed = S.parsePersisted({ keyId: '  uid123\n', keySecret: '\tsecret456  ' });
  check(
    '字段会 trim（复制粘贴最常见的坏法）',
    trimmed?.keyId === 'uid123' && trimmed?.keySecret === 'secret456',
    JSON.stringify(trimmed),
  );

  // 数字 / 对象冒充字符串必须被拒
  check('数字 keyId ⇒ null', S.parsePersisted({ keyId: 123, keySecret: 'x' }) === null);
  check('对象 keySecret ⇒ null', S.parsePersisted({ keyId: 'x', keySecret: {} }) === null);
}

/* ------------------------------------------------------------------ *
 * 3. 落盘往返 —— 真读写，不 mock
 * ------------------------------------------------------------------ */

section('落盘往返：真写真读');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshare-turn-'));
  const p = path.join(dir, 'nested', 'turn-credentials.json');
  const creds = { keyId: 'uid-abc', keySecret: 'secret-xyz' };

  check('存盘成功（目录不存在时会自己建）', S.saveTurnCredentialsTo(p, creds, 'acct-1') === true);
  check('读回来一致', JSON.stringify(S.loadTurnCredentialsFrom(p)) === JSON.stringify(creds));
  check('账号 id 也存下来了', S.loadTurnAccountIdFrom(p) === 'acct-1');

  // 真实文件里**不该**出现账号 token —— 它只用于建 key，建完就丢
  const onDisk = fs.readFileSync(p, 'utf8');
  check('磁盘上没有 apiToken 字段', !/apiToken|accountToken|Bearer/.test(onDisk), onDisk);

  // 覆盖写：第二次配的应该覆盖第一次的
  S.saveTurnCredentialsTo(p, { keyId: 'uid-2', keySecret: 'secret-2' }, 'acct-2');
  check('覆盖写生效', S.loadTurnCredentialsFrom(p)?.keyId === 'uid-2');
  check('账号 id 也跟着更新', S.loadTurnAccountIdFrom(p) === 'acct-2');

  // 清除
  check('清除成功', S.clearTurnCredentialsAt(p) === true);
  check('清除后读出来是 null', S.loadTurnCredentialsFrom(p) === null);
  check('清除后账号 id 是空串', S.loadTurnAccountIdFrom(p) === '');

  // 坏文件不许把程序搞崩
  fs.writeFileSync(p, '这不是 JSON{{{', 'utf8');
  check('坏 JSON ⇒ null 而不抛', S.loadTurnCredentialsFrom(p) === null);
  check('坏 JSON 下账号 id 也是空串', S.loadTurnAccountIdFrom(p) === '');

  fs.writeFileSync(p, '{"keyId":"只剩一半"}', 'utf8');
  check('半套凭据 ⇒ null', S.loadTurnCredentialsFrom(p) === null);

  check('文件不存在 ⇒ null', S.loadTurnCredentialsFrom(path.join(dir, 'nope.json')) === null);
  check('账号 id：文件不存在 ⇒ 空串', S.loadTurnAccountIdFrom(path.join(dir, 'nope.json')) === '');
}

/* ------------------------------------------------------------------ *
 * 4. 落盘内容 —— secret 存、账号 token 不存
 * ------------------------------------------------------------------ */

section('落盘：secret 存、账号 token 不存');

{
  const saveBody = storeSrc.match(/export function saveTurnCredentialsTo[\s\S]*?\n\}/)?.[0] ?? '';
  check('取到 saveTurnCredentialsTo', saveBody.length > 0);
  check('存盘写入 keySecret', /keySecret/.test(saveBody));
  check('存盘写入 keyId', /keyId/.test(saveBody));
  check(
    '**落盘函数里没有 apiToken 字段**',
    !/apiToken\s*:|accountToken\s*:/.test(saveBody),
    '账号 token 进了落盘 —— 它的权限比 keySecret 大得多',
  );
  check('catch 分支返回 false 而不是抛', /catch\s*\{\s*return false/.test(saveBody));

  // 路径必须在 userData 下，不在项目目录里
  check('凭据文件在 userData 下', /getPath\('userData'\)/.test(cfgSrc));
  check('文件名是 turn-credentials.json', /turn-credentials\.json/.test(cfgSrc));
  check('**没有**写进项目目录', !/__dirname.*turn-credentials|process\.cwd\(\).*turn/.test(cfgSrc));
}

/* ------------------------------------------------------------------ *
 * 5. **安全判据** secret 绝不外泄
 * ------------------------------------------------------------------ */

section('★ 安全：界面与日志都不许出 secret');

{
  const getBody = mainSrc.match(/ipcMain\.handle\('turn:get'[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
  check('取到 turn:get 的返回体', getBody.length > 0);

  // 核心：返回体里不能出现 keySecret / 裸 key
  check('turn:get 返回体不含 keySecret', !/keySecret/.test(getBody), '界面会拿到 secret —— 一截图就出去了');
  check('turn:get 返回体不含裸的 key 字段', !/\bkey\s*:/.test(getBody));
  check('turn:get 只回 maskKeyId(...)', /maskKeyId\(/.test(getBody));
  check('turn:get 报告 source（env / file / none）', /source:/.test(getBody));

  // 渲染层不许有「读 secret」的路径
  check('渲染层类型里没有「读 secret」的方法', !/getSecret|readSecret|loadSecret/.test(typesSrc));
  check('App 里没有 api.getSecret 这类调用', !/api\.getSecret|api\.loadSecret/.test(appSrc));

  // 一次性展示必须带警告，且用完即清
  check('一次性 secret 有醒目警告文案', /oneShotWarn/.test(i18nSrc));
  check('App 里 turnOneShotSecret 用完即清', /setTurnOneShotSecret\(''\)/.test(appSrc));

  // 建 key 的账号 token 只能是密码框，且用完即清
  check('账号 token 用 type=password 输入', /type="password"[\s\S]{0,300}turnApiToken|turnApiToken[\s\S]{0,500}type="password"/.test(appSrc));
  check('建完之后立刻清空 token', /setTurnApiToken\(''\)/.test(appSrc));
}

/* ------------------------------------------------------------------ *
 * 6. 环境变量仍优先 —— 别把临时替换的路径堵死
 * ------------------------------------------------------------------ */

section('优先级：环境变量 > 本地文件');

{
  const resolveBody = mainSrc.match(/function resolveTurnCredentials[\s\S]*?\n\}/)?.[0] ?? '';
  check('取到 resolveTurnCredentials', resolveBody.length > 0);
  check('先看环境变量', /loadConfig\(process\.env\)\.turn/.test(resolveBody));
  check('环境变量有值就直接返回', /if \(fromEnv\) return fromEnv;/.test(resolveBody));
  check('没有才读本地文件', /loadTurnCredentials\(\)/.test(resolveBody));

  // 顺序不能反：反了的话「临时用环境变量顶一下」会失效
  const envAt = resolveBody.indexOf('fromEnv');
  const fileAt = resolveBody.indexOf('loadTurnCredentials()');
  check('环境变量确实排在本地文件之前', envAt > -1 && fileAt > envAt, `env@${envAt} file@${fileAt}`);
}

/* ------------------------------------------------------------------ *
 * 7. 换凭据要重启信令 —— 且不能偷偷把服务拉起来
 * ------------------------------------------------------------------ */

section('换凭据：必要时重启，不擅自启动');

{
  const updateBody = embSrc.match(/async updateTurn[\s\S]*?\n {2}\}/)?.[0] ?? '';
  check('取到 updateTurn', updateBody.length > 0);
  check('#turn 不再是 readonly', /#turn: \{ keyId/.test(embSrc) && !/readonly #turn/.test(embSrc));
  check('只在运行中才重启', /this\.#status\.state !== 'running'/.test(updateBody));
  check('运行中 ⇒ 先停后起', /await this\.stop\(\);/.test(updateBody) && /return this\.start\(\)/.test(updateBody));
  check('没在跑时只更新不启动', /return this\.#refreshStatus\(\)/.test(updateBody));
}

/* ------------------------------------------------------------------ *
 * 8. 建 key 的失败路径 —— TURN 是兜底，不许把建房搞崩
 * ------------------------------------------------------------------ */

section('建 key：失败都带原因，且不抛');

{
  // createTurnKey 需要 fetch 但不需要 electron —— 剥掉 import 单独 bundle。
  const fnStart = cfgSrc.indexOf('export async function createTurnKey');
  const fnEnd = cfgSrc.indexOf('\n}', fnStart) + 2;
  const fnSrc = cfgSrc.slice(fnStart, fnEnd);
  check('取到 createTurnKey', fnStart > 0 && fnEnd > fnStart);

  // firstNonEmptyString 是 createTurnKey 的依赖，也在同一文件里，一起切出来。
  // 漏了它 bundle 会 ReferenceError —— 判据自己先崩，比红更难看。
  const helperStart = cfgSrc.indexOf('function firstNonEmptyString');
  const helperEnd = helperStart > 0 ? cfgSrc.indexOf('\n}', helperStart) + 2 : 0;
  check('取到 firstNonEmptyString', helperStart > 0 && helperEnd > helperStart);
  const helperSrc = helperStart > 0 ? cfgSrc.slice(helperStart, helperEnd) : '';

  const outFile = path.join(root, '.cache', 'check-turn-ui-createkey.cjs');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  esbuild.buildSync({
    stdin: {
      contents: `
        const CREATE_TIMEOUT_MS = 10_000;
        const CF_TURN_KEYS = 'https://api.cloudflare.com/client/v4';
        ${helperSrc}
        ${fnSrc.replace('export async function', 'async function')}
        module.exports = { createTurnKey, firstNonEmptyString };
      `,
      resolveDir: root,
      loader: 'ts',
    },
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const { createTurnKey, firstNonEmptyString } = require(outFile);

  // firstNonEmptyString 自身
  check('首个非空字符串胜出', firstNonEmptyString('a', 'b') === 'a');
  check('空串不算数（会跳过）', firstNonEmptyString('', '  ', 'c') === 'c');
  check('两边都不是字符串 ⇒ null', firstNonEmptyString(undefined, 123) === null);
  check('非字符串的 secret 混不过去', firstNonEmptyString(undefined, { key: 'x' }) === null);

  const empty = await createTurnKey('', '');
  check('空账号 + 空 token ⇒ ok=false', empty.ok === false);
  check('空输入带可显示原因', typeof empty.error === 'string' && empty.error.length > 0, JSON.stringify(empty.error));
  check('空输入不声称成功', empty.keyId === undefined && empty.keySecret === undefined);

  check('只有账号没 token ⇒ ok=false', (await createTurnKey('acct', '')).ok === false);
  check('只有 token 没账号 ⇒ ok=false', (await createTurnKey('', 'token')).ok === false);
  check('纯空白输入也判失败', (await createTurnKey('   ', '   ')).ok === false);

  // 真的发一次请求（必然失败，但能验「失败不抛」这条）
  const net = await createTurnKey('acct-does-not-exist', 'token-invalid');
  check('真实请求失败时也不抛（返回 ok=false）', net.ok === false);
  check('网络失败带可显示原因', typeof net.error === 'string' && net.error.length > 0, JSON.stringify(net.error));
  check('失败时不返回任何凭据', net.keyId === undefined && net.keySecret === undefined);
}

/* ------------------------------------------------------------------ *
 * 9. 建 key 响应解析 —— ★ 2026-10-05 修的真洞
 *
 * 官方文档写 `result.key`，**真实响应里叫 `result.secret`**（对真账号实测确认）。
 * 只读 key 的话，key 建成功了却报「接口形状可能变了」——
 * 这是个**把成功报成失败**的洞，比拿不到凭据还难查（用户会以为是自己 token 的问题）。
 *
 * 这里拿假 fetch 把整段跑起来，两种形状各喂一次。
 * ------------------------------------------------------------------ */

section('建 key：result.secret（实测形状）与 result.key（文档形状）都认');

{
  check('源码读了 result.secret', /result\?\.secret/.test(cfgSrc), '不读它 = 对真账号必然失败');
  check('仍兼容文档里的 result.key', /result\?\.key/.test(cfgSrc), '只留 secret 会让接口再改版时静默失败');

  const realFetch = globalThis.fetch;
  // 第 8 节的 require 绑在那个块里，这里再取一次（同一个 bundle 文件）
  const { createTurnKey: createKey } = require(
    path.join(root, '.cache', 'check-turn-ui-createkey.cjs'),
  );
  async function createWithResult(result) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result }),
    });
    try {
      return await createKey('acct', 'token');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // 真账号的**真实形状**（2026-10-05 对着真响应核过字段名与类型）。
  // ⚠️ **值是编造的，只保形状**：uid 32 位小写 hex、secret 64 位小写 hex。
   // 判据要验的是形状（secret 还是 key、字段在不在），不需要具体那串 ——
  // 而且**绝不能把真凭据写进仓库**：2026-10-05 push 时被 GitHub push protection
  // 当成 Cloudflare User API Token 拦下来（GH013）。
  // 形状的真实性由「对着真账号核过」保证，不由「值是真的」保证。
  const realShape = await createWithResult({
    uid: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    name: 'gameshare',
    secret: '1f2e3d4c5b6a79880716253443526170f9e8d7c6b5a4938271605f4e3d2c1b0a',
    created: '2026-10-05T00:14:22.943Z',
    modified: '2026-10-05T00:14:22.943Z',
  });
  check('真形状（secret）⇒ ok=true', realShape.ok === true, JSON.stringify(realShape.error));
  check('真形状取到 keyId', realShape.keyId === '0a1b2c3d4e5f60718293a4b5c6d7e8f9');
  check(
    '真形状取到 keySecret（64 位）',
    realShape.keySecret === '1f2e3d4c5b6a79880716253443526170f9e8d7c6b5a4938271605f4e3d2c1b0a',
  );

  // 文档形状也不能退化
  const docShape = await createWithResult({
    uid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    key: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  check('文档形状（key）⇒ ok=true', docShape.ok === true, JSON.stringify(docShape.error));
  check('文档形状取到 keySecret', docShape.keySecret?.startsWith('bbbb') === true);

  // 两个都在 ⇒ secret 优先（实测形状优先，别让文档形状的旧值覆盖）
  const bothShape = await createWithResult({
    uid: 'cccccccccccccccccccccccccccccccc',
    key: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    secret: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  });
  check('两个都在时 secret 优先', bothShape.keySecret?.startsWith('eeee') === true);

  // 缺 secret 也没有 key ⇒ 必须失败（不能返回半个凭据）
  const missing = await createWithResult({ uid: 'ffffffffffffffffffffffffffffffff' });
  check('只有 uid ⇒ ok=false', missing.ok === false);
  check('只有 uid 时不返回半个凭据', missing.keyId === undefined && missing.keySecret === undefined);
  check('形状不认识时报的错点名 secret', /secret/.test(missing.error ?? ''), missing.error);

  // 形状彻底变了：不能静默当成功
  const alien = await createWithResult({ id: 'x', value: 'y' });
  check('完全陌生的形状 ⇒ ok=false', alien.ok === false);
}

/* ------------------------------------------------------------------ *
 * 10. 凭据格式体检（2026-10-05 补的真盲区）
 *
 * 起因：`parsePersisted` 只认「两个字段都在且非空」，所以**任何一对非空字符串
 * 都能过**，界面也照样绿灯。实测踩到：用户把 Cloudflare **账号 API Token**
 * （`cfut_…`，53 位含下划线）填进 secret 格，界面说「已就绪」，
 * 直到真连不上才暴露成 `401 invalid bearer token` —— 症状与病因隔了一层。
 * ------------------------------------------------------------------ */

section('格式体检：确定的错（邮箱 / token 填错格）');

/**
 * 一对**形状正确**的凭据 —— 必须判成「无问题」，否则会误报把用户挡在门外。
 *
 * ⚠️ **值是编造的，只保形状**（uid 32 位小写 hex / secret 64 位小写 hex）。
 * 形状的真实性由「对着真账号核过」保证，不由「值是真的」保证。
 * 2026-10-05 教训：这里原本填的是真 uid + 真 secret，
 * push 时被 GitHub push protection 当成 Cloudflare User API Token 拦下（GH013）。
 * **判据永远不许含真凭据** —— 它会进仓库、进 CI 日志、进别人的 clone。
 */
const GOOD = {
  keyId: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
  keySecret: '1f2e3d4c5b6a79880716253443526170f9e8d7c6b5a4938271605f4e3d2c1b0a',
};

/**
 * 「填错格」那一对的**形状**（keyId 对、keySecret 是 Cloudflare 账号 token）。
 * 同样只用形状：token 那串是编的，但前缀与字符集要像（`cfut_` + 混合大小写）。
 */
const WRONG_SHAPE = {
  keyId: GOOD.keyId,
  keySecret: 'cfut_EXAMPLEnotARealTokenAbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
};

{
  const good = GOOD;
  check('形状正确的凭据 ⇒ 零问题', S.inspectTurnFormat(good).length === 0, JSON.stringify(S.inspectTurnFormat(good)));
  check('形状正确的凭据 ⇒ 无硬错', S.hasHardFormatIssue(S.inspectTurnFormat(good)) === false);

  // 填错格的那一类（原本绿灯通过）
  const wrongSecret = WRONG_SHAPE;
  const wIssues = S.inspectTurnFormat(wrongSecret);
  check('把账号 token 填进 secret ⇒ 抓到 1 条', wIssues.length === 1, JSON.stringify(wIssues));
  check('  且指明是 keySecret 那一格', wIssues[0]?.field === 'keySecret');
  check('  且是硬错（红灯，不是黄灯）', S.hasHardFormatIssue(wIssues) === true);
  check(
    '  且消息点出「API Token ≠ TURN key secret」',
    /API Token/.test(wIssues[0]?.message ?? '') && /secret/.test(wIssues[0]?.message ?? ''),
    wIssues[0]?.message,
  );
  check(
    '  消息里不含用户填的原值（不能泄进界面/日志）',
    !String(wIssues[0]?.message).includes('cfut_EXAMPLEnotAReal'),
  );

  // 账号 ID 填成登录邮箱：症状最迷惑（404 而不是 401），单独点出来
  const mailId = { keyId: 'lxg65432@gmail.com', keySecret: good.keySecret };
  const mIssues = S.inspectTurnFormat(mailId);
  check('keyId 填邮箱 ⇒ 抓到 1 条', mIssues.length === 1, JSON.stringify(mIssues));
  check('  指明是 keyId 那一格', mIssues[0]?.field === 'keyId');
  check('  是硬错', S.hasHardFormatIssue(mIssues) === true);
  check(
    '  消息点出「邮箱」并给出正确来源（控制台网址那串）',
    /邮箱/.test(mIssues[0]?.message ?? '') && /dash\.cloudflare\.com/.test(mIssues[0]?.message ?? ''),
    mIssues[0]?.message,
  );
}

section('格式体检：可疑的错只黄不红（不许误报挡人）');

{
  const good = GOOD;
  // 长度不对但「看起来像」某种串 —— 只能 suspect。
  // 理由：Cloudflare 若改了格式我们会误报，误报会让用户不敢用真凭据。
  const shortSecret = { keyId: good.keyId, keySecret: 'deadbeef' };
  const sIssues = S.inspectTurnFormat(shortSecret);
  check('secret 太短 ⇒ 抓到 1 条', sIssues.length === 1, JSON.stringify(sIssues));
  check('  但只是 suspect（黄灯）', sIssues[0]?.suspect === true);
  check('  hasHardFormatIssue 为 false（放行）', S.hasHardFormatIssue(sIssues) === false);

  const oddId = { keyId: 'NOT-HEX-AT-ALL', keySecret: good.keySecret };
  const oIssues = S.inspectTurnFormat(oddId);
  check('keyId 非十六进制 ⇒ suspect 而非硬错', oIssues[0]?.suspect === true);
  check('  不含 @ 所以不是邮箱那类', !/@/.test(oIssues[0]?.message ?? ''));

  // 两格都错 ⇒ 两条都报，别只报第一个（用户要一次改完）
  const bothWrong = S.inspectTurnFormat({ keyId: 'a@b.com', keySecret: 'short' });
  check('两格都错 ⇒ 两条都报', bothWrong.length === 2, JSON.stringify(bothWrong.map((i) => i.field)));
  check('  两个 field 各一个', new Set(bothWrong.map((i) => i.field)).size === 2);

  // 没配 ⇒ 零问题（不是「有问题」）
  check('null ⇒ 零问题', S.inspectTurnFormat(null).length === 0);

  // 大写十六进制：Cloudflare 给的是小写，但不该因此报成错
  const upper = S.inspectTurnFormat({
    keyId: good.keyId.toUpperCase(),
    keySecret: good.keySecret.toUpperCase(),
  });
  check('大写十六进制不算错（宽容）', S.hasHardFormatIssue(upper) === false, JSON.stringify(upper));
}

section('★ 绿灯必须被格式问题压掉：绿灯 + 废凭据是这个盲区的本体');

{
  // 界面上的判定：`formatHard` 存在时状态灯不许再显示 ok。
  // 这条是静态断言，但它守的正是「界面怎么用这两个字段」。
  check('App 读了 formatIssues', /turnUi\?\.formatIssues/.test(appSrc));
  check('App 读了 formatHard', /turnUi\?\.formatHard\s*===\s*true/.test(appSrc));
  check(
    '状态灯把 formatHard 排在 turnState 之前（红灯压绿灯）',
    /turnFormatHard\s*\r?\n\s*\?\s*'warn'[\s\S]{0,160}turnState === 'ready'/.test(appSrc),
    '顺序反了绿灯会赢，而 formatHard 恰恰是更确定的信息',
  );
  check('formatHard 时用「凭据格式不对」这个状态名', /turn\.stateBadFormat/.test(appSrc));
  check('i18n zh 里有 turn.stateBadFormat', /'turn\.stateBadFormat':\s*'凭据格式不对'/.test(i18nSrc));
  check(
    'i18n en 里有 turn.stateBadFormat',
    /'turn\.stateBadFormat':\s*'credential format is wrong'/.test(i18nSrc),
  );

  // turn:get / turn:save 两处都要用同一个判据，否则两处说法会打架
  check('main.ts 的 turn:get 调了 inspectTurnFormat', /inspectTurnFormat\(creds\)/.test(mainSrc));
  check(
    'main.ts 的 turn:save 也调了它（存盘前拒）',
    /inspectTurnFormat\(\{ keyId: id, keySecret: secret \}\)/.test(mainSrc),
  );
  check(
    'turn:save 先体检再存盘（顺序不能反）',
    mainSrc.indexOf('inspectTurnFormat') < mainSrc.indexOf('saveTurnCredentials({ keyId: id'),
  );

  // 安全：formatIssues 只带 message，不带原值
  const getBody = mainSrc.match(/ipcMain\.handle\('turn:get'[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
  check('取到了 turn:get 的返回体', getBody.length > 0);
  check('turn:get 回报 formatIssues', /formatIssues,/.test(getBody));
  check('turn:get 回报 formatHard', /formatHard: hasHardFormatIssue/.test(getBody));
  check(
    'turn:get **不把凭据原值塞进 formatIssues**',
    !/formatIssues:\s*creds\b/.test(getBody),
  );
  check(
    'TurnFormatIssue 只有 field / message / suspect 三个字段',
    (() => {
      const m = /interface TurnFormatIssue \{([\s\S]*?)\n\}/.exec(storeSrc);
      if (!m) return false;
      const fields = [...m[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]);
      return (
        fields.length === 3 &&
        fields.includes('field') &&
        fields.includes('message') &&
        fields.includes('suspect')
      );
    })(),
  );
}

section('★ 文案不许再把 TURN key 的 secret 叫「API Token」');

{
  // 2026-10-05 踩坑的根源：原文写「API Token（TURN key 的 secret）」，
  // 用户据此把**账号 token** 填进了 secret 格。文案本身就是病因的一部分。
  check(
    'zh 的 secret 占位符不再出现「API Token」',
    !/'turn\.keySecretPlaceholder':\s*'[^']*API Token/.test(i18nSrc),
  );
  check(
    'en 的 secret 占位符不再出现「API token」',
    !/'turn\.keySecretPlaceholder':\s*'[^']*API token/i.test(i18nSrc),
  );
  check(
    'zh 的占位符点明位数（64 位十六进制）',
    /'turn\.keySecretPlaceholder':\s*'[^']*64 位十六进制/.test(i18nSrc),
  );
  check(
    'en 的占位符点明位数（64 hex chars）',
    /'turn\.keySecretPlaceholder':\s*'[^']*64 hex chars/.test(i18nSrc),
  );
  check(
    'zh 的 Key ID 占位符点明位数',
    /'turn\.keyIdPlaceholder':\s*'[^']*32 位十六进制/.test(i18nSrc),
  );
  check(
    'zh 的账号 ID 提示给出正确取法（控制台网址那串）',
    /'turn\.accountIdTitle':[\s\S]{0,140}dash\.cloudflare\.com/.test(i18nSrc),
  );
  check(
    '两个 token 位置的措辞区分开了（账号 token vs key secret）',
    /'turn\.apiTokenPlaceholder':\s*'API Token（需 Calls Write 权限）'/.test(i18nSrc) &&
      /'turn\.keySecretPlaceholder':\s*'TURN Key Secret/.test(i18nSrc),
  );
  check(
    'zh 的手工填开关不再混称',
    /'turn\.manualToggle':\s*'[^']*TURN key/.test(i18nSrc) &&
      !/'turn\.manualToggle':\s*'[^']*API [Tt]oken/.test(i18nSrc),
  );
  check(
    'en 的手工填开关不再混称',
    /'turn\.manualToggle':\s*'[^']*TURN key/.test(i18nSrc) &&
      !/'turn\.manualToggle':\s*'[^']*API token/i.test(i18nSrc),
  );
}

section('★ 判据自己不许含真凭据（2026-10-05 push 被 GH013 拦过）');

{
  // 这条是**元判据**：它守的是判据自己。
  //
  // 起因：2026-10-05 我把真 uid + 真 keySecret 写进了本文件当「真形状」样本，
  // push 时 GitHub push protection 判定为 Cloudflare User API Token 并拒绝（GH013）。
  // 后果不只是「推不上去」——**凭据进了 git 历史就等于公开了**（GitHub 会把它索引进
  // Secret Scanning，即使后来删掉提交也已在对象库里）。
  //
  // 所以判据里只许出现**形状**：32 位小写 hex / 64 位小写 hex / 带 `cfut_` 前缀的串。
  // 形状的真实性靠「对着真账号核过」，不靠「值是真的」。
  const selfSrc = read('scripts/check-turn-ui.mjs');

  check('取到了本文件自己的源码', selfSrc.length > 0);

  // 判据里出现的 32/64 位 hex 串必须是「明显的假值」——
  // 真的那种是随机的，没法用模式区分，所以退一步查两个具体特征：
  // ①不得出现 Cloudflare API Token 的真实前缀 + 长随机尾巴
  const cfTokens = selfSrc.match(/cfut_[A-Za-z0-9_-]{20,}/g) ?? [];
  check(
    '判据里没有真实的 Cloudflare token（只有带 EXAMPLE 标记的假值）',
    cfTokens.every((t) => /EXAMPLE|example/.test(t)),
    cfTokens.filter((t) => !/EXAMPLE|example/.test(t)).join(' '),
  );

  // ② 长 hex 串（>=32 位）必须带注释说明是编造的；本文件的约定是集中两个常量
  check('凭据样本集中成 GOOD / WRONG_SHAPE 两个常量', /const GOOD = \{/.test(selfSrc) && /const WRONG_SHAPE = \{/.test(selfSrc));
  check('GOOD 上方有「值是编造的」警告', /值是编造的，只保形状/.test(selfSrc));

  // ③ **两个字段都要查**，且查的是「可读递增序列」这个真特征。
  //    ⚠️ 第一版只查了 keyId ⇒ keySecret 换成随机值也不红，那是**恒真的一半**。
  //    真凭据是随机的，编造值可以刻意做成递增/带标记 —— 两者一眼能分。
  const goodBlock = /const GOOD = \{[\s\S]*?\n\};/.exec(selfSrc)?.[0] ?? '';
  const goodKeyId = /keyId: '([0-9a-f]+)'/.exec(goodBlock)?.[1] ?? '';
  const goodSecret = /keySecret: '([0-9a-f]+)'/.exec(goodBlock)?.[1] ?? '';

  check('取到了 GOOD 块', goodBlock.length > 0);
  check('GOOD.keyId 恰为 32 位', goodKeyId.length === 32, String(goodKeyId.length));
  check('GOOD.keySecret 恰为 64 位', goodSecret.length === 64, String(goodSecret.length));
  check(
    'GOOD 两个字段都是假值（递增序列，不是随机）',
    goodKeyId === '0a1b2c3d4e5f60718293a4b5c6d7e8f9' &&
      goodSecret === '1f2e3d4c5b6a79880716253443526170f9e8d7c6b5a4938271605f4e3d2c1b0a',
    `keyId=${goodKeyId.slice(0, 8)}… secret=${goodSecret.slice(0, 8)}…`,
  );
  check(
    'GOOD.keyId 是可读递增序列（说明是编的）',
    /keyId: '0a1b2c3d4e5f/.test(selfSrc),
    '真 uid 是随机的，不会是递增序列',
  );
  check(
    'GOOD.keySecret 是可读递增序列（说明是编的）',
    /keySecret: '1f2e3d4c5b6a7988/.test(selfSrc),
    '真 secret 是随机的，不会是递增序列',
  );
  check('WRONG_SHAPE 的 token 带 EXAMPLE 标记', /cfut_EXAMPLE/.test(selfSrc));
}

console.log(`\n${'═'.repeat(58)}`);
if (failures.length === 0) {
  console.log(`  ✓ 全部 ${total} 项通过`);
} else {
  console.log(`  ✗ ${failures.length}/${total} 项未通过：`);
  for (const f of failures) {
    console.log(`      · ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
  }
}
console.log('═'.repeat(58));
process.exit(failures.length === 0 ? 0 : 1);
