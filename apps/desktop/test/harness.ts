/**
 * P2P 验收用的渲染进程页面。
 *
 * 为什么不用「开两个客户端手工看」来验收：
 * 手工只能确认「看起来像是通了」，说不清是没有帧、还是首帧冻住、还是
 * 只是 UI 显示错了。这里直接读 RTCPeerConnection 的 getStats()，
 * 拿 framesDecoded / bytesReceived 这些硬件层面的数字下结论。
 *
 * 采集源用 canvas 合成动画而不是真实屏幕：
 * 真实采集依赖屏幕权限和桌面内容是否在动，做断言会飘；
 * 合成源让「链路是否通」和「捕获权限是否拿到」这两件事分开验证。
 */

import { computeScaleResolutionDownBy, getProfile, type QualityLevel } from '@game-share/protocol';

import type { EncodingParams, PeerLink } from '../src/rtc/PeerLink';
import type { LinkState, LinkStats, RouteInfo, VideoInbound, VideoOutbound } from '../src/rtc/types';
import { ShareSession } from '../src/session/ShareSession';

/* ------------------------------------------------------------------ *
 * 与 Electron 主进程的桥
 * ------------------------------------------------------------------ */

export interface HarnessLinkReport {
  peerId: string;
  state: LinkState;
  inbound: VideoInbound | null;
  outbound: VideoOutbound | null;
  route: RouteInfo | null;
  encoding: EncodingParams | null;
  /**
   * 本链路的画质档位，以及按「采集源高度 + 档位目标高度」算出的
   * scaleResolutionDownBy 期望值。
   *
   * 断言要拿它和实际落下去的 encoding.scaleResolutionDownBy 比，
   * 不能笼统要求「必须 > 1」—— FOCUS 在 720p 源上按设计就该是 1
   * （源低于目标档位时不放大）。
   */
  qualityLevel: QualityLevel | null;
  /** 采集源实际高度，验证换算是按源而不是按显示器分辨率 */
  sourceHeight: number | null;
  expectedScaleResolutionDownBy: number | null;
  /** 渲染出的 <video> 尺寸；为 0 说明元素根本没拿到画面 */
  videoWidth: number;
  videoHeight: number;
  /** 1.5 秒内解码帧数是否在增长，用于排除「首帧冻住」 */
  framesAdvancing: boolean;
}

export interface HarnessReport {
  index: number;
  peerId: string;
  roomCode: string;
  ok: boolean;
  failure: string | null;
  links: HarnessLinkReport[];
  checks: Record<string, boolean>;
  notes: string[];
  logs: string[];
  diagnostics: Record<string, unknown> | null;
}

interface HarnessBridge {
  ready(): void;
  log(line: string): void;
  announceRoomCode(code: string): void;
  waitGo(): Promise<void>;
  waitRoomCode(): Promise<string>;
  report(payload: HarnessReport): void;
  /** 相位屏障：所有人到达同一步之后才继续，避免「还没看到画面就把对端拆了」 */
  phaseReady(name: string): void;
  waitPhase(name: string): Promise<void>;
}

const bridge = (window as unknown as { harnessBridge?: HarnessBridge }).harnessBridge;

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const INDEX = Number(params.get('index') ?? '0');
const TOTAL = Number(params.get('total') ?? '2');
const SIGNALING_URL = params.get('url') ?? 'http://127.0.0.1:8080';
const TIMEOUT_MS = Number(params.get('timeout') ?? '60000');
/**
 * 「断开一端」场景：所有人确认收到画面后，主进程会真实销毁最后一个窗口。
 * 被销毁的那个窗口不会上报结果，清理断言由其余窗口给出。
 */
const LEAVE_SCENARIO = params.get('leave') === '1';
const LEAVER_INDEX = TOTAL - 1;
/** 合成源尺寸：720p 才能让 GRID(540) 的 scaleResolutionDownBy > 1，真正验证换算逻辑 */
const PATTERN_W = Number(params.get('w') ?? '1280');
const PATTERN_H = Number(params.get('h') ?? '720');
const MIN_FRAMES = 10;

const NICKNAME = `P${INDEX}`;

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

const statusEl = must<HTMLElement>('status');
const stageEl = must<HTMLElement>('stage');

const lines: string[] = [];
const notes: string[] = [];
const checks: Record<string, boolean> = {};
const errors: string[] = [];

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
}

function say(line: string): void {
  lines.push(line);
  statusEl.textContent = `${NICKNAME} · ${TOTAL} 人 · ${SIGNALING_URL}\n${lines.join('\n')}`;
  bridge?.log(`[${NICKNAME}] ${line}`);
}

function note(line: string): void {
  notes.push(line);
  say(`· ${line}`);
}

interface Tile {
  root: HTMLElement;
  video: HTMLVideoElement;
  statsEl: HTMLElement;
}

const tiles = new Map<string, Tile>();

function ensureTile(peerId: string, title: string): Tile {
  const existing = tiles.get(peerId);
  if (existing) return existing;

  const root = document.createElement('div');
  root.className = 'tile';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  const label = document.createElement('div');
  label.className = 'tile__label';
  label.textContent = title;
  const statsEl = document.createElement('div');
  statsEl.className = 'tile__stats';
  statsEl.textContent = '等待…';

  root.append(video, label, statsEl);
  stageEl.append(root);

  const tile: Tile = { root, video, statsEl };
  tiles.set(peerId, tile);
  return tile;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      last = err;
    }
    await sleep(120);
  }
  throw new Error(
    `${label} 在 ${ms}ms 内未达成${last ? `（最后一次异常：${String(last)}）` : ''}`,
  );
}

/* ------------------------------------------------------------------ *
 * 采集链路数据
 * ------------------------------------------------------------------ */

interface Sample {
  peerId: string;
  state: LinkState;
  stats: LinkStats;
}

async function sampleLinks(session: ShareSession): Promise<Sample[]> {
  const mesh = session.mesh;
  if (!mesh) return [];
  return Promise.all(
    mesh.peerIds.map(async (peerId) => {
      const link = mesh.getLink(peerId);
      if (!link) {
        return { peerId, state: 'new' as LinkState, stats: { inbound: null, outbound: null, route: null } };
      }
      return { peerId, state: link.state, stats: await link.readStats() };
    }),
  );
}

/** 一行说清「本机在发什么」和「收到了什么」，定位卡点用 */
function describeProgress(session: ShareSession, samples: Sample[]): string {
  const track = session.capture.track;
  const settings = track?.getSettings();
  const local = track
    ? `本机轨 ${track.readyState}${track.muted ? '/静音' : '/有声'} ` +
      `${settings?.width ?? '?'}x${settings?.height ?? '?'} ` +
      `自绘${session.capture.framesDrawn}帧` +
      (session.capture.lastDrawError ? ` 绘制异常=${session.capture.lastDrawError}` : '')
    : '本机无轨';
  const parts = samples.map((s) => {
    const out = s.stats.outbound;
    const inb = s.stats.inbound;
    return (
      `${s.peerId.slice(0, 6)}[${s.state}] ` +
      `编码${out?.framesEncoded ?? '-'}/${Math.round((out?.bytesSent ?? 0) / 1024)}KB/限${out?.qualityLimitationReason ?? '-'} ` +
      `解码${inb?.framesDecoded ?? '-'}/${Math.round((inb?.bytesReceived ?? 0) / 1024)}KB`
    );
  });
  return `${local} ｜ ${parts.join(' ／ ') || '无链路'}`;
}

/** 失败时把关键诊断一并带回去，否则只能看到一句「未达成」 */
async function collectDiagnostics(session: ShareSession): Promise<Record<string, unknown>> {
  const track = session.capture.track;
  const samples = await sampleLinks(session);
  return {
    sharing: session.getState().sharing,
    captureLabel: session.capture.sourceLabel,
    captureFramesDrawn: session.capture.framesDrawn,
    captureDrawError: session.capture.lastDrawError,
    localStreamActive: session.capture.stream?.active ?? false,
    localTrack: track
      ? {
          readyState: track.readyState,
          enabled: track.enabled,
          muted: track.muted,
          settings: track.getSettings(),
        }
      : null,
    mesh: session.mesh?.getDiagnostics() ?? null,
    inbound: samples.map((s) => ({
      peerId: s.peerId,
      state: s.state,
      inbound: s.stats.inbound,
      outbound: s.stats.outbound,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const session = new ShareSession();

async function main(): Promise<void> {
  say(`启动，合成源 ${PATTERN_W}x${PATTERN_H}`);

  // 先报到，再等主进程放行 —— 否则 0 号窗口可能在别人还没加载完时就把
  // 房间建好，那条 offer 发出去时对端还没有链路，信令就丢了。
  bridge?.ready();
  await bridge?.waitGo();

  session.connect(SIGNALING_URL);
  await waitFor(
    () => session.getState().connection.state === 'connected',
    20_000,
    '连接信令服务器',
  );
  checks.signalingConnected = true;

  let roomCode: string;
  if (INDEX === 0) {
    const data = await session.createRoom(NICKNAME);
    roomCode = data.roomCode;
    say(`已创建房间 ${roomCode}`);

    // 0 号刻意**在别人进来之前**就开始共享：这样「对方已在共享、我才进房」
    // 这个顺序才会真实出现（见下面的断言）。此刻 Mesh 里只有自己，
    // 链路会在对端加入时补挂 —— 那条路径本来就要能走通。
    await session.startShare({
      testPattern: true,
      label: NICKNAME,
      width: PATTERN_W,
      height: PATTERN_H,
      fps: 30,
    });

    // 共享是普通广播（不带 ack），先等它落到服务端再放别人进门。
    // 顺序反过来的话 P1 的 join ack 可能还读到 sharing=false，
    // 这个用例就白设了 —— 实测第一版就是这么挂的。
    await sleep(300);
    bridge?.announceRoomCode(roomCode);
  } else {
    if (!bridge) throw new Error('缺少 harnessBridge，无法接收房间码');
    roomCode = await withTimeout(bridge.waitRoomCode(), 30_000, '等待房间码');
    await session.joinRoom(roomCode, NICKNAME);
    say(`已加入房间 ${roomCode}`);

    // 进房的那一刻别人已经在共享 —— 这几个格子必须显示成「共享中」。
    //
    // 所有人都先进房、再各自开始共享的话，第一次共享会走 share-state 广播，
    // 把「join ack 里的成员共享状态有没有被读进来」这个漏洞整个盖住。
    // 实测就是这么漏过去的：后加入的客户端看谁都是「未共享」，
    // 而格子里画面明明在动。
    const sharers = Object.keys(session.getState().remoteSharing);
    checks.remoteSharingSeeded = sharers.length > 0;
    say(
      `进房即看到的在共享成员：${
        sharers.length ? sharers.map((id) => id.slice(0, 6)).join(',') : '（无）'
      }`,
    );
  }
  checks.inRoom = session.getState().room !== null;

  // 除 0 号（已在上面提前共享）外，进房后再开始共享
  if (INDEX !== 0) {
    await session.startShare({
      testPattern: true,
      label: NICKNAME,
      width: PATTERN_W,
      height: PATTERN_H,
      fps: 30,
    });
  }
  checks.sharingStarted = session.getState().sharing;

  const selfPeerId = session.getState().room?.self.peerId ?? '';
  say(`本机 peerId=${selfPeerId}`);

  /* ---- 1. 全部链路建连 ---- */

  await waitFor(
    () => {
      const links = session.getState().links;
      const ids = Object.keys(links);
      if (ids.length !== TOTAL - 1) return false;
      return ids.every((id) => links[id].state === 'connected');
    },
    TIMEOUT_MS,
    `全部 ${TOTAL - 1} 条链路建连`,
  );
  checks.allLinksConnected = true;
  say(`全部 ${TOTAL - 1} 条链路 connected`);

  /* ---- 2. 每路都解出视频帧 ---- */

  let framesOk = false;
  let lastProgressAt = 0;
  const framesDeadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < framesDeadline) {
    const samples = await sampleLinks(session);
    if (
      samples.length === TOTAL - 1 &&
      samples.every((s) => (s.stats.inbound?.framesDecoded ?? 0) >= MIN_FRAMES)
    ) {
      framesOk = true;
      break;
    }
    // 每 4 秒打一次进度：光看「未达成」无法判断是编码端不出帧还是解码端没收到
    if (Date.now() - lastProgressAt > 4_000) {
      lastProgressAt = Date.now();
      say(`等待画面… ${describeProgress(session, samples)}`);
    }
    await sleep(200);
  }
  if (!framesOk) {
    throw new Error(`所有远端画面解出视频帧 在 ${TIMEOUT_MS}ms 内未达成`);
  }
  checks.framesDecoded = true;

  /* ---- 3. 渲染层确实拿到了画面尺寸 ---- */

  const room = session.getState().room;
  for (const peer of room?.peers ?? []) {
    ensureTile(peer.peerId, peer.nickname);
  }
  const remoteStreams = session.getState().remoteStreams;
  for (const [peerId, tile] of tiles) {
    const stream = remoteStreams[peerId];
    if (stream && tile.video.srcObject !== stream) {
      tile.video.srcObject = stream;
      void tile.video.play().catch(() => undefined);
    }
  }

  await waitFor(
    () => [...tiles.values()].every((t) => t.video.videoWidth > 0),
    15_000,
    '<video> 元素渲染出画面尺寸',
  );
  checks.videoElementsRendering = true;

  /* ---- 3.5 音频 m-line 确实谈成了 ---- */

  // 合成源自带一路 440Hz 测试音，所以这里能真的断言音频到了对端。
  // 只查轨道是否 live，不查 audioLevel —— 远端没有播放动作时 Chromium
  // 不会填那个字段，写成音量的断言会变成一条永远过不了的假失败。
  await waitFor(
    () =>
      [...tiles.keys()].every((peerId) => {
        const stream = session.getState().remoteStreams[peerId];
        return Boolean(stream?.getAudioTracks().some((t) => t.readyState === 'live'));
      }),
    15_000,
    '每一路远端流都带上了音频轨道',
  );
  say(`音频轨道到位：${TOTAL - 1} 路`);
  checks.remoteAudioTracks = true;

  /* ---- 4. 帧数持续增长（排除首帧冻住） ---- */

  const before = await sampleLinks(session);
  await sleep(1_500);
  const after = await sampleLinks(session);

  const advancing = new Map<string, boolean>();
  for (const sample of after) {
    const prev = before.find((b) => b.peerId === sample.peerId);
    const grew =
      prev != null &&
      (sample.stats.inbound?.framesDecoded ?? 0) > (prev.stats.inbound?.framesDecoded ?? 0);
    advancing.set(sample.peerId, grew);
  }
  checks.framesAdvancing = [...advancing.values()].every(Boolean);

  /* ---- 5. 断开一端：对端必须正确清理 ---- */

  // M1 的第二条验收。主进程会在这里真实销毁最后一个窗口（等价于客户端崩掉），
  // 其余客户端必须把它的链路、远端流、成员列表全部清干净，且 PC 真的 close 掉。
  if (LEAVE_SCENARIO && TOTAL >= 3) {
    if (!bridge) throw new Error('缺少 harnessBridge，无法运行断开场景');
    const leaverNick = `P${LEAVER_INDEX}`;

    // 只有「不被断开的那些窗口」才去找待断开的成员。
    // 成员列表不含自己，被选中的窗口去列表里找自己必然找不到 ——
    // 如果让它也走这一段，它会在到达屏障之前就抛错，于是所有窗口
    // 一起卡在屏障上等一个永远凑不齐的人数（这条踩过一次）。
    let leaverId = '';
    let doomed: PeerLink | null = null;
    if (INDEX !== LEAVER_INDEX) {
      const leaver = session.getState().room?.peers.find((p) => p.nickname === leaverNick);
      if (!leaver) throw new Error(`成员列表里找不到待断开的 ${leaverNick}`);
      leaverId = leaver.peerId;
      // 先把对象抓在手里：链路被移除后就再也拿不到它，也就无从确认它是否真的被关闭
      doomed = session.mesh?.getLink(leaverId) ?? null;
      if (!doomed) throw new Error(`断开前就拿不到指向 ${leaverNick} 的链路对象`);
    }

    // 屏障：等所有人都确认收到画面，再让主进程拆掉那一端。
    // 少了这道屏障，可能在对端还没看到画面时就把它拆了，这条断言等于空跑。
    bridge.phaseReady('pre-leave');

    if (INDEX === LEAVER_INDEX) {
      say(`${leaverNick}：本窗口将由主进程销毁，模拟一端断开`);
      await bridge.waitPhase('pre-leave');
      // 被销毁的窗口不参与上报。停在这里等主进程拆掉自己；
      // 万一没被拆掉，这一轮会以超时失败收场，而不是给一个误导性的「通过」。
      await new Promise<never>(() => undefined);
    }

    // 屏障本身也要有超时：任何一方没能走到这里，都应报错而不是全体静默挂住
    await withTimeout(bridge.waitPhase('pre-leave'), 30_000, '等待「各端均已收到画面」相位');

    // 不用 waitFor：这里需要知道「到底哪一部分没清掉」，以及清理究竟花了多久。
    // 光说一句「未达成」既定位不到原因，也量不出断开检测的实际延迟。
    const leaveWaitStart = performance.now();
    const leaveDeadline = leaveWaitStart + 30_000;
    let lastProgressAt = 0;
    let observed = '';
    let cleaned = false;

    while (performance.now() < leaveDeadline) {
      const state = session.getState();
      const peers = state.room?.peers ?? [];
      const short = (ids: readonly string[]): string => ids.map((id) => id.slice(0, 6)).join(',') || '空';

      cleaned =
        state.links[leaverId] === undefined &&
        state.remoteStreams[leaverId] === undefined &&
        !peers.some((p) => p.peerId === leaverId) &&
        peers.length === TOTAL - 2 &&
        session.mesh?.getLink(leaverId) === undefined;

      observed =
        `链路=[${short(Object.keys(state.links))}] ` +
        `成员=[${short(peers.map((p) => p.peerId))}] ` +
        `远端流=[${short(Object.keys(state.remoteStreams))}] ` +
        `mesh=[${short(session.mesh?.peerIds ?? [])}]`;

      if (cleaned) break;

      if (performance.now() - lastProgressAt > 2_000) {
        lastProgressAt = performance.now();
        say(
          `等待 ${leaverNick}（${leaverId.slice(0, 6)}）被清理… ` +
            `+${((performance.now() - leaveWaitStart) / 1000).toFixed(1)}s ${observed}`,
        );
      }
      await sleep(150);
    }

    if (!cleaned) {
      throw new Error(`${leaverNick} 断开后未被清理（等了 30s）；最后观测：${observed}`);
    }

    const leaveLatency = (performance.now() - leaveWaitStart) / 1000;
    note(`断开检测到清理完成耗时约 ${leaveLatency.toFixed(1)}s`);

    if (!doomed || doomed.pc.signalingState !== 'closed') {
      throw new Error(
        `断开后 RTCPeerConnection 仍处于 ${doomed?.pc.signalingState ?? '未知'}，连接没有被关闭`,
      );
    }

    checks.peerLeaveCleanup = true;
    note(`P${leaverNick}（${leaverId.slice(0, 6)}）断开后已清理：链路、远端流、成员列表，PC 已 close`);
  }

  /* ---- 6. 画质档位（M5 预演） ---- */

  // 只让 P1 把「P0 → 自己」这一路提到 FOCUS，其他人保持默认 GRID，
  // 用来确认「不同观看者拿到不同画质」这条设计真的成立。
  //
  // 这一步必须排在采集最终统计之前。发送方的 outbound-rtp 记录的是
  // setParameters 生效之后的状态，提档晚于采样就只能拿到改动前的旧值，
  // 「按观看者独立控画质」这条断言会静默变成永远不触发的空检查。
  let focusTarget: string | null = null;
  // 断开场景下不叠加提档，保持这条断言只考察清理行为
  if (INDEX === 1 && TOTAL >= 3 && !LEAVE_SCENARIO) {
    const firstRemote = session.getState().room?.peers[0]?.peerId ?? null;
    if (firstRemote) {
      focusTarget = firstRemote;
      session.requestQualityFrom(firstRemote, 'FOCUS');
      say(`已向 ${firstRemote} 请求 FOCUS（只影响指向我这一路）`);
    }
  }

  /* ---- 收集结果 ---- */

  // 统一等 2 秒再收尾：
  //   · 提档的客户端需要这段时间让 setParameters 生效；
  //   · 所有客户端都需要一个够长的采样窗口，否则两次 getStats() 只隔几毫秒，
  //     字节增量为 0，报告里会出现「解码 60 帧但收码率 0k」这种自相矛盾的数。
  await sleep(2_000);
  const finalSamples = await sampleLinks(session);
  const sourceHeight = session.capture.sourceHeight;
  const linkReports: HarnessLinkReport[] = [];
  for (const sample of finalSamples) {
    const tile = tiles.get(sample.peerId);
    const link = session.mesh?.getLink(sample.peerId);
    const level = link?.desiredQuality ?? null;
    linkReports.push({
      peerId: sample.peerId,
      state: sample.state,
      inbound: sample.stats.inbound,
      outbound: sample.stats.outbound,
      route: sample.stats.route,
      encoding: link?.readEncodingParams() ?? null,
      qualityLevel: level,
      sourceHeight,
      expectedScaleResolutionDownBy: level
        ? computeScaleResolutionDownBy(sourceHeight, getProfile(level).targetHeight)
        : null,
      videoWidth: tile?.video.videoWidth ?? 0,
      videoHeight: tile?.video.videoHeight ?? 0,
      framesAdvancing: advancing.get(sample.peerId) ?? false,
    });
  }

  for (const link of linkReports) {
    const inb = link.inbound;
    note(
      `链路 ${link.peerId.slice(0, 6)} ${link.state} ` +
        `入 ${inb ? `${inb.frameWidth}x${inb.frameHeight} ${inb.framesPerSecond}fps ${Math.round(inb.bitrateBps / 1000)}kbps ${inb.framesDecoded}帧` : '无'} ` +
        `档位=${link.qualityLevel ?? '?'} 源高=${link.sourceHeight ?? '?'} ` +
        `出 cap=${link.encoding?.maxBitrate ?? '?'} scale=${link.encoding?.scaleResolutionDownBy.toFixed(3) ?? '?'}` +
        `（期望 ${link.expectedScaleResolutionDownBy?.toFixed(3) ?? '?'}） ` +
        `路径=${link.route ? (link.route.relay ? 'TURN' : 'P2P') + '/' + link.route.localType : '未知'}`,
    );
  }
  if (focusTarget) note(`已请求提档的目标：${focusTarget}`);

  const ok = Object.values(checks).every(Boolean);
  const failure = ok ? null : `未通过：${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', ')}`;

  say(ok ? '全部检查通过' : `未通过：${failure}`);

  bridge?.report({
    index: INDEX,
    peerId: selfPeerId,
    roomCode,
    ok,
    failure,
    links: linkReports,
    checks,
    notes,
    logs: lines,
    diagnostics: await collectDiagnostics(session).catch(() => null),
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  errors.push(message);
  say(`失败：${err instanceof Error ? err.message : message}`);

  void (async () => {
    let diagnostics: Record<string, unknown> | null = null;
    try {
      diagnostics = await collectDiagnostics(session);
      for (const line of formatDiagnostics(diagnostics)) note(line);
    } catch {
      // 采集诊断本身失败就不再遮住原始错误
    }

    bridge?.report({
      index: INDEX,
      peerId: session.getState().room?.self.peerId ?? '',
      roomCode: session.getState().room?.roomCode ?? '',
      ok: false,
      failure: message,
      links: [],
      checks,
      notes,
      logs: lines,
      diagnostics,
    });
  })();
});

/** 把诊断对象摊平成几行中文，直接打在验收输出里 */
function formatDiagnostics(diagnostics: Record<string, unknown>): string[] {
  const out: string[] = [];
  const track = diagnostics.localTrack as Record<string, unknown> | null;
  out.push(
    `本机采集：${diagnostics.captureLabel ?? '无'} · 流活跃=${String(diagnostics.localStreamActive)}` +
      ` · 自绘=${String(diagnostics.captureFramesDrawn)}帧` +
      (diagnostics.captureDrawError ? ` · 绘制异常=${String(diagnostics.captureDrawError)}` : '') +
      (track
        ? ` · 轨 ${String(track.readyState)} enabled=${String(track.enabled)} muted=${String(track.muted)} ` +
          `${JSON.stringify(track.settings)}`
        : ' · 无本机轨'),
  );

  const mesh = diagnostics.mesh as Record<string, Record<string, unknown>> | null;
  for (const [peerId, info] of Object.entries(mesh ?? {})) {
    out.push(
      `链路 ${peerId.slice(0, 6)}：${String(info.connectionState)} ice=${String(info.iceConnectionState)} ` +
        `方向 ${String(info.desiredDirection)}→${String(info.currentDirection)} ` +
        `SDP 本地=${String(info.localSdpDirection)}/远端=${String(info.remoteSdpDirection)} ` +
        `修复尝试=${String(info.directionRepairAttempts)} ` +
        `发送轨=${String(info.hasSenderTrack)}(${String(info.senderTrackState)}, muted=${String(info.senderTrackMuted)}) ` +
        `曾挂载=${String(info.sentMedia)} 编码=${JSON.stringify(info.encoding)}`,
    );
    const localSdp = info.localVideoSdp as string[] | null;
    const remoteSdp = info.remoteVideoSdp as string[] | null;
    if (localSdp) out.push(`  本地 m=video: ${localSdp.join(' | ')}`);
    if (remoteSdp) out.push(`  远端 m=video: ${remoteSdp.join(' | ')}`);
  }
  return out;
}
