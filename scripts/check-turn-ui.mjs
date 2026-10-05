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

  // 真账号的真实形状（2026-10-05 实录）
  const realShape = await createWithResult({
    uid: '3df8dff194a60647e0904415a1cdcf06',
    name: 'gameshare',
    secret: 'fde7feea1110c2c0151a5220562a3c9e5aa5773659529c70a44caefa3593f5f2',
    created: '2026-10-05T00:14:22.943Z',
    modified: '2026-10-05T00:14:22.943Z',
  });
  check('真形状（secret）⇒ ok=true', realShape.ok === true, JSON.stringify(realShape.error));
  check('真形状取到 keyId', realShape.keyId === '3df8dff194a60647e0904415a1cdcf06');
  check(
    '真形状取到 keySecret（64 位）',
    realShape.keySecret === 'fde7feea1110c2c0151a5220562a3c9e5aa5773659529c70a44caefa3593f5f2',
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
