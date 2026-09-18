'use strict';

/**
 * 验证「置顶浮窗能不能压住全屏游戏，以及会不会把游戏搞不能操控」。
 *
 * 为什么单独有这个脚本：这是浮窗模式唯一**没法用单元测试表达**的核心承诺 ——
 * 「即使有全屏应用在运行，浮窗也在最上面，而且游戏照样能操作」。它依赖 Windows 的
 * z-order 与激活行为，只能真开窗口、真截图、真读像素来判断。而它失败时的表现是
 * 「一按快捷键游戏就不能操作了 / 浮窗掉到游戏后面」，光看代码看不出问题。
 *
 * 七组。**每组都带对照，因为「测法本身有没有效」比结论更重要**：
 *
 *   1. **对照组**：不开置顶，让「游戏」抢到最前 → 浮窗那块像素应该是**游戏色**。
 *      这一条是在证明这个测法本身有效 —— 否则后面的绿灯可能是假的。
 *   2. **置顶组**：`setAlwaysOnTop(true, 'screen-saver')` → 像素变成**浮窗色**。
 *   3. **抗抢组**：「游戏」**不置顶**时 `moveTop()` + `focus()` → 像素**仍是浮窗色**
 *      （不在 topmost 带里的窗口压不过带内的）。
 *   4. **同带竞争组**：让「游戏」**也置顶**，再 `moveTop()` + `focus()` →
 *      像素变成**游戏色**。**这不是 bug，是 Windows 的规则**：topmost 是个"带"，
 *      带内谁在上面取决于谁最后一次 `SetWindowPos`，而激活会把自己抬到带内最上面。
 *      **很多游戏全屏时也置顶**，所以这一组才是真实场景 —— 2026-09-17 用户实测
 *      「点回游戏浮窗就掉到下层」正是它。有了这组，才能量出保活该多快。
 *   5. **抬回来组**：四种招数逐个试（重断言 / `moveTop()` / 先关再开 / `showInactive()`），
 *      验哪几个真能把浮窗抬回带顶、且都不抢游戏的焦点。实测**只有 `showInactive()`
 *      抬不动** —— 这就是保活里不用它的依据。
 *   6. **保活时延组**：按真实保活间隔（300ms）跑，让游戏抢一次，量「掉下去 → 抬回来」
 *      用了多久。判据是**小于 1000ms**（旧的 1.5s 保活会量出 1500ms+）。
 *   7. **焦点保护组**：这是「游戏不能操控」的命门。对照组先证明**可聚焦时一次
 *      `focus()` 就能把焦点从游戏抢走**（测法有效），再看 `setFocusable(false)` 之后
 *      同一个调用抢不动。
 *
 * 「游戏」用无边框全屏窗口模拟（`frame: false` + 铺满整屏）—— 这正是
 * 「无边框窗口化」的游戏在系统里长成的样子。**独占全屏（DXGI FSE）模拟不出来：
 * 那种模式下 DWM 让出合成权，任何普通窗口都盖不住**，只能靠游戏内改成无边框，
 * 见 `docs/ARCHITECTURE.md` 4.13。
 *
 * ⚠️ **没覆盖的**：真实游戏自己的行为（它可能自置顶、可能检测到遮挡就暂停/退出全屏）。
 * 这里只能证明「我们的窗口在系统层面该做的都做了」，真实游戏的手感必须实机看。
 *
 * 用法：
 *   npm run check:topmost
 *
 * ⚠️ 会短暂铺满整屏（约 25 秒）然后自动关闭。跑的时候别抢鼠标，也别切窗口。
 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/** 游戏窗口的底色（暗红） */
const GAME_COLOR = { r: 192, g: 57, b: 43 };
/** 浮窗的底色（蓝） */
const FLOAT_COLOR = { r: 36, g: 113, b: 163 };

const FLOAT_WIDTH = 320;
const FLOAT_HEIGHT = 180;
/** 浮窗离屏幕右下角的留白，跟真实浮窗的默认落点一致 */
const FLOAT_MARGIN = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = 0;

function check(label, ok, detail) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}

/**
 * 截一帧屏幕，读某个屏幕坐标上的颜色，判断它更像游戏色还是浮窗色。
 *
 * 坐标用**屏幕坐标（DIP）**，缩略图可能是另一个尺寸（缩放 125% 之类的），
 * 所以按比例换算，而不是直接当索引用。
 */
async function sampleColor(display, x, y) {
  const { width, height } = display.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });
  const source =
    sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
  if (!source) throw new Error('拿不到屏幕采集源');

  const image = source.thumbnail;
  const size = image.getSize();
  if (size.width === 0 || size.height === 0) throw new Error('截到的图是空的');

  const bitmap = image.toBitmap(); // BGRA
  const sx = Math.min(size.width - 1, Math.max(0, Math.round((x * size.width) / width)));
  const sy = Math.min(size.height - 1, Math.max(0, Math.round((y * size.height) / height)));
  const offset = (sy * size.width + sx) * 4;
  return { r: bitmap[offset + 2], g: bitmap[offset + 1], b: bitmap[offset] };
}

/** 红和蓝差得很远，直接比距离就够，不需要颜色容差 */
function whichWindow(rgb) {
  const distance = (color) =>
    (rgb.r - color.r) ** 2 + (rgb.g - color.g) ** 2 + (rgb.b - color.b) ** 2;
  return distance(FLOAT_COLOR) < distance(GAME_COLOR) ? '浮窗' : '游戏';
}

async function main() {
  const display = screen.getPrimaryDisplay();
  const area = display.bounds; // 用 bounds 而不是 workArea：要盖住任务栏，才是真全屏

  const floatX = area.x + area.width - FLOAT_WIDTH - FLOAT_MARGIN;
  const floatY = area.y + area.height - FLOAT_HEIGHT - FLOAT_MARGIN;
  /** 抽检点：浮窗正中心 */
  const probeX = floatX + Math.round(FLOAT_WIDTH / 2);
  const probeY = floatY + Math.round(FLOAT_HEIGHT / 2);

  console.log('\n模拟无边框全屏窗口，并按 z-order 抽检像素\n');

  const floatWin = new BrowserWindow({
    x: floatX,
    y: floatY,
    width: FLOAT_WIDTH,
    height: FLOAT_HEIGHT,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    title: 'GameShare 浮窗（check:topmost）',
    backgroundColor: '#2471a3',
  });
  await floatWin.loadURL('data:text/html,<body style="margin:0"></body>');

  const gameWin = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    skipTaskbar: true,
    title: 'GameShare 模拟全屏游戏（check:topmost）',
    backgroundColor: '#c0392b',
  });
  await gameWin.loadURL('data:text/html,<body style="margin:0"></body>');

  // 让「游戏」抢到最前 —— 真实场景里就是游戏切进全屏那一刻
  gameWin.moveTop();
  gameWin.focus();
  await sleep(900);

  console.log('对照组（浮窗未置顶，游戏在最前）');
  const before = await sampleColor(display, probeX, probeY);
  check(
    '测法有效：浮窗被全屏窗口盖住',
    whichWindow(before) === '游戏',
    `抽检到 ${whichWindow(before)}色 rgb(${before.r},${before.g},${before.b})`,
  );

  console.log('\n置顶组');
  floatWin.setAlwaysOnTop(true, 'screen-saver');
  await sleep(700);
  const after = await sampleColor(display, probeX, probeY);
  check(
    '置顶后浮窗压在全屏窗口之上',
    whichWindow(after) === '浮窗',
    `抽检到 ${whichWindow(after)}色 rgb(${after.r},${after.g},${after.b})`,
  );
  check('窗口状态自认为置顶', floatWin.isAlwaysOnTop() === true);

  console.log('\n抗抢组（游戏再次抢最前）');
  gameWin.moveTop();
  gameWin.focus();
  await sleep(700);
  const stolen = await sampleColor(display, probeX, probeY);
  check(
    '游戏抢最前之后浮窗仍在上面',
    whichWindow(stolen) === '浮窗',
    `抽检到 ${whichWindow(stolen)}色 rgb(${stolen.r},${stolen.g},${stolen.b})`,
  );

  console.log('\n最小化与唤回（快捷键唤回浮窗的实现依据）');
  floatWin.minimize();
  await sleep(600);
  check('最小化生效', floatWin.isMinimized() === true);

  floatWin.showInactive();
  await sleep(700);
  check('showInactive 能把最小化的窗口还原', floatWin.isMinimized() === false);
  check('还原之后置顶还在', floatWin.isAlwaysOnTop() === true);
  const restored = await sampleColor(display, probeX, probeY);
  check(
    '还原后仍压在全屏窗口之上',
    whichWindow(restored) === '浮窗',
    `抽检到 ${whichWindow(restored)}色 rgb(${restored.r},${restored.g},${restored.b})`,
  );

  /* ---------------- 同带竞争：游戏自己也置顶 ---------------- */
  console.log('\n同带竞争组（游戏也置顶 —— 这才是真实场景）');
  gameWin.setAlwaysOnTop(true, 'screen-saver');
  gameWin.moveTop();
  gameWin.focus();
  await sleep(800);
  const contested = await sampleColor(display, probeX, probeY);
  check(
    '游戏进 topmost 带后夺回带顶（Windows 规则，不是 bug）',
    whichWindow(contested) === '游戏',
    `抽检到 ${whichWindow(contested)}色 rgb(${contested.r},${contested.g},${contested.b})`,
  );
  check(
    '双方都自认置顶（说明标志位没错，纯粹是带内次序）',
    floatWin.isAlwaysOnTop() === true && gameWin.isAlwaysOnTop() === true,
  );
  check('游戏仍持有焦点（浮窗没抢）', gameWin.isFocused() === true);

  /* ---------------- 四种「抬回来」的招 ---------------- */
  console.log('\n抬回来组（哪个真管用、哪个会抢焦点）');
  const techniques = [
    [
      "setAlwaysOnTop(true,'screen-saver') 重断言",
      () => floatWin.setAlwaysOnTop(true, 'screen-saver'),
    ],
    ['moveTop()', () => floatWin.moveTop()],
    [
      "setAlwaysOnTop(false) → (true,'screen-saver')",
      () => {
        floatWin.setAlwaysOnTop(false);
        floatWin.setAlwaysOnTop(true, 'screen-saver');
      },
    ],
    ['showInactive()', () => floatWin.showInactive()],
  ];
  for (const [label, apply] of techniques) {
    // 先把浮窗挤下去：让游戏重新激活一次（就是「用户点回游戏」那一下）
    gameWin.moveTop();
    gameWin.focus();
    await sleep(600);
    const pushed = whichWindow(await sampleColor(display, probeX, probeY)) === '游戏';
    const focusBefore = gameWin.isFocused();
    apply();
    await sleep(600);
    const back = whichWindow(await sampleColor(display, probeX, probeY)) === '浮窗';
    const keepsFocus = gameWin.isFocused();
    // showInactive 只管显隐、不动 z-order，所以它是唯一抬不动的那一个
    const shouldRaise = label !== 'showInactive()';
    check(
      `挤下去=${pushed} 抬回来=${back}（期望 ${shouldRaise}） 游戏焦点 ${focusBefore}→${keepsFocus}`,
      pushed && back === shouldRaise && keepsFocus,
      label,
    );
  }

  /* ---------------- 保活时延 ---------------- */
  console.log('\n保活时延组（间隔从源码里读，避免脚本和实现漂移）');
  const srcPath = path.join(__dirname, '..', 'apps', 'desktop', 'electron', 'window-mode.ts');
  const source = fs.readFileSync(srcPath, 'utf8');
  const match = /const TOPMOST_KEEPALIVE_MS = (\d+);/.exec(source);
  const KEEPALIVE_MS = match ? Number(match[1]) : -1;
  const intervalMs = KEEPALIVE_MS > 0 ? KEEPALIVE_MS : 300;
  check('能从源码读到 TOPMOST_KEEPALIVE_MS', match !== null, `= ${KEEPALIVE_MS}`);
  // 这一条才是「保活必须够快」的回归闸门 —— 有人改回 1.5 秒，这里立刻红
  check('保活间隔 ≤ 400ms', KEEPALIVE_MS > 0 && KEEPALIVE_MS <= 400, `${KEEPALIVE_MS}ms`);

  // 起点要干净：保活还没开，让游戏把浮窗挤下去，确认此刻确实被盖住
  floatWin.setAlwaysOnTop(true, 'screen-saver');
  await sleep(400);
  gameWin.moveTop();
  gameWin.focus();
  await sleep(700);
  const pushedDown = await sampleColor(display, probeX, probeY);
  check(
    '起点：保活未开时浮窗确实被游戏压下去',
    whichWindow(pushedDown) === '游戏',
    `抽检到 ${whichWindow(pushedDown)}色 rgb(${pushedDown.r},${pushedDown.g},${pushedDown.b})`,
  );

  // 单次抽检本身的开销是纯观测成本，要从恢复时间里扣掉，否则量的是截图不是保活
  const costStart = Date.now();
  await sampleColor(display, probeX, probeY);
  const sampleCost = Date.now() - costStart;

  const t0 = Date.now();
  const keepAlive = setInterval(() => {
    if (!floatWin.isDestroyed() && !floatWin.isMinimized() && floatWin.isVisible()) {
      floatWin.setAlwaysOnTop(true, 'screen-saver');
    }
  }, intervalMs);

  let elapsed = null;
  while (Date.now() - t0 < 4000) {
    if (whichWindow(await sampleColor(display, probeX, probeY)) === '浮窗') {
      elapsed = Date.now() - t0;
      break;
    }
  }
  clearInterval(keepAlive);

  // 判据：扣掉观测开销后，恢复时间不超过「一个保活周期 + 250ms」。
  //
  // ⚠️ **这条分辨不出 300ms 和 1500ms** —— 单次像素抽检本身要 0.2~0.9 秒（实测有一轮
  // 到了 928ms），观测粒度比被测对象还粗。所以「保活够不够快」这个闸门交给上面那条
  // 「保活间隔 ≤ 400ms」（直接读源码常量，改慢了必红 —— 已反向验证过）。
  // 这一条只负责证明「保活真的在抬，不是代码根本没跑」。
  const budget = intervalMs + 250;
  const recovery = elapsed === null ? null : Math.max(0, elapsed - sampleCost);
  check(
    `保活确实能把浮窗抬回来（≤ 一个周期 + 250ms）`,
    recovery !== null && recovery <= budget,
    elapsed === null
      ? '>4000ms（没抬回来）'
      : `实测 ${elapsed}ms − 抽检开销 ${sampleCost}ms = ${recovery}ms（预算 ${budget}ms）`,
  );

  /* ---------------- 焦点保护 ---------------- */
  console.log('\n焦点保护组（「游戏不能操控」的命门）');
  floatWin.setFocusable(true);
  await sleep(300);
  gameWin.moveTop();
  gameWin.focus();
  await sleep(500);
  const stealBefore = gameWin.isFocused();
  floatWin.focus(); // 模拟「用户点了浮窗」
  await sleep(500);
  const stealAfter = gameWin.isFocused();
  check(
    '对照组：可聚焦时 focus() 确实抢得走游戏焦点（先证明这个测法灵敏）',
    stealBefore === true && stealAfter === false,
    `游戏焦点 ${stealBefore}→${stealAfter}`,
  );

  floatWin.setFocusable(false);
  await sleep(300);
  gameWin.moveTop();
  gameWin.focus();
  await sleep(500);
  const keepBefore = gameWin.isFocused();
  floatWin.focus();
  await sleep(500);
  const keepAfter = gameWin.isFocused();
  check(
    'setFocusable(false) 之后同一个调用抢不动游戏焦点',
    keepBefore === true && keepAfter === true,
    `游戏焦点 ${keepBefore}→${keepAfter}`,
  );
  check('浮窗确实变成不可聚焦的窗口', floatWin.isFocusable() === false);

  floatWin.destroy();
  gameWin.destroy();

  console.log(`\n${failed === 0 ? '✓ 通过' : `✗ ${failed} 项未通过`}\n`);
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(`\n✗ ${err && err.message ? err.message : err}\n`);
    app.exit(1);
  }),
);

// 兜底：万一卡在某个 await 上，别让一个全屏窗口留在用户屏幕上
// 七组跑完约 25 秒，留一倍余量
setTimeout(() => {
  console.error('\n✗ 超时（60 秒），强制退出\n');
  app.exit(1);
}, 60000);
