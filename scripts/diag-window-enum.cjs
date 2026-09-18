/**
 * 诊断：桌面捕获为什么看不到某个窗口。
 *
 * 背景：以撒的结合窗口有时出现在源列表里、有时不出现，而窗口并未最小化。
 *      实测「正常状态」下枚举完全稳定（4 种参数 × 5 轮，窗口集合零波动），
 *      缩略图 / 图标也不影响窗口数量 —— 所以不是枚举抖动，
 *      而是那个窗口**当时**被 Chromium 的过滤条件挡掉了。
 *
 * Chromium 在 Windows 上枚举窗口时会跳过这些窗口：
 *   - 不可见（!IsWindowVisible）
 *   - 已最小化（IsIconic）
 *   - 标题为空
 *   - 被 DWM cloaked（全屏应用切到后台、UWP 挂起等）
 * 这些状态从 desktopCapturer 这一侧完全看不到，只能靠「窗口集合什么时候变化」反推。
 *
 * 两种模式（环境变量 DIAG_MODE）：
 *   compare（默认）  4 种枚举参数 × N 轮，验证参数是否影响窗口数量
 *   watch            每秒枚举一次，只打印「窗口集合发生变化的时刻」
 *                    —— 复现「抓不到」时用这个：跑起来，然后去切游戏的前台/后台
 *
 * 跑法（项目根）：
 *   node scripts/run-electron.cjs scripts/diag-window-enum.cjs
 * 或双击根目录的「诊断窗口抓取.bat」。
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { app, desktopCapturer } = require('electron');

const MODE = process.env.DIAG_MODE === 'watch' ? 'watch' : 'compare';
const ROUNDS = Number(process.env.DIAG_ROUNDS || 5);
const WATCH_TICKS = Number(process.env.DIAG_TICKS || 120);
const TYPES = ['window', 'screen'];
const NO_THUMB = { types: TYPES, thumbnailSize: { width: 0, height: 0 } };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 进程名里带 isaac 的进程。
 * 用来区分「窗口不存在」和「窗口存在但被 Chromium 过滤掉了」——
 * 两种情况在 desktopCapturer 眼里都是「列表里没有」，处理方式却完全不同。
 */
function isaacProcesses() {
  try {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'latin1' });
    return out
      .split(/\r?\n/)
      .map((line) => {
        const matched = line.match(/^"([^"]+)"/);
        return matched ? matched[1] : null;
      })
      .filter((name) => name && /isaac/i.test(name));
  } catch {
    return null;
  }
}

function describeGame() {
  const procs = isaacProcesses();
  if (procs === null) return '以撒进程：查询失败';
  return `以撒进程：${procs.length ? procs.join(', ') : '未运行'}`;
}

const CONFIGS = [
  { key: 'A · 不取缩略图 / 不取图标', opts: { ...NO_THUMB, fetchWindowIcons: false } },
  { key: 'B · 不取缩略图 / 取图标', opts: { ...NO_THUMB, fetchWindowIcons: true } },
  {
    key: 'C · 240x135 / 取图标（当前实现）',
    opts: { types: TYPES, thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: true },
  },
  {
    key: 'D · 240x135 / 不取图标',
    opts: { types: TYPES, thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: false },
  },
];

const idOf = (list) => new Map(list.map((s) => [s.id, s.name]));

async function compare() {
  console.log(`每种配置连续枚举 ${ROUNDS} 轮\n`);

  const perConfig = [];
  for (const cfg of CONFIGS) {
    const runs = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      try {
        runs.push(await desktopCapturer.getSources(cfg.opts));
      } catch (err) {
        runs.push(null);
        console.log(`  ✗ ${cfg.key} 第 ${i + 1} 轮抛错：${err && err.message}`);
      }
      await sleep(120);
    }
    perConfig.push({ cfg, runs });
    console.log(`[${cfg.key}] 每轮数量：${runs.map((r) => (r ? r.length : 'ERR')).join(' ')}`);
  }

  const all = new Map();
  for (const { runs } of perConfig) {
    for (const run of runs) {
      if (!run) continue;
      for (const s of run) if (!all.has(s.id)) all.set(s.id, s.name);
    }
  }

  console.log(`\n--- 跨配置比较（全集 ${all.size} 个源，含窗口与屏幕）---`);
  for (const { cfg, runs } of perConfig) {
    const seen = new Set();
    for (const run of runs) {
      if (!run) continue;
      for (const s of run) seen.add(s.id);
    }
    const missing = [...all.entries()].filter(([id]) => !seen.has(id));
    console.log(
      `  ${cfg.key}：看到 ${seen.size}/${all.size}` +
        (missing.length ? `，缺 → ${missing.map(([, n]) => n).join(' | ')}` : '（无缺失）'),
    );
  }

  console.log('\n--- 同配置跨轮次波动 ---');
  let unstable = false;
  for (const { cfg, runs } of perConfig) {
    const sets = runs.filter(Boolean).map((run) => new Set(run.map((s) => s.id)));
    if (sets.length < 2) continue;
    const first = sets[0];
    const dropped = [...first].filter((id) => !sets.every((s) => s.has(id)));
    if (dropped.length) {
      unstable = true;
      console.log(`  ⚠ ${cfg.key}：第1轮有、之后丢过 → ${dropped.map((id) => all.get(id)).join(' | ')}`);
    }
  }
  if (!unstable) console.log('  （无波动：每种配置的多轮结果完全一致）');

  console.log('\n--- 当前实现（配置 C）第一轮完整名单 ---');
  const current = perConfig.find((p) => p.cfg.key.startsWith('C'))?.runs.find(Boolean) ?? [];
  for (const s of current) {
    const kind = s.id.startsWith('screen:') ? '屏幕' : '窗口';
    const thumb = s.thumbnail && !s.thumbnail.isEmpty() ? '' : ' [缩略图空]';
    console.log(`  ${kind}  ${s.id}${thumb}  ${s.name}`);
  }
}

async function watch() {
  console.log(`持续监控：每 1 秒枚举一次，只在窗口集合变化时打印。`);
  console.log(`共 ${WATCH_TICKS} 秒（Ctrl+C 可提前结束）。`);
  console.log('建议现在就去做那个「抓不到」的操作 —— 切游戏前台/后台、最小化再还原。\n');

  let prev = new Map();
  let tick = 0;

  while (tick < WATCH_TICKS) {
    tick += 1;
    let list;
    try {
      list = await desktopCapturer.getSources(NO_THUMB);
    } catch (err) {
      console.log(`[${tick}s] ✗ 枚举抛错：${err && err.message}`);
      await sleep(1000);
      continue;
    }

    const curr = idOf(list);
    const added = [...curr].filter(([id]) => !prev.has(id));
    const removed = [...prev].filter(([id]) => !curr.has(id));

    if (tick === 1 || added.length || removed.length) {
      const changed = added.length || removed.length;
      console.log(`[${tick}s] 共 ${curr.size} 个源${changed ? '  ← 有变化' : '（基准）'}`);
      for (const [id, name] of added) console.log(`      + ${name}   (${id})`);
      for (const [, name] of removed) console.log(`      - ${name}`);
      console.log(`      ${describeGame()}`);
    }

    prev = curr;
    await sleep(1000);
  }
  console.log('\n监控结束。');
}

app.whenReady().then(async () => {
  console.log('=== 窗口抓取诊断 ===');
  console.log(
    `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / ${process.platform}`,
  );
  console.log(describeGame());
  console.log();

  if (MODE === 'watch') await watch();
  else await compare();

  app.quit();
});
