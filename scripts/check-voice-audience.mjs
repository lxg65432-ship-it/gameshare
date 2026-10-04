#!/usr/bin/env node
/**
 * 浮窗语音盲区的验收（`npm run check:voice-audience`）。
 *
 * --- 这个 bug 是什么 ---
 *
 * 浮窗只摆**正在共享**的那几格（`floatPeers` 按 `remoteSharing` 过滤），
 * 而**语音轨与共享是解耦的**（`stopShare` 明确只摘 video + appAudio，不摘 voice）。
 *
 * 两件事本来无关，但 `<audio>` 元素当时**挂在 tile 里**，
 * 于是「能不能听见」被绑死在「格子在不在」上：
 * **开着麦但没共享画面的人，在浮窗里完全听不见。**
 *
 * 常规模式一直没暴露这个问题：那里按成员列表渲染全部格子，不看 `remoteSharing`。
 * 浮窗是唯一会过滤的分支 —— 也就是说，**只有浮窗用户会中招**，
 * 而浮窗的定位恰恰是「边打游戏边听队友」。
 *
 * --- 为什么判据是纯函数 ---
 *
 * 这个 bug 的形态是**位置错了**：播放器被放进了会过滤的分支里。
 * 静态断言抓不到（`<audio>` 字面量一直都在源码里），
 * 而渲染测试要拖 React + DOM，太重。
 *
 * 所以把「谁该被听见」从 JSX 的隐含逻辑提成纯函数
 * （`packages/shared/src/voice-audience.ts`），能独立穷举各种组合。
 *
 * --- 断言的正确形式 ---
 *
 * 核心断言是**「在不在共享」不影响「该不该出声」** ——
 * 用同一个 peerId、只翻转 `sharing` 字段，期望值必须不变。
 * 这条红了就说明 `sharing` 混进了判据，也就是那个 bug 原样回来。
 *
 * 用法：
 *   node scripts/check-voice-audience.mjs
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

function loadTs(relPath) {
  const esbuild = require('esbuild');
  const absolute = path.join(root, relPath);
  const out = path.join(root, '.cache', `check-voice-audience-${path.basename(relPath)}.cjs`);
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

const R = loadTs('packages/shared/src/voice-audience.ts');

/* ------------------------------------------------------------------ *
 * 1. hasRemoteAudio —— 判据本体
 * ------------------------------------------------------------------ */

section('判据：手上有没有音轨');

{
  check('有 voice ⇒ 出声', R.hasRemoteAudio({ peerId: 'a', sharing: false, tracks: { voice: {} } }) === true);
  check('有 appAudio ⇒ 出声', R.hasRemoteAudio({ peerId: 'a', sharing: false, tracks: { appAudio: {} } }) === true);
  check('两条都有 ⇒ 出声', R.hasRemoteAudio({ peerId: 'a', sharing: true, tracks: { voice: {}, appAudio: {} } }) === true);
  check('两条都没有 ⇒ 不出声', R.hasRemoteAudio({ peerId: 'a', sharing: true, tracks: {} }) === false);
  check('tracks 为 null ⇒ 不出声', R.hasRemoteAudio({ peerId: 'a', sharing: true, tracks: null }) === false);
  check('tracks 为 undefined ⇒ 不出声', R.hasRemoteAudio({ peerId: 'a', sharing: false, tracks: undefined }) === false);
}

/* ------------------------------------------------------------------ *
 * 2. **核心** sharing 不得影响判据
 * ------------------------------------------------------------------ */

section('★ 核心：在不在共享，不影响该不该出声');

{
  // 这一组是整个验收存在的理由。四条断言是同一个不变量的四个面：
  // 同一个 peerId、同样的音轨，只翻转 sharing，结论必须完全一致。
  const withVoiceSharing = R.hasRemoteAudio({ peerId: 'b', sharing: true, tracks: { voice: {} } });
  const withVoiceNotSharing = R.hasRemoteAudio({ peerId: 'b', sharing: false, tracks: { voice: {} } });
  check('有 voice 时：sharing=true ⇒ 出声', withVoiceSharing === true);
  check('有 voice 时：sharing=false ⇒ 同样出声', withVoiceNotSharing === true);
  check(
    '**开着麦但没共享画面 ⇒ 仍然出声**（这就是那个 bug 的判据）',
    withVoiceNotSharing === true,
    '返回 false 说明 sharing 混进了判据 —— 开麦但没共享的人会被静音',
  );

  const withAppSharing = R.hasRemoteAudio({ peerId: 'b', sharing: true, tracks: { appAudio: {} } });
  const withAppNotSharing = R.hasRemoteAudio({ peerId: 'b', sharing: false, tracks: { appAudio: {} } });
  check('有 appAudio 时：sharing=true ⇒ 出声', withAppSharing === true);
  check('有 appAudio 时：sharing=false ⇒ 同样出声', withAppNotSharing === true);

  // 反面：没有音轨时，两种 sharing 都必须不出声。
  // 少了这条的话，「恒真」的判据也能全绿。
  check('无音轨时：sharing=true ⇒ 不出声', R.hasRemoteAudio({ peerId: 'b', sharing: true, tracks: {} }) === false);
  check('无音轨时：sharing=false ⇒ 不出声', R.hasRemoteAudio({ peerId: 'b', sharing: false, tracks: {} }) === false);
}

/* ------------------------------------------------------------------ *
 * 3. remoteAudioAudience —— 渲染名单
 * ------------------------------------------------------------------ */

section('渲染名单：该给谁放');

{
  const roster = [
    // 开着麦但**没在共享** —— 浮窗里没有他的格子，但必须出声
    { peerId: 'p1', sharing: false, tracks: { voice: {} } },
    // 在共享、也有声音
    { peerId: 'p2', sharing: true, tracks: { voice: {}, appAudio: {} } },
    // 在共享但一条轨都没有（刚进房，ontrack 还没到）
    { peerId: 'p3', sharing: true, tracks: {} },
    // 不在共享也没轨 —— 该排除
    { peerId: 'p4', sharing: false, tracks: null },
  ];

  check(
    '名单 = p1 + p2（没共享但开麦的 p1 **在**名单里）',
    JSON.stringify(R.remoteAudioAudience(roster, 'me')) === JSON.stringify(['p1', 'p2']),
    `实得 ${JSON.stringify(R.remoteAudioAudience(roster, 'me'))}`,
  );

  check('自己被排除', R.remoteAudioAudience([{ peerId: 'me', sharing: false, tracks: { voice: {} } }], 'me').length === 0);
  check('空名单 ⇒ 空结果', R.remoteAudioAudience([], 'me').length === 0);
  check('全员无音轨 ⇒ 空结果', R.remoteAudioAudience(roster.map((r) => ({ ...r, tracks: null })), 'me').length === 0);

  // 顺序必须稳定：顺序变了会牵动 React 的 DOM 复用（元素重建 ⇒ 声音中断）
  const twice = R.remoteAudioAudience(roster, 'me');
  check('两次调用结果一致（顺序稳定）', JSON.stringify(twice) === JSON.stringify(R.remoteAudioAudience(roster, 'me')));
}

/* ------------------------------------------------------------------ *
 * 4. **反向验证** 把 sharing 掺回判据，这些断言必须红
 * ------------------------------------------------------------------ */

section('★ 反向验证：判据掺入 sharing 就会红');

{
  const src = fs.readFileSync(path.join(root, 'packages/shared/src/voice-audience.ts'), 'utf8');
  // 取出 hasRemoteAudio 的函数体，看它有没有碰 sharing / remoteSharing。
  const bodyMatch = src.match(/export function hasRemoteAudio\([\s\S]*?\n\}/);
  const body = bodyMatch ? bodyMatch[0] : '';
  check('取到 hasRemoteAudio 的函数体', body.length > 0);
  check('判据体内不出现 sharing', !/sharing/i.test(body), '判据里出现了 sharing —— 这就是那个 bug');
  check(
    '判据只依据 tracks',
    /tracks/.test(body),
    '判据没碰 tracks —— 那它凭什么判断有没有声音',
  );

  // 判据文件整体不该出现「按共享过滤」的措辞残留
  check('判据文件没有「按共享过滤」的措辞', !/浮窗.*过滤|只摆.*共享的/.test(src.replace(/^\s*\*.*$/gm, '')));
}

/* ------------------------------------------------------------------ *
 * 5. 播放器不在 tile 里 —— 结构位置
 * ------------------------------------------------------------------ */

section('播放器位置：不在 tile 内，在 App 顶层');

{
  const src = fs.readFileSync(path.join(root, 'apps/desktop/src/App.tsx'), 'utf8');

  // VideoTile 内部不得再出现 <audio>：它一旦回到 tile 里，浮窗过滤就又会吃掉声音。
  //
  // ⚠️ **必须剥掉注释再数**。这个组件里本来就留着一段讲「为什么搬走」的说明，
  // 注释里有 `<audio>` 字面量；而「数个数」也抓不到真元素 ——
  // `<audio` 出现在 `RemoteAudioPair` 的 JSX 里和出现在注释里，字符完全一样。
  // 所以判据是：**剥掉所有注释之后，VideoTile 内不得再有 `<audio`**。
  const tileStart = src.indexOf('function VideoTile(');
  const outletStart = src.indexOf('function RemoteAudioOutlet(');
  check('取到 VideoTile 与 RemoteAudioOutlet 的位置', tileStart > 0 && outletStart > tileStart);

  /** 去掉块注释与行注释，只留真代码 */
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const tileBody = src.slice(tileStart, outletStart);
  const tileAudioRefs = (stripComments(tileBody).match(/<audio/g) ?? []).length;
  check(
    'VideoTile 内不再有 <audio> 元素（已剥注释）',
    tileAudioRefs === 0,
    `仍有 ${tileAudioRefs} 处 —— 播放器被搬回 tile 了，浮窗会再次吃掉未共享者的声音`,
  );

  // 反过来自查一次：证明「剥注释」这一步真的在干活 ——
  // 不剥的话 VideoTile 里明明有 4 处 <audio 字面量（讲「为什么搬走」的那段说明），
  // 剥完必须是 0。**这条必须是「大于 0」而不是「大于等于 0」** ——
  // 写成恒真断言就等于没写：判据自己出问题时它不会红。
  const rawCount = (tileBody.match(/<audio/g) ?? []).length;
  const stripCount = (stripComments(tileBody).match(/<audio/g) ?? []).length;
  check(
    '剥注释这一步真的在干活（剥前有字面量、剥后没有）',
    rawCount > 0 && stripCount === 0,
    `剥前 ${rawCount} 处 / 剥后 ${stripCount} 处`,
  );

  const outletBody = src.slice(outletStart);
  check(
    'RemoteAudioOutlet 里有 <audio> 元素（已剥注释）',
    (stripComments(outletBody).match(/<audio/g) ?? []).length >= 2,
  );

  // 顶层挂载点必须在所有分支之外 —— 放进任何条件分支里就等于又绑回过滤条件
  check(
    'RemoteAudioOutlet 挂在 App 最外层（与 header 同级、在分支之外）',
    /<RemoteAudioOutlet[\s\S]{0,400}?\/>\s*\n\s*<header/.test(src),
    '挂载点不在 header 之前 —— 它可能被某个条件分支接走了',
  );

  check('用上了纯函数判据', /remoteAudioAudience\(/.test(src), 'App 里没有调用 remoteAudioAudience —— 判据成了死代码');
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
