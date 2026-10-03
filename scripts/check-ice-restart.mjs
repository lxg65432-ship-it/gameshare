#!/usr/bin/env node
/**
 * ICE 自愈状态机验收（`npm run check:ice-restart`）。
 *
 * --- 为什么必须单独写一个脚本，不能靠 smoke:p2p 顺带验 ---
 *
 * 自愈只在链路**掉到 disconnected / failed** 时才触发，而 smoke:p2p 跑的是
 * 本机回环（host 候选秒连），链路全程 connected —— 那条路径永远走不到。
 * 真要制造断链得掐防火墙或者换网卡，代价大且不稳。
 *
 * 所以这里把 `RTCPeerConnection` 换成可控的假件，让状态机被**按需驱动**：
 * 想让它 failed 就调一下 `fake.fail()`，之后观察 PeerLink 到底做了什么。
 * 被验的不是「网络通不通」（那归 smoke:p2p），而是
 * **「给定这些状态变化，PeerLink 的反应对不对」**。
 *
 * --- 断言的正确形式 ---
 *
 * 每条都是「实际发生的动作 == 按退避表算出的期望动作」。
 * 写成「应该至少调过一次 restartIce」这种宽断言是自欺欺人：
 * 调 100 次也算过，而调 100 次恰恰是 bug。
 *
 * ⚠️ **判据必须核对「排出去的 delay 值」，不能靠「等多久看它动不动」**。
 * 后者有两种骗法，改了实现而断言照样全绿：
 *   · 退避第 2 档从 10s 改成 3s —— 只等 700ms 的话前半段确实「没重开」，通过
 *   · 整体删掉退避改成 0 —— 只等 300ms 的话第 1 次根本来不及发，也通过
 * 这个坑踩过两轮：第一版 24 项断言在「退避表全改 0」的情况下依然全绿。
 *
 * --- 已知的两条软断言（别指望它们能抓） ---
 *
 * `#restartIce` 里的「上限复查」与「排退避前清旧定时器」都是**冗余防御**：
 * 前者防「排定时器时 attempts 未到顶、醒来时已到顶」，后者防「旧定时器被覆盖后
 * 仍活着却再拿不到」。在当前实现下这两条路径**正常走不到**（前者被「排退避前
 * clear 旧定时器」消掉，后者被单值字段消掉），所以把对应代码删掉，这 54 项
 * 断言依然全绿。这是诚实结论，不是漏写 —— 留着它们是因为真出现竞态时能救命，
 * 而假件还构造不出那个场景。
 *
 * 用法：node scripts/check-ice-restart.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.cache', 'check-ice-restart');

/* ------------------------------------------------------------------ *
 * 假 RTCPeerConnection
 * ------------------------------------------------------------------ */

/** 每建一个实例记一条，断言要靠它核对「到底对哪个 peer 做了什么」 */
const instances = [];

/**
 * 统计「排出去的定时器」数量。
 *
 * 存在的理由：被动方有两道内容相同的 `#initiator` 守卫（有意双保险），
 * 删掉任意一道都不改变可观测行为 —— 靠「有没有调 restartIce」分辨不出来。
 * 能分辨的只有**第一道早退**：它在排 setTimeout 之前就返回了。
 * 于是「被动方断链时到底排没排定时器」成了唯一可测的差别。
 *
 * 只增不减 —— 只需要知道「新增了几个」，clearTimeout 不影响这个计数。
 */
let timerCount = 0;
/**
 * 只数「宽度明显不是自愈用的」那些定时器是不行的 —— `#scheduleDirectionCheck`
 * 每次 connected 都会排 3 个，混在里面数不清，且按 delay 过滤也躲不开
 * （它的第一档同样是 0ms，与自愈撞车）。
 * ⇒ 判据改用生产代码的 `iceRestartScheduled` 诊断字段，本计数器只作辅助。
 */
const timerDelays = [];
const realSetTimeout = globalThis.setTimeout;

/**
 * 时间缩放：把长退避按比例压短。
 *
 * 为什么需要：退避表是 0/10s/25s/60s，真按墙钟等 4 轮要 95 秒 ——
 * 一个每次都跑 1.5 分钟的验收脚本没人会愿意等。
 *
 * **缩放只作用于 >1s 的 delay**：0ms 与 4s 宽限期不缩，
 * 否则「宽限期有没有生效」这类判据会被压缩掉（用例 2b 只等 300ms）。
 *
 * ⚠️ **本脚本自己的 `sleep` 必须走原版 `realSetTimeout`**。
 * 否则连等待本身都被缩放：写 `await sleep(1500)` 实际只等了 60ms，
 * 于是「等退避到点」变成「压根没等到」，看起来像退避没生效。
 * 这个坑排查了整整一轮才定位到（症状是 attempts 恒为 1，
 * 而所有 delay 记录都显示缩放正确 —— 缩放是对的，只是把裁判也缩了）。
 */
const TIME_SCALE = 0.02;
const MIN_SCALED_MS = 60;

/** 缩放后的 delay 记录，供用例核对「排的定时器是第几档」 */
const scaledDelays = [];

globalThis.setTimeout = (fn, delay, ...rest) => {
  timerCount += 1;
  timerDelays.push(delay);
  const scaled = delay > 1000 ? Math.max(MIN_SCALED_MS, Math.round(delay * TIME_SCALE)) : delay;
  scaledDelays.push([delay, scaled]);
  return realSetTimeout(fn, scaled, ...rest);
};
globalThis.__SCALED__ = [];


class FakePeerConnection {
  constructor(config) {
    this.config = config ?? {};
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.iceGatheringState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.transceivers = [];

    // 事件句柄由 PeerLink 赋值
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.onicegatheringstatechange = null;
    this.onicecandidate = null;
    this.onicecandidateerror = null;
    this.onnegotiationneeded = null;
    this.ontrack = null;

    /** 动作流水，断言全部基于它 */
    this.actions = [];
    this.closed = false;

    instances.push(this);
  }

  /* --- 驱动：外部用这三个方法制造状态变化 --- */

  /** 推进到指定连接状态，并触发对应回调 */
  drive(next) {
    this.connectionState = next;
    this.iceConnectionState = next === 'connected' ? 'connected' : next;
    this.actions.push({ type: 'state', value: next });
    this.onconnectionstatechange?.();
  }

  /** 模拟一次候选收集（重开后会重新走一遍） */
  gather(candidateTypes = ['host', 'srflx']) {
    this.iceGatheringState = 'gathering';
    this.onicegatheringstatechange?.();
    for (const typ of candidateTypes) {
      const candidate = { candidate: `candidate:1 1 udp 2 10.0.0.1 5000 typ ${typ}`, toJSON: () => ({}) };
      this.onicecandidate?.({ candidate });
    }
    this.iceGatheringState = 'complete';
    this.onicegatheringstatechange?.();
  }

  /* --- PeerLink 调用的方法 --- */

  restartIce() {
    this.actions.push({ type: 'restartIce' });
  }

  addTransceiver(kind, opts) {
    const t = {
      kind,
      direction: opts?.direction ?? 'sendrecv',
      currentDirection: null,
      mid: String(this.transceivers.length),
      sender: { track: null, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} },
      stop: () => {},
    };
    this.transceivers.push(t);
    this.actions.push({ type: 'addTransceiver', value: kind });
    return t;
  }

  getTransceivers() {
    return this.transceivers;
  }

  async setLocalDescription() {
    // 协商中途禁止再 restartIce —— 真实浏览器同样会拒绝不稳定的 SDP
    this.signalingState = 'have-local-offer';
    this.localDescription = { type: 'offer', sdp: 'v=0\r\n' };
    this.actions.push({ type: 'setLocalDescription' });
  }

  async setRemoteDescription(desc) {
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.remoteDescription = desc;
    this.actions.push({ type: 'setRemoteDescription', value: desc.type });
  }

  async createOffer() {
    this.actions.push({ type: 'createOffer' });
    return { type: 'offer', sdp: 'v=0\r\n' };
  }

  async addIceCandidate() {}

  close() {
    this.closed = true;
    this.actions.push({ type: 'close' });
  }

  /* --- 统计相关，自愈验不到但 PeerLink 构造时会碰 --- */

  getStats() {
    return Promise.resolve(new Map());
  }
}

/** 把累计定时器数挂到假件上，供断言读取（只读 getter，别赋值） */
Object.defineProperty(FakePeerConnection, 'timerCount', {
  get: () => timerCount,
});

/**
 * 挂到全局。
 *
 * PeerLink 直接 `new RTCPeerConnection(...)`，没有注入点 ——
 * 改生产代码的构造签名只为测试不值得，所以走全局替换。
 */
globalThis.RTCPeerConnection = FakePeerConnection;
globalThis.RTCSessionDescription = class {};
globalThis.RTCRtpSender = class {};
globalThis.MediaStream = class {
  getTracks() {
    return [];
  }
  addTrack() {}
};
globalThis.MediaStreamTrack = class {};

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/**
 * 本脚本的等待 —— **必须用原版 setTimeout**。
 *
 * 写成 `setTimeout(r, ms)` 会被上面的时间缩放装置拦掉，`sleep(1500)` 实际只等 60ms，
 * 于是「等退避到点」变成「压根没等到」，症状看起来像退避没生效（其实退避是对的）。
 * 这个坑排查了一整轮：所有 delay 记录都显示缩放正确，只有 attempts 恒为 1。
 */
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));


/**
 * 统计某个动作出现的次数。
 *
 * 必须数次数而不是判存在 —— 「至少调过一次」这类断言在实现退化成
 * 「每次状态变化都无脑重开一次」时依然会通过，而那正是要防的 bug。
 */
function countActions(pc, type) {
  return pc.actions.filter((a) => a.type === type).length;
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

/* ------------------------------------------------------------------ *
 * 编译并加载 PeerLink
 * ------------------------------------------------------------------ */

async function loadPeerLinkModule() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entry = path.join(OUT_DIR, 'entry.ts');
  fs.writeFileSync(
    entry,
    `export { PeerLink } from ${JSON.stringify(path.join(ROOT, 'apps/desktop/src/rtc/PeerLink.ts').replace(/\\/g, '/'))};\n`,
    'utf8',
  );

  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    outfile: path.join(OUT_DIR, 'peerlink.mjs'),
    // node_modules 里那三个 workspace 包在浏览器目标下不该被当成 external
    external: [],
    logLevel: 'silent',
  });

  return import(pathToFileURL(path.join(OUT_DIR, 'peerlink.mjs')).href);
}

function makeLink(PeerLink, opts = {}) {
  const logs = [];
  const signaling = {
    sendOffer() {},
    sendAnswer() {},
    sendIceCandidate() {},
    on: () => () => {},
  };
  const link = new PeerLink({
    selfPeerId: opts.selfPeerId ?? 'zzz-initiator',
    remotePeerId: opts.remotePeerId ?? 'aaa-remote',
    signaling,
    iceServers: [],
    log: (line) => logs.push(line),
  });
  return { link, logs, pc: link.pc };
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

async function main() {
  const { PeerLink } = await loadPeerLinkModule();

  console.log('');
  console.log('══ ICE 自愈状态机验收 ══');
  console.log(`  退避表 0/10s/25s/60s，上限 4 次；disconnected 宽限 4s；answer 兜底 15s`);

  /* --- 用例 1：failed 立即重开，且退避表第 0 档是 0ms --- */
  section('用例 1：failed → 立即重开（第 1 次）');
  {
    const before = instances.length;
    const { link, pc, logs } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    // 必须由主动方建（m-line 只由主动方创建）
    check('主动方建链路时创建了 3 条 m-line', pc.transceivers.length === 3, `实际 ${pc.transceivers.length}`);
    check('新建链路没有被动过 restartIce', countActions(pc, 'restartIce') === 0);

    pc.gather(['host', 'srflx']);
    pc.drive('failed');
    await sleep(50);

    check(
      'failed 后调了恰好 1 次 restartIce',
      countActions(pc, 'restartIce') === 1,
      `实际 ${countActions(pc, 'restartIce')} 次`,
    );
    check(
      '重开紧跟一次协商（restartIce 只打标记，真正重开靠 createOffer）',
      countActions(pc, 'setLocalDescription') === 1,
      `实际 ${countActions(pc, 'setLocalDescription')} 次`,
    );
    check(
      '日志写明是第 1/4 次',
      logs.some((l) => l.includes('ICE 重开 1/4')),
      logs.filter((l) => l.includes('ICE 重开')).join(' | ') || '(无相关日志)',
    );
    link.close();
    check('close() 后实例已关闭', pc.closed === true);
    void before;
  }

  /* --- 用例 2：退避表逐档生效 ---
   *
   * 判据用「记录到的 delay 值 == 退避表算出的期望值」，而不是「等多久看它动不动」。
   * 后者有两种骗法：
   *   · 把第 2 档从 10s 改成 3s —— 只等 700ms 的话照样「没重开」，通过
   *   · 把退避整体删掉改成 0 —— 只等 300ms 的话第 1 次根本来不及发，也通过
   * 直接核对 delay 是唯一能同时抓住这两种错法的形式。
   */
  section('用例 2：退避表逐档生效');
  {
    const { link, pc, logs } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.gather();

    // 第 1 次：退避 0ms
    pc.drive('failed');
    await sleep(50);
    check('第 1 次重开已执行', countActions(pc, 'restartIce') === 1, `实际 ${countActions(pc, 'restartIce')}`);
    check(
      '第 1 次重开后 pending 为真（正在等 answer）',
      link.getDiagnostics().iceRestartPending === true,
      `实际 ${link.getDiagnostics().iceRestartPending}`,
    );

    // 走真实路径送 answer 解除 pending。
    // **别手改 signalingState** —— 那是绕过 handleAnswer 的守卫，
    // 结果 pending 没解开，后面整轮用例都在测一个不存在的状态。
    await link.handleAnswer('v=0\r\n');
    check(
      'answer 落地后 pending 已解除',
      link.getDiagnostics().iceRestartPending === false,
      `实际 ${link.getDiagnostics().iceRestartPending}`,
    );

    // 第 2 次：退避档位必须正好是 10_000。
    // 记下排定时器那一刻的 delay，与 ICE_RESTART_BACKOFF_MS[1] 比。
    const iceDelaysBefore = timerDelays.length;
    pc.drive('connecting');
    pc.drive('failed');
    await sleep(20);
    const scheduled = timerDelays.slice(iceDelaysBefore);
    check(
      '第 2 次重开排的定时器 delay 正好是退避表第 2 档 10000ms',
      scheduled.includes(10_000),
      `实际排了 [${scheduled.join(', ')}]`,
    );
    check(
      '第 2 次还没到点，不该已经重开',
      countActions(pc, 'restartIce') === 1,
      `实际 ${countActions(pc, 'restartIce')} 次`,
    );
    check(
      '诊断字段 iceRestartScheduled 反映「正在退避中」',
      link.getDiagnostics().iceRestartScheduled === true,
      `实际 ${link.getDiagnostics().iceRestartScheduled}`,
    );
    check(
      '第 1 次重开的日志写明轮次与退避时长（排障要看这个）',
      logs.some((l) => l.includes('ICE 重开 1/4') && l.includes('退避 0ms')),
      logs.filter((l) => l.includes('ICE 重开')).join(' | ') || '(无)',
    );

    link.close();
  }

  /* --- 用例 2b：disconnected 的 4s 宽限期也真的生效 --- */
  section('用例 2b：disconnected 宽限期生效');
  {
    const { link, pc } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.gather();

    // disconnected 宽限 4s。判据直接核对排出去的 delay 是不是 4000 ——
    // 「等多久看它动不动」这种判据在这里是错的：4s 被时间缩放压到 80ms，
    // 任何「等 300ms 还没重开」的写法都会通过，改成 0 也照样通过。
    const before = timerDelays.length;
    pc.drive('disconnected');
    await sleep(20);
    const scheduled = timerDelays.slice(before);
    check(
      'disconnected 排的定时器 delay 正好是宽限 4000ms（没有立刻重开）',
      scheduled.includes(4_000),
      `实际排了 [${scheduled.join(', ')}]`,
    );
    check(
      '宽限期内没有立刻重开',
      countActions(pc, 'restartIce') === 0,
      `实际 ${countActions(pc, 'restartIce')} 次`,
    );

    // failed 不该有宽限 —— 直接 0ms
    pc.drive('failed');
    await sleep(20);
    check(
      'failed 不额外加宽限（退避第 1 档就是 0ms，应当已重开）',
      countActions(pc, 'restartIce') >= 1,
      `实际 ${countActions(pc, 'restartIce')} 次`,
    );
    link.close();
  }

  /* --- 用例 3：pending 未解除时不再重开（防连打） --- */
  section('用例 3：pending 未解除时不再重开');
  {
    const { link, pc } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.gather();

    pc.drive('failed');
    await sleep(50);
    const afterFirst = countActions(pc, 'restartIce');

    // answer 还没来，pending 仍是 true —— 此时再次 failed 不该再触发
    pc.drive('failed');
    pc.drive('failed');
    await sleep(50);
    check(
      'pending 期间反复 failed 不触发新重开',
      countActions(pc, 'restartIce') === afterFirst,
      `实际 ${countActions(pc, 'restartIce')}，期望 ${afterFirst}`,
    );
    link.close();
  }

  /* --- 用例 4：answer 落地后解除 pending，恢复可重试 --- */
  section('用例 4：answer 落地解除 pending');
  {
    const { link, pc } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.gather();

    pc.drive('failed');
    await sleep(50);
    check('重开后 pending 为真', link.getDiagnostics().iceRestartPending === true);

    await link.handleAnswer('v=0\r\n');
    check(
      'answer 落地后 pending 解除',
      link.getDiagnostics().iceRestartPending === false,
      `实际 ${link.getDiagnostics().iceRestartPending}`,
    );
    link.close();
  }

  /* --- 用例 5：被动方不重开，也不消耗配额 --- */
  section('用例 5：被动方不重开');
  {
    const { link, pc, logs } = makeLink(PeerLink, { selfPeerId: 'aaa-remote', remotePeerId: 'zzz-initiator' });
    check('被动方建链路时不创建 m-line', pc.transceivers.length === 0, `实际 ${pc.transceivers.length}`);

    pc.gather();
    pc.drive('failed');
    await sleep(100);
    check('被动方 failed 后不调 restartIce', countActions(pc, 'restartIce') === 0, `实际 ${countActions(pc, 'restartIce')}`);
    check(
      '被动方重试配额未被动用（仍为 0）',
      link.getDiagnostics().iceRestartAttempts === 0,
      `实际 ${link.getDiagnostics().iceRestartAttempts}`,
    );
    check(
      '被动方上限字段照样上报（诊断要用）',
      link.getDiagnostics().iceRestartMaxAttempts === 4,
      `实际 ${link.getDiagnostics().iceRestartMaxAttempts}`,
    );

    // 第一道守卫早退 ⇒ 被动方一次自愈定时器都不该排。
    // 这是唯一能区分「两道守卫」与「只剩一道守卫」的判据：
    // 两道守卫内容相同，删掉任意一道都不改变「有没有调 restartIce」，
    // 但删掉第一道就一定会排出一个醒来后被空转掉的退避定时器。
    //
    // 用 `iceRestartScheduled` 而不是数全局 setTimeout ——
    // `#scheduleDirectionCheck` 每次 connected 都会排 3 个定时器，
    // 按 delay 过滤也躲不开（它的第一档同样是 0ms，与自愈撞车）。
    for (let i = 0; i < 6; i += 1) {
      pc.drive('failed');
      check(
        `被动方第 ${i + 1} 次断链后没有排自愈定时器`,
        link.getDiagnostics().iceRestartScheduled === false,
        `实际 ${link.getDiagnostics().iceRestartScheduled}`,
      );
      pc.drive('connected');
      await sleep(20);
    }
    check(
      '被动方连打 12 次断链后配额仍为 0',
      link.getDiagnostics().iceRestartAttempts === 0,
      `实际 ${link.getDiagnostics().iceRestartAttempts}`,
    );
    check(
      '被动方连打后仍未调过 restartIce',
      countActions(pc, 'restartIce') === 0,
      `实际 ${countActions(pc, 'restartIce')}`,
    );
    void logs;
    link.close();
  }

  /* --- 用例 6：connected 稳定后配额归还 --- */
  section('用例 6：connected 稳定后配额归还');
  {
    const { link, pc } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.gather();

    pc.drive('failed');
    await sleep(50);
    check('failed 后已用掉 1 次配额', link.getDiagnostics().iceRestartAttempts === 1, `实际 ${link.getDiagnostics().iceRestartAttempts}`);
    await link.handleAnswer('v=0\r\n');

    // 回到 connected，但「稳定期」未到，配额还不能还
    pc.drive('connected');
    await sleep(50);
    check(
      '刚 connected 时配额还没还（防「通了又断」打转）',
      link.getDiagnostics().iceRestartAttempts === 1,
      `实际 ${link.getDiagnostics().iceRestartAttempts}`,
    );
    link.close();
  }

  /* --- 用例 7：close() 清掉所有定时器（不漏幽灵重开） ---
   *
   * 判据是 **`iceRestartScheduled` 在 close 后变回 false**，不是「有没有多打日志」。
   * 后者抓不到：定时器醒来时 `#restartIce` 第一行 `if (this.#closed) return`
   * 就挡住了，所以清不清定时器在日志上**完全一样**（这个坑踩过：
   * 把 close 里的 clearTimeout 删掉，日志类断言照样全绿）。
   *
   * 清定时器的真实理由是资源泄漏：mesh 8 人时一个人退出会连带销毁 7 条链路，
   * 每条挂着 1~2 个待唤醒定时器，不清就会一直挂到进程结束。
   * 所以要验的本来就是「还挂着没有」，正好有字段能读。
   */
  section('用例 7：close() 清定时器');
  {
    const { link, pc } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.gather();

    // disconnected 会排一个 4s 宽限定时器（>1s，被缩放到 80ms）
    pc.drive('disconnected');
    check(
      '断链后确实排了自愈定时器（否则本用例是空的）',
      link.getDiagnostics().iceRestartScheduled === true,
      `实际 ${link.getDiagnostics().iceRestartScheduled}`,
    );

    link.close();
    check(
      'close() 后退避定时器已清掉（没留下待唤醒的定时器）',
      link.getDiagnostics().iceRestartScheduled === false,
      `实际 ${link.getDiagnostics().iceRestartScheduled} —— 说明 close 忘了 clearTimeout`,
    );

    // 再叠一条行为断言：宽限期到点也不能写出任何日志
    const logs = [];
    void logs;
    await sleep(400);
    check('close() 后宽限期到点没有幽灵定时器触发重开', countActions(pc, 'restartIce') === 0, `实际 ${countActions(pc, 'restartIce')}`);
  }

  /* --- 用例 7b：answer 兜底定时器也必须在 close 时清掉 --- */
  section('用例 7b：close() 清 answer 兜底定时器');
  {
    const { link, pc, logs } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.gather();

    // failed → 立即重开（退避 0ms），随后挂上 15s 的 answer 兜底（缩放到 300ms）
    pc.drive('failed');
    await sleep(30);
    check('重开已发生', countActions(pc, 'restartIce') === 1, `实际 ${countActions(pc, 'restartIce')}`);
    check(
      '重开后 pending 仍为真（正在等 answer，兜底定时器已挂）',
      link.getDiagnostics().iceRestartPending === true,
      `实际 ${link.getDiagnostics().iceRestartPending}`,
    );

    // **不送 answer** —— 模拟「offer 石沉大海，对端已经走了」
    check(
      '兜底定时器已挂上（否则本用例是空的）',
      link.getDiagnostics().iceRestartAnswerPending === true,
      `实际 ${link.getDiagnostics().iceRestartAnswerPending}`,
    );
    link.close();
    check(
      'close() 后 answer 兜底定时器已清掉',
      link.getDiagnostics().iceRestartAnswerPending === false,
      `实际 ${link.getDiagnostics().iceRestartAnswerPending} —— 说明 close 忘了清兜底定时器`,
    );
    logs.length = 0;
    await sleep(600);
    check(
      'answer 兜底定时器在 close 后没有醒来写日志',
      logs.length === 0,
      logs.join(' | ') || '(空)',
    );
  }

  /* --- 用例 8：重开时清空候选计数（判读不能混两轮） --- */
  section('用例 8：重开清空候选计数');
  {
    const { link, pc, logs } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });

    pc.gather(['host', 'host', 'srflx']);
    check(
      '首轮收集记到 3 个候选',
      logs.some((l) => l.includes('候选收集完成') && l.includes('host×2 srflx×1')),
      logs.filter((l) => l.includes('候选收集完成')).join(' | ') || '(无)',
    );

    pc.drive('failed');
    await sleep(50);
    await link.handleAnswer('v=0\r\n');

    // 重开后重新收集，这次只有 host —— 若没清零，failed 的判读会读到旧数据
    pc.gather(['host']);

    // **直接判据**：新一轮的「候选收集完成」那行必须只有 host。
    // 只看 failed 时的判读不够 —— 那行判读是否含 srflx 取决于断链时
    // 有没有再 failed 一次，很容易写出一个抓不到清空失效的断言
    // （这个坑踩过：把 #resetCandidateTypes 调用删掉，断言依然全绿）。
    const gatherLines = logs.filter((l) => l.includes('候选收集完成'));
    const lastGather = gatherLines[gatherLines.length - 1] ?? '';
    check(
      '重开后新一轮候选只有 host×1（旧的 host×2 srflx×1 已清零）',
      lastGather.includes('host×1') && !lastGather.includes('srflx'),
      `最后一条收集汇总：${lastGather || '(无)'}`,
    );
    check(
      '清零动作本身有留痕（排障时能看出发生过一次重开）',
      logs.some((l) => l.includes('候选计数清零')),
      '没看到「候选计数清零」日志',
    );

    // 再补一次 failed，确认判读读到的确实是新一轮。
    // **中间必须先过一次 connected**：`#emitState` 对「状态没变化」会早退
    // （同一状态不重复报，这是对的行为），连着两次 failed 只会打一次判读。
    // 真实的重开序列也必然经过 connected —— 重开后要么通、要么再次 failed，
    // 而「再次 failed」在浏览器里是从 checking 转过来的，中间必然有状态变化。
    pc.drive('connecting');
    pc.drive('failed');
    await sleep(50);
    const diagnoseLines = logs.filter((l) => l.includes('· 判读'));
    const last = diagnoseLines[diagnoseLines.length - 1] ?? '';
    check(
      '重开后判读反映的是新一轮候选（没有 srflx 残留）',
      !last.includes('srflx'),
      `最后一条判读：${last || '(无)'}`,
    );
    check(
      '判读标明这是重开后的再次失败（而不是第一次就 failed）',
      /第 1\/4 次重开后再失败/.test(last),
      `最后一条判读：${last || '(无)'}`,
    );
    link.close();
  }

  /* --- 用例 9：重试到顶后停止重试并明说只能 TURN ---
   *
   * 靠 setTimeout 的时间缩放（见顶部 TIME_SCALE）跑完全程：
   * 真实退避 0/10s/25s/60s 共 95 秒，缩到 2% 后是 1.9 秒。
   * 缩放只作用于 >1s 的 delay，0ms 与 4s 宽限期保持原样 ——
   * 否则「宽限期生效与否」的判据会被压缩掉。
   */
  section('用例 9：重试到顶停手');
  {
    const { link, pc, logs } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.gather(['host', 'srflx']);

    // 连打 8 轮，每轮走完整状态翻转（connecting → failed）并送 answer 解除 pending。
    // 两个坑都要避开：
    //   · 手改 signalingState 会绕过 handleAnswer 的守卫，pending 解不开，第二轮起就没进重开逻辑
    //   · 连着两次 failed 不带 connecting，`#emitState` 对「状态没变化」会早退，
    //     压根不会重新排退避 —— 于是配额永远停在 1，测不到上限
    for (let i = 0; i < 8; i += 1) {
      pc.drive('connecting');
      pc.drive('failed');
      // 等这一轮的退避到点（最长一档 60s × 2% = 1.2s）+ 一点余量
      await sleep(1_400);
      await link.handleAnswer('v=0\r\n');
    }

    const attempts = link.getDiagnostics().iceRestartAttempts;
    check('确实试到了上限 4（不是压根没重试）', attempts === 4, `实际 ${attempts}`);

    // 到顶后再断链：不该再排定时器，也不该再涨
    pc.drive('connecting');
    pc.drive('failed');
    await sleep(50);
    check(
      '到顶后重试次数不再增加',
      link.getDiagnostics().iceRestartAttempts === 4,
      `实际 ${link.getDiagnostics().iceRestartAttempts}，期望 4`,
    );
    check(
      '到顶后不再排自愈定时器',
      link.getDiagnostics().iceRestartScheduled === false,
      `实际 ${link.getDiagnostics().iceRestartScheduled}`,
    );
    check(
      '到顶时明说「判定为真不通」',
      logs.some((l) => l.includes('已达上限 4 次仍不通，判定为真不通')),
      logs.filter((l) => l.includes('上限')).join(' | ') || '(无)',
    );
    check(
      '到顶时的最终判读指向 TURN（对称 NAT 这类无解场景）',
      logs.some((l) => l.includes('已达上限') && l.includes('TURN')),
      '到顶日志里没有 TURN 判读',
    );
    link.close();
  }
  /* --- 用例 10：退避等待期间又断链，不能因此超上限 --- */
  section('用例 10：并发退避不超上限');
  {
    const { link, pc } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.gather(['host', 'srflx']);

    // 场景：配额还剩 1（上限 4）时，**在退避等待期间**又断了链。
    // 于是「排定时器时看到的 attempts」与「定时器醒来时的 attempts」可能不一致 ——
    // 只在 `#scheduleIceRestart` 里查一次上限会漏掉这种情况。
    //
    // 退避档位 0/10s/25s/60s 被时间缩放压到 0/200/500/1200ms，所以等得起。
    for (let i = 0; i < 3; i += 1) {
      pc.drive('connecting');
      pc.drive('failed');
      // 等这一档退避到点：最长一档 60s × 2% = 1200ms，留 300ms 余量
      await sleep(1_500);
      await link.handleAnswer('v=0\r\n');
    }
    check(
      '前置：三轮跑完已用掉 3 次配额',
      link.getDiagnostics().iceRestartAttempts === 3,
      `实际 ${link.getDiagnostics().iceRestartAttempts} —— 若为 1 说明退避定时器根本没执行，用例是空的`,
    );

    // 第 4 轮：排下第 4 次（上限档 60s→1200ms）的退避定时器，
    // 然后**在它到点之前**再断一次链 —— 会再排一个（此时 attempts 仍是 3，未到顶）
    pc.drive('connecting');
    pc.drive('failed');
    await sleep(30);
    pc.drive('connecting');
    pc.drive('failed');
    await sleep(30);
    check(
      '前置：又排了一个退避定时器（此刻 attempts 仍是 3）',
      link.getDiagnostics().iceRestartScheduled === true,
      `实际 ${link.getDiagnostics().iceRestartScheduled}`,
    );

    // 等两个定时器依次到点。若只在 schedule 里查上限，第 5 次就会真的执行
    await sleep(3_000);
    check(
      '两个定时器都醒过之后，重试次数仍不超过上限 4',
      link.getDiagnostics().iceRestartAttempts === 4,
      `实际 ${link.getDiagnostics().iceRestartAttempts} —— 若为 5 说明缺了「醒来时再查一次」`,
    );
    link.close();
  }

  /* --- 用例 11：归因摘要（要上界面的那一份） --- */
  section('用例 11：归因摘要');
  {
    const { link, pc } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });

    // 刚建链路：一句话「正在连接」，不该有任何归因结论
    check(
      '新建链路的归因是 connecting',
      link.diagnosis.kind === 'connecting',
      `实际 ${link.diagnosis.kind}`,
    );
    check(
      'connecting 的 summary 是「正在连接…」而不是任何报错',
      link.diagnosis.summary === '正在连接…',
      `实际「${link.diagnosis.summary}」`,
    );

    // connected：kind=ok，界面据此**不显示**归因条
    pc.gather(['host', 'srflx']);
    pc.drive('connected');
    check(
      'connected 的归因是 ok（界面不显示归因条）',
      link.diagnosis.kind === 'ok',
      `实际 ${link.diagnosis.kind}`,
    );

    // 「有 srflx 且收集完成但仍连不上」= 正在打洞，不是坏了
    pc.drive('connecting');
    pc.gather(['host', 'srflx']);
    check(
      '有 srflx + 收集完成 + 仍在 connecting ⇒ punching（不是 needs-turn）',
      link.diagnosis.kind === 'punching',
      `实际 ${link.diagnosis.kind} —— 打洞中不该报「需要中继」，那是误报`,
    );

    link.close();
  }

  /* --- 用例 12：failed 归因分「有 srflx / 无 srflx」两支 --- */
  section('用例 12：failed 归因分两支');
  {
    // 支一：有 srflx 仍 failed ⇒ 打洞失败 ⇒ 需要 TURN
    const a = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    a.pc.gather(['host', 'srflx']);
    a.pc.drive('connecting');
    a.pc.drive('failed');
    await sleep(30);
    check(
      '有 srflx 仍 failed ⇒ kind=needs-turn',
      a.link.diagnosis.kind === 'needs-turn',
      `实际 ${a.link.diagnosis.kind}`,
    );
    check(
      'needs-turn 的 summary 明确说「需要中继」（可行动，不是「已断开」）',
      a.link.diagnosis.summary.includes('中继'),
      `实际「${a.link.diagnosis.summary}」`,
    );
    a.link.close();

    // 支二：一个 STUN 都没成 ⇒ 本机网络问题 ⇒ 换节点，别甩给 TURN
    const b = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    b.pc.gather(['host']);
    b.pc.drive('connecting');
    b.pc.drive('failed');
    await sleep(30);
    check(
      '只有 host 仍 failed ⇒ kind=needs-stun',
      b.link.diagnosis.kind === 'needs-stun',
      `实际 ${b.link.diagnosis.kind}`,
    );
    check(
      'needs-stun 的 summary 指向本机设置（代理/防火墙），不是「中继」',
      b.link.diagnosis.summary.includes('STUN') && !b.link.diagnosis.summary.includes('中继'),
      `实际「${b.link.diagnosis.summary}」`,
    );
    b.link.close();
  }

  /* --- 用例 13：重试到顶后归因升级为 exhausted --- */
  section('用例 13：到顶后归因升级');
  {
    const { link, pc } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.gather(['host', 'srflx']);

    // 先跑到上限（退避被时间缩放压到 0/200/500/1200ms）
    for (let i = 0; i < 4; i += 1) {
      pc.drive('connecting');
      pc.drive('failed');
      await sleep(1_500);
      await link.handleAnswer('v=0\r\n');
    }
    check('前置：重试已到上限 4', link.getDiagnostics().iceRestartAttempts === 4, `实际 ${link.getDiagnostics().iceRestartAttempts}`);

    pc.drive('connecting');
    pc.drive('failed');
    await sleep(30);
    check(
      '到顶后 kind=exhausted（不再是 needs-turn）',
      link.diagnosis.kind === 'exhausted',
      `实际 ${link.diagnosis.kind}`,
    );
    check(
      'exhausted 明说「多次重试仍不通」而不是让用户以为还在重试',
      link.diagnosis.summary.includes('多次重试'),
      `实际「${link.diagnosis.summary}」`,
    );
    check(
      'exhausted 仍给出出路（中继），不是死路一条',
      link.diagnosis.summary.includes('中继'),
      `实际「${link.diagnosis.summary}」`,
    );
    link.close();
  }

  /* --- 用例 14：卡在 connecting 超过阈值时打中间日志 --- */
  section('用例 14：卡住中间日志');
  {
    const { link, pc, logs } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });

    // 必须先造候选：判据只看 srflx/relay，候选表为空时日志只能如实报「没有任何候选」，
    // 那测的就不是「日志带上了候选构成」而是「候选表空时日志长什么样」——两码事
    pc.gather(['host', 'srflx']);
    pc.drive('connecting');
    // 阈值 20s > 1000 会被缩放到 400ms，等 700ms 足够
    await sleep(700);
    const stuckLines = logs.filter((l) => l.includes('仍在'));
    check(
      'connecting 超阈值时打出中间日志（不必等 failed）',
      stuckLines.length === 1,
      `实际 ${stuckLines.length} 条：${stuckLines.join(' | ') || '(无)'}`,
    );
    check(
      '中间日志带上候选构成（判据只看 srflx/relay，没候选就无从判断）',
      stuckLines.some((l) => /host×\d+/.test(l)),
      stuckLines.join(' | ') || '(无)',
    );
    // 候选构成是判据本身（有没有 srflx/relay 决定归到 needs-turn 还是 needs-stun），
    // 所以它有自己的字段、只打一遍。混进 detail 会打两遍 ——
    // 那正是它当初被拆出来的原因，所以这条断言得钉住。
    check(
      '候选构成在中间日志里只出现一次（有自己的字段，不混进 detail）',
      (stuckLines[0]?.match(/host×/g) ?? []).length === 1,
      stuckLines.join(' | ') || '(无)',
    );
    check(
      '中间日志带上 ice 状态（区分「还在收集」与「收集完了还连不上」）',
      stuckLines.some((l) => l.includes('ice=')),
      stuckLines.join(' | ') || '(无)',
    );

    // 连上之后不该再冒「仍在连接中」—— 定时器必须被清掉
    pc.gather(['host', 'srflx']);
    pc.drive('connected');
    logs.length = 0;
    await sleep(700);
    check(
      'connected 之后不再冒出「仍在连接中」',
      logs.filter((l) => l.includes('仍在')).length === 0,
      logs.filter((l) => l.includes('仍在')).join(' | ') || '(空)',
    );
    link.close();
  }

  /* --- 用例 15：close() 后不再有中间日志 --- */
  section('用例 15：close() 清中间日志定时器');
  {
    const { link, pc, logs } = makeLink(PeerLink, { selfPeerId: 'zzz-initiator' });
    pc.drive('connecting');
    link.close();
    logs.length = 0;
    await sleep(700);
    check(
      'close() 后卡住定时器不再醒来写日志',
      logs.length === 0,
      logs.join(' | ') || '(空)',
    );
  }

  /* ---------------------------------------------------------------- *
   * 汇总
   * ---------------------------------------------------------------- */

  console.log('');
  console.log('══════════════════════════════════════');
  if (failures.length === 0) {
    console.log(`  ✓ 全部 ${passed} 项通过`);
    console.log('══════════════════════════════════════');
    console.log('');
    return 0;
  }
  console.log(`  ✗ ${failures.length} 项未通过（共 ${passed + failures.length} 项）：`);
  for (const f of failures) console.log(`      · ${f}`);
  console.log('══════════════════════════════════════');
  console.log('');
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('验收脚本自身出错：', err);
    process.exitCode = 1;
  });
