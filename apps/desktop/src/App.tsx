import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { PeerInfo, QualityLevel } from '@game-share/protocol';
import { DEFAULT_SIGNALING_URL } from '@game-share/shared';

import type {
  AudioCaptureMode,
  CaptureSourceInfo,
  EmbeddedServerStatus,
  FloatTilesStatus,
  FloatWindowStatus,
  TunnelStatus,
} from './types/global';
import type { LinkStats, RemoteTracks } from './rtc/types';
import { floatBallProps, floatDragProps, floatGripProps } from './float-drag';
import { ShareSession } from './session/ShareSession';
import type { ConnectionState } from './signaling/SignalingClient';

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: '未连接',
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
};

const LINK_LABEL: Record<string, string> = {
  new: '待建连',
  connecting: '协商中',
  connected: '已连接',
  disconnected: '中断',
  failed: '失败',
  closed: '已关闭',
};

/** 内置信令服务器的状态文案。'port-in-use' 不是故障，是本机已经有服务器了。 */
const SERVER_STATE_LABEL: Record<EmbeddedServerStatus['state'], string> = {
  running: '运行中',
  'port-in-use': '未启动',
  failed: '启动失败',
  stopped: '已关闭',
};

/** 异地访问隧道的状态文案 */
const TUNNEL_STATE_LABEL: Record<TunnelStatus['state'], string> = {
  stopped: '未开启',
  starting: '建立中…',
  running: '已就绪',
  failed: '失败',
};

/** 网格里每一路的档位 */
const GRID_QUALITY: QualityLevel = 'GRID';
/** 被放大那一路的档位 */
const FOCUS_QUALITY: QualityLevel = 'FOCUS';
/** 没被放大时其余几路的档位 */
const BACKGROUND_QUALITY: QualityLevel = 'THUMBNAIL';

type TileVariant = 'grid' | 'main' | 'thumb';

/**
 * 每个远端用户的**分轨**音量偏好：语音与应用（共享）声音各自独立。
 *
 * 两条轨性质不同 —— 语音是通信处理过的（AEC/NS/AGC），应用声音是原样回环 ——
 * 听的人也经常只想关掉其中一个（游戏声吵，但队友说话要听清）。
 * 音量只作用于本机 `<audio>` 元素，不发信令、不影响别人。
 */
interface PeerAudioPref {
  voiceVol: number;
  voiceMuted: boolean;
  appVol: number;
  appMuted: boolean;
}

const DEFAULT_PEER_AUDIO: PeerAudioPref = {
  voiceVol: 1,
  voiceMuted: false,
  appVol: 1,
  appMuted: false,
};

/** 共享声音的三种正式状态（任务书口径）；`loopback` 是调试模式，不进界面 */
const UI_AUDIO_MODES: Array<{ mode: AudioCaptureMode; label: string; title: string }> = [
  { mode: 'application', label: '仅此应用', title: '只共享所选窗口那个应用（及其子进程）的声音' },
  { mode: 'system', label: '全部电脑', title: '共享整机声音，但排除本软件自己播放的语音' },
  { mode: 'none', label: '无声', title: '只共享画面，不发送任何声音' },
];

/** 模式在状态 tag 里的短名 */
const AUDIO_MODE_LABEL: Partial<Record<AudioCaptureMode, string>> = {
  application: '应用声音',
  system: '全部声音',
  none: '无声音',
};

export default function App() {
  const [session] = useState(() => new ShareSession());
  const state = useSyncExternalStore(session.subscribe, session.getState);

  const [serverUrl, setServerUrl] = useState(DEFAULT_SIGNALING_URL);
  const [nickname, setNickname] = useState('');
  const [joinCode, setJoinCode] = useState('');
  // 加入失败要在界面上看得见：原先只写进默认收起的日志面板，
  // 满员被拒时表现成「点了加入没反应」，被当成 bug 报过（M3 待办）。
  const [joinError, setJoinError] = useState<string | null>(null);
  // 自己的预览格纯本地显示：隐藏它不碰任何轨与协商，别人照常看到你的画面。
  const [showSelf, setShowSelf] = useState(true);
  const [busy, setBusy] = useState(false);

  const [sources, setSources] = useState<CaptureSourceInfo[]>([]);
  const [sourceError, setSourceError] = useState<string | null>(null);
  /** 共享中也要能换源，这个开关控制换源面板的显隐 */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 当前正在共享的源 id，用来在列表里标出「当前」；停止共享后由下面的 effect 统一清掉 */
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, LinkStats>>({});
  const [embeddedServer, setEmbeddedServer] = useState<EmbeddedServerStatus | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  /** 异地访问隧道。默认关闭，只有用户点开关才会起 */
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  /**
   * 浮窗模式。全屏玩游戏时用 —— 快捷键那一步由主进程全局注册，
   * 这里只负责显示状态、调透明度，并给一个鼠标点得到的地方。
   *
   * 界面精简（藏侧栏、藏顶栏、只留正在共享的画面）这一半在渲染层做；
   * 窗口尺寸 / 置顶 / 透明度那一半在主进程做（见 electron/window-mode.ts）。
   */
  const [floatWindow, setFloatWindow] = useState<FloatWindowStatus | null>(null);
  const [floatBusy, setFloatBusy] = useState(false);

  /**
   * 浮窗的**拆分**模式：每一路远端画面变成一个独立小窗（窗数 = 总人数 − 1）。
   *
   * 权威状态在 `floatWindow.tilesEnabled`（主进程说了算），这里的 `tiles` 只用来
   * 显示「现在开着几个窗」。**注意它俩不能互相推导**：退出浮窗时主进程会把小窗
   * 一起收掉，两条状态得分别同步。
   */
  const [tiles, setTiles] = useState<FloatTilesStatus | null>(null);
  const [tilesBusy, setTilesBusy] = useState(false);

  /**
   * 画面区的实际像素尺寸。浮窗模式下按它算「几行几列能让每格最接近 16:9」——
   * 常规模式的网格每格写死最小 280x160，窗口缩小时不跟着缩，会撑破容器。
   */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  /* ---- 左侧折叠状态：默认全收，让核心操作在首屏就能看到 ---- */
  const [serverOpen, setServerOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [riskOpen, setRiskOpen] = useState(false);

  /**
   * 被静音的远端 peerId 集合。默认全不静音。
   *
   * 注意语义：这是**本机不听**这一路的声音，不影响对方、也不影响别人。
   * 之所以按「人」而不是按「窗口」静音，是因为 Windows 的 loopback 采的
   * 是整机混音 —— 一路共享里本来就只有一个人的全部声音，分不出来。
   */
  const [mutedPeers, setMutedPeers] = useState<ReadonlySet<string>>(() => new Set());

  /**
   * 远端分轨音量偏好（peerId → 偏好）。没出现的 peer 用 `DEFAULT_PEER_AUDIO`。
   *
   * 与 `mutedPeers` 的关系：`mutedPeers` 现在只服务浮窗小窗的一键静音
   * （那里面放不下两根滑杆）；常规网格里用这份细粒度偏好。
   */
  const [peerAudio, setPeerAudio] = useState<Record<string, PeerAudioPref>>({});
  /** 音量小面板当前展开在哪一个 tile 上；null = 全收起 */
  const [volPanelPeer, setVolPanelPeer] = useState<string | null>(null);

  /**
   * 共享声音的模式选择。**正式默认是「仅此应用声音」**（applicationLoopback:<pid>）——
   * 选中的是窗口就用它；屏幕源没有所属进程，那种源上这个选项不可用、落回「全部电脑」。
   * 这个选择在共享中也可以改，改了就按换源流程重采（画面会闪一下，语义最干净）。
   */
  const [audioModeChoice, setAudioModeChoice] = useState<AudioCaptureMode>('application');

  /** 被放大到主画面的那一路；null 表示网格布局 */
  const [focusedPeerId, setFocusedPeerId] = useState<string | null>(null);

  const serverUrlRef = useRef(serverUrl);
  serverUrlRef.current = serverUrl;

  const {
    connection,
    room,
    links,
    remoteStreams,
    remoteTracks,
    remoteSharing,
    sharing,
    captureLabel,
    hasAudio,
    appAudioEnabled,
    audioMode,
    audioFailure,
    micEnabled,
    micError,
    micSettings,
  } = state;
  const connected = connection.state === 'connected';
  const inRoom = room !== null;

  /** 隧道就绪时的公网地址 —— 异地唯一一条实测可用的路 */
  const tunnelUrl = tunnel?.state === 'running' ? tunnel.url : null;

  /**
   * 公网 IPv6 / IPv4 候选。
   *
   * **刻意不当异地首选**：本机是双层 NAT，路由器不放行入站时这条路完全不通，
   * 实测就没通。界面上必须写明「多数家庭网络连不上」，否则用户照着填、
   * 然后卡在「一直转圈」,而排查成本极高。真正的异地方案是隧道。
   */
  const publicServerUrls = embeddedServer
    ? [...embeddedServer.publicV6Urls, ...embeddedServer.publicV4Urls]
    : [];

  /** 邀请信息里给对方填的信令地址：隧道优先，其次同一局域网 */
  const inviteAddress =
    tunnelUrl ?? embeddedServer?.lanUrls[0] ?? embeddedServer?.localUrl ?? null;

  /* ---------------- 内置信令服务器 ---------------- */

  useEffect(() => {
    const api = window.gameShare?.server;
    // 纯浏览器里跑渲染层（vite 直开）时没有 preload，整块不显示
    if (!api) return undefined;

    let alive = true;
    void api.getStatus().then((status) => {
      if (alive) setEmbeddedServer(status);
    });
    // 端口被占用、启停这些变化由主进程推过来，不做轮询
    const unsubscribe = api.onStatus((status) => setEmbeddedServer(status));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const handleToggleServer = useCallback(async (enabled: boolean): Promise<void> => {
    const api = window.gameShare?.server;
    if (!api) return;
    setServerBusy(true);
    try {
      setEmbeddedServer(await api.setEnabled(enabled));
    } finally {
      setServerBusy(false);
    }
  }, []);

  /* ---------------- 异地访问隧道 ---------------- */

  useEffect(() => {
    const api = window.gameShare?.tunnel;
    // 纯浏览器里跑渲染层（vite 直开）时没有 preload，整块不显示
    if (!api) return undefined;

    let alive = true;
    void api.getStatus().then((status) => {
      if (alive) setTunnel(status);
    });
    // 隧道地址由主进程解析出来后再推过来，这里不做轮询
    const unsubscribe = api.onStatus((status) => setTunnel(status));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const handleToggleTunnel = useCallback(async (enabled: boolean): Promise<void> => {
    const api = window.gameShare?.tunnel;
    if (!api) return;
    setTunnelBusy(true);
    try {
      setTunnel(await api.setEnabled(enabled));
    } finally {
      setTunnelBusy(false);
    }
  }, []);

  /* ---------------- 浮窗模式 ---------------- */

  useEffect(() => {
    const api = window.gameShare?.windowMode;
    if (!api) return undefined;

    let alive = true;
    void api.getStatus().then((status) => {
      if (alive) setFloatWindow(status);
    });
    // 快捷键是主进程里处理的，切完必须由它推回来 ——
    // 否则用键盘切过了，界面上的开关还停在旧状态
    const unsubscribe = api.onStatus((status) => setFloatWindow(status));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const isFloat = floatWindow?.enabled === true;

  const handleToggleFloat = useCallback(async (enabled: boolean): Promise<void> => {
    const api = window.gameShare?.windowMode;
    if (!api) return;
    setFloatBusy(true);
    try {
      setFloatWindow(await api.setEnabled(enabled));
    } finally {
      setFloatBusy(false);
    }
  }, []);

  /**
   * 透明度滑杆。拖动会连续触发，主进程那边攒着写盘，
   * 所以这里刻意不做防抖 —— 防抖会让滑杆拖起来发黏。
   */
  const handleOpacity = useCallback(async (value: number): Promise<void> => {
    const api = window.gameShare?.windowMode;
    if (!api) return;
    setFloatWindow(await api.setOpacity(value));
  }, []);

  /**
   * 浮窗模式下测量画面区的像素尺寸，用来算行列数。
   *
   * 只在浮窗模式观察：常规模式的网格是 CSS 响应式布局（自己会排），
   * 用不上这个，白挂一个观察器只是浪费。
   */
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !isFloat) return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setStageSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isFloat]);

  /**
   * 复制一条完整的邀请信息。
   *
   * 地址和房间码分两次复制，对方就得在两个格子里各填一次；合成一条文本发过去，
   * 对面照着填完就能进 —— 少一次「你等一下我看下地址」的往返。
   */
  /**
   * 刚复制成功的是哪个按钮，用来在按钮上闪一下「已复制」。
   *
   * 剪贴板是看不见的：复制成功时界面如果一点动静都没有，用户没法判断到底成了没有
   * —— 只会以为按钮还是坏的（这正是 2026-09-17 那次反馈的一半原因）。
   */
  const [copied, setCopied] = useState<'code' | 'invite' | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashCopied = useCallback((which: 'code' | 'invite'): void => {
    setCopied(which);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 1400);
  }, []);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  /**
   * 把一段文本写进系统剪贴板，成功为 true。
   *
   * 走主进程的 `clipboard` 模块（`clipboard:write-text`），**不要图省事换成
   * 渲染层的 `navigator.clipboard.writeText`** —— 实测两条都堵死：
   *   1. 主进程的权限白名单只放行 media / display-capture，剪贴板写入权限会被
   *      直接拒掉，抛 `NotAllowedError: Write permission denied`，而这里要是
   *      只 catch 成一行日志，按钮就变成「看着能点、按下去没反应」；
   *   2. 放开白名单也救不了浮窗模式 —— 那边窗口 `setFocusable(false)`，
   *      写入会改成抛 `Document is not focused`，而浮窗恰恰是最想复制房间码的场景。
   * 主进程那条路既不看权限也不看焦点，两种模式都覆盖。实测见 `scripts/_probe-clipboard.cjs`。
   */
  const writeClipboard = useCallback(async (text: string): Promise<boolean> => {
    const api = window.gameShare?.clipboard;
    if (!api) return false;
    try {
      return await api.writeText(text);
    } catch {
      return false;
    }
  }, []);

  const copyInvite = useCallback(async (): Promise<void> => {
    if (!room || !inviteAddress) return;
    const text = [
      '一起看画面 —— GameShare 客户端',
      `信令地址：${inviteAddress}`,
      `房间码：${room.roomCode}`,
    ].join('\n');
    if (await writeClipboard(text)) {
      session.pushLog('邀请信息已复制（信令地址 + 房间码）');
      flashCopied('invite');
    } else {
      session.pushLog('复制失败，请手动记录信令地址和房间码');
    }
  }, [room, inviteAddress, session, writeClipboard, flashCopied]);

  /* ---------------- 链路统计轮询 ---------------- */

  useEffect(() => {
    if (!inRoom) {
      setStats({});
      return;
    }

    let cancelled = false;
    const tick = async (): Promise<void> => {
      const mesh = session.mesh;
      if (!mesh) return;
      const next: Record<string, LinkStats> = {};
      await Promise.all(
        mesh.peerIds.map(async (peerId) => {
          const link = mesh.getLink(peerId);
          if (!link) return;
          next[peerId] = await link.readStats();
        }),
      );
      if (!cancelled) setStats(next);
    };

    void tick();
    const timer = setInterval(() => void tick(), 1_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [inRoom, session, room?.peers.length]);

  /* ---------------- 操作 ---------------- */

  const handleConnect = useCallback(() => {
    if (connected || connection.state === 'connecting') {
      session.disconnect();
      return;
    }
    session.connect(serverUrl.trim() || DEFAULT_SIGNALING_URL);
  }, [connected, connection.state, serverUrl, session]);

  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        session.pushLog(`操作失败：${ShareSession.describeError(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  const refreshSources = useCallback(async () => {
    setSourceError(null);
    try {
      const list = await session.capture.listSources();
      // 桌面本身放最前面，多数情况下用户要共享的是整屏
      setSources([...list].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1)));
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : String(err));
    }
  }, [session]);

  // 停止共享的入口不止一个（手动停、被共享的窗口被关掉、换源失败），
  // 与其在每个入口各清一遍 activeSourceId，不如让 sharing 变 false 时统一收口。
  useEffect(() => {
    if (!sharing) setActiveSourceId(null);
  }, [sharing]);

  // 成功进房就清掉上一次的加入失败提示，否则离开房间后又会看到旧错误。
  useEffect(() => {
    if (inRoom) setJoinError(null);
  }, [inRoom]);

  const pickSource = useCallback(
    async (sourceId: string) => {
      setBusy(true);
      setSourceError(null);
      try {
        // 屏幕源没有所属进程，「仅此应用」对它不可用 —— 显式落回「全部电脑」，
        // 并把选择器同步过去（界面上能看到当前生效项，不是静默改选择）。
        const src = sources.find((s) => s.id === sourceId);
        const mode =
          src?.kind === 'screen' && audioModeChoice === 'application'
            ? 'system'
            : audioModeChoice;
        if (mode !== audioModeChoice) setAudioModeChoice(mode);
        await session.startShare({ sourceId, audioMode: mode });
        setActiveSourceId(sourceId);
        setPickerOpen(false);
      } catch (err) {
        // 保持面板打开，让用户能立刻改选另一个源。
        // 换源失败时共享还留着（画面没断），文案要跟首次失败区分开。
        const kept = session.getState().sharing;
        setSourceError(
          (kept ? '切换失败，已保留原共享：' : '') +
            (err instanceof Error ? err.message : String(err)),
        );
      } finally {
        setBusy(false);
      }
    },
    [session, sources, audioModeChoice],
  );

  /** 共享中改音频模式 = 按换源流程用同一个源重采（画面会闪一下，但语义最干净） */
  const changeAudioMode = useCallback(
    (mode: AudioCaptureMode) => {
      setAudioModeChoice(mode);
      if (!activeSourceId) return;
      setBusy(true);
      void session
        .startShare({ sourceId: activeSourceId, audioMode: mode })
        .catch(() => undefined)
        .finally(() => setBusy(false));
    },
    [session, activeSourceId],
  );

  /** 用户在音频失败告警里点了「继续无声共享」：确认当前状态，收起告警 */
  const dismissAudioFailure = useCallback((): void => {
    session.acknowledgeAudioFailure();
  }, [session]);

  const toggleSourcePicker = useCallback(async () => {
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    setPickerOpen(true);
    // 打开时重新枚举：共享期间目标窗口可能刚开或刚关
    await refreshSources();
  }, [pickerOpen, refreshSources]);

  const copyRoomCode = useCallback(async () => {
    if (!room) return;
    if (await writeClipboard(room.roomCode)) {
      session.pushLog('房间码已复制到剪贴板');
      flashCopied('code');
    } else {
      session.pushLog('复制失败，请手动记录房间码');
    }
  }, [room, session, writeClipboard, flashCopied]);

  const members: PeerInfo[] = room ? [room.self, ...room.peers] : [];
  const remotePeers = useMemo(() => (room ? room.peers : []), [room]);

  /* ---------------- 静音 ---------------- */

  const toggleMute = useCallback((peerId: string): void => {
    setMutedPeers((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
      return next;
    });
  }, []);

  /** 远端这一路到底有没有声音 —— 没有就不显示静音按钮，免得按了没反应 */
  const peerHasAudio = useCallback(
    (peerId: string): boolean => {
      const stream = remoteStreams[peerId];
      return Boolean(stream && stream.getAudioTracks().some((t) => t.readyState === 'live'));
    },
    [remoteStreams],
  );

  /** 读某人的分轨偏好（没设置过就给默认值） */
  const peerAudioOf = useCallback(
    (peerId: string): PeerAudioPref => peerAudio[peerId] ?? DEFAULT_PEER_AUDIO,
    [peerAudio],
  );

  /** 改某人的分轨偏好（函数式更新，滑杆拖动时不会互相踩） */
  const setPeerAudioOf = useCallback((peerId: string, patch: Partial<PeerAudioPref>): void => {
    setPeerAudio((prev) => ({
      ...prev,
      [peerId]: { ...(prev[peerId] ?? DEFAULT_PEER_AUDIO), ...patch },
    }));
  }, []);

  /* ---------------- 放大 ---------------- */

  /**
   * 双击放大规则（对应 ARCHITECTURE.md 4.10）：
   * - 双击任意远端画面进入单路主画面，其余收进底部缩略条
   * - 再双击主画面、按 Esc、或点缩略条里的任意一路都会切换回去
   * - 同时只允许放大一路；本地预览不可放大（看自己没有意义）
   * - 画质联动见下面的 effect
   */
  const toggleFocus = useCallback((peerId: string): void => {
    setFocusedPeerId((prev) => (prev === peerId ? null : peerId));
  }, []);

  // 被放大的那个人离开房间 → 自动退回网格，否则主画面会永久空着
  useEffect(() => {
    if (focusedPeerId && !remotePeers.some((p) => p.peerId === focusedPeerId)) {
      setFocusedPeerId(null);
    }
  }, [focusedPeerId, remotePeers]);

  useEffect(() => {
    if (!focusedPeerId) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFocusedPeerId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedPeerId]);

  /**
   * 放大的画质联动。
   *
   * 源端对每一路观看者独立编码，所以「我放大谁」只影响「他 → 我」这一条链路，
   * 别人看到的档位不受影响。之所以顺手把其余几路降到 THUMBNAIL：
   * 四人场景下三路 540p 已经吃掉大半上行，不降档的话放大这一路也拿不到 1080p。
   * 还原时统一回 GRID。
   *
   * 请求是幂等的，所以成员变化时整轮重发一次，顺便把新加入的人带上正确档位。
   */
  useEffect(() => {
    if (!inRoom) return;
    for (const peer of remotePeers) {
      const level =
        focusedPeerId === null
          ? GRID_QUALITY
          : peer.peerId === focusedPeerId
            ? FOCUS_QUALITY
            : BACKGROUND_QUALITY;
      session.requestQualityFrom(peer.peerId, level);
    }
  }, [focusedPeerId, inRoom, session, remotePeers]);

  /* ---------------- 渲染 ---------------- */

  // 共享状态下这套列表要能反复用（initial 选源 / 共享中换源），抽出来避免两处各写一遍
  const sourceList = sources.length > 0 && (
    <>
      <ul className="sources">
        {sources.map((source) => {
          const active = sharing && source.id === activeSourceId;
          return (
            <li key={source.id} className="source">
              <button
                type="button"
                className={active ? 'source__btn source__btn--active' : 'source__btn'}
                onClick={() => void pickSource(source.id)}
                disabled={busy}
              >
                {source.thumbnail ? (
                  <img className="source__thumb" src={source.thumbnail} alt="" />
                ) : (
                  <span className="source__thumb source__thumb--empty" />
                )}
                <span className="source__name">
                  <span className={`tag tag--${source.kind}`}>
                    {source.kind === 'screen' ? '屏幕' : '窗口'}
                  </span>
                  {source.name}
                  {active && <span className="tag tag--live">当前</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {/* 这条是实测出来的：Chromium 枚举窗口时会跳过已最小化的窗口，
          连列表都不给，用户只会看到「明明开着却找不到」。
          最小化的窗口 Windows 层面也抓不到，所以只能这么提示。
          注意别把判据说成「全屏」—— 实测全屏（无边框）照样能抓，
          被盖住也能抓，只有最小化是死路。 */}
      <p className="hint hint--dim">
        找不到某个窗口？<strong>已最小化的窗口不会出现在这里</strong>，Windows 层面也抓不到它 ——
        切回前台再点「枚举」。全屏、被别的窗口盖住都不影响捕获。
      </p>
    </>
  );

  const renderSelfTile = (variant: TileVariant) => (
    <VideoTile
      key="self"
      peerId={room?.self.peerId ?? 'self'}
      title={`${room?.self.nickname ?? '我'}（本地预览）`}
      stream={session.capture.stream}
      linkState="connected"
      stats={null}
      self
      sharing
      // 自己这一路必须恒定静音：本机同时播放自己的系统声音会变成双份回声
      //（VideoTile 内部对 self 直接静 video，不需要额外属性）
      hasAudio={hasAudio}
      variant={variant}
    />
  );

  const renderRemoteTile = (peer: PeerInfo, variant: TileVariant) => (
    <VideoTile
      key={peer.peerId}
      peerId={peer.peerId}
      title={peer.nickname}
      stream={remoteStreams[peer.peerId] ?? null}
      /**
       * 把 `<video>` 注册给拆分模式的帧泵。
       *
       * 不加条件：反正只有拆分模式下帧泵才会跑，而多注册一份没有任何代价。
       * 少写一个判断，也少一个「哪个分支忘了传」的出错点。
       */
      onVideoEl={videoElRef(peer.peerId)}
      linkState={links[peer.peerId]?.state ?? 'new'}
      detail={links[peer.peerId]?.detail}
      stats={stats[peer.peerId] ?? null}
      remoteSharing={Boolean(remoteSharing[peer.peerId])}
      /**
       * 远端三条轨按角色传下去。
       *
       * 这样播放层就不必再去 `stream.getAudioTracks()` 按下标猜哪条是语音 ——
       * 下标顺序在轨道增删后会变，角色不会。
       */
      tracks={remoteTracks[peer.peerId] ?? null}
      hasAudio={peerHasAudio(peer.peerId)}
      audioPref={peerAudioOf(peer.peerId)}
      onAudioPref={(patch) => setPeerAudioOf(peer.peerId, patch)}
      volOpen={volPanelPeer === peer.peerId}
      onToggleVolPanel={() => setVolPanelPeer((v) => (v === peer.peerId ? null : peer.peerId))}
      focused={focusedPeerId === peer.peerId}
      onToggleFocus={() => toggleFocus(peer.peerId)}
      variant={variant}
    />
  );

  /**
   * 浮窗模式下只摆**正在共享**的那几路。
   *
   * 浮窗的卖点是「小、不挡游戏」，没在共享的格子空占一块地方等于白占；
   * 常规模式照旧显示全部成员（那时要看的是「谁在线」）。
   */
  const floatPeers = useMemo(
    () => (isFloat ? remotePeers.filter((peer) => remoteSharing[peer.peerId]) : []),
    [isFloat, remotePeers, remoteSharing],
  );

  /** 浮窗里的行列数：在给定容器里挑一个让每格最接近 16:9 的排法 */
  const floatGrid = useMemo(
    () => pickFloatGrid(stageSize.width, stageSize.height, floatPeers.length),
    [stageSize, floatPeers.length],
  );

  /* ------------------------------------------------------------------ *
   * 拆分模式（浮窗的子模式）：每一路远端画面拆成一个可独立拖动的小窗
   *
   * 窗数是**总人数 − 1**（自己那一路本地预览就能看，不必再为它开一个窗）。
   * 窗口本身由主进程创建和摆放（见 `electron/float-tiles.ts`），渲染层只做两件事：
   *
   *   1. 告诉主进程「对端有谁」—— 顺序即位置，小窗按序号对号入座；
   *   2. **当帧泵**：小窗拿不到媒体轨道（`MediaStreamTrack` 不是可转移对象，
   *      过不了进程边界，实测见 float-tiles.ts 顶部），画面只能由主窗口从自己的
   *      `<video>` 里抽帧、缩放成 `ImageBitmap`、经 MessagePort 搬过去。
   *
   * 代价写在明处：**画面和声音都只能从主窗口出发**，所以拆分之后主窗口会被收成
   * 一条贴屏幕底部的窄控制条，不能关也不能最小化 —— 它同时是这台机器的
   * 「声音 + 房间码 + 合并按钮」。见下面 hostbar 那段。
   * ------------------------------------------------------------------ */

  /**
   * 拆分是否正在生效。
   *
   * 判据取 `floatTiles` 自己的状态，而不是 `FloatWindowStatus.tilesEnabled`：
   * 后者是主进程在重播浮窗状态时顺带带出来的一份拷贝，而前者每次变化都会推、
   * 还随状态带着小窗清单 —— 界面只认完整的那一份就够了。
   */
  const splitActive = isFloat && tiles?.enabled === true;

  /**
   * 小窗清单的最新值，给帧泵里的循环读。
   *
   * 刻意不进帧泵的 effect 依赖：主进程每次广播都会新建一个数组对象，
   * 直接依赖它等于让每次无关的广播都重建一轮帧泵。
   */
  const tilesRef = useRef<FloatTilesStatus | null>(null);
  tilesRef.current = tiles;

  /**
   * 小窗清单的「身份」：序号 + 对端。
   *
   * 内容没变时它的值就不变 —— 这才是帧泵该重建的判据（换了对端 / 多了一个 / 少了一个）。
   */
  const tileKey = splitActive
    ? (tiles?.tiles ?? []).map((tile) => `${tile.index}:${tile.peerId}`).join('|')
    : '';

  /**
   * 帧泵用的三张表。
   *
   * 全部放 ref 不放 state：帧泵每帧都要读它们，而它们的变化（小窗被拖大改尺寸、
   * 通道被重建）来得频繁、又完全不影响界面 —— 进 state 只是白白重渲染整个客户端。
   *
   * - `tilePortsRef`：每个小窗一条 `MessagePort`（按序号记）。**`ImageBitmap` 只有
   *   走 MessagePort 的 transfer list 才能零拷贝搬过去**，`ipcRenderer` 的结构化
   *   克隆搬不了 DOM 对象。
   * - `tileSizeRef`：小窗客户区的像素尺寸，帧泵按它缩放。
   * - `videoElsRef`：对端 id → 主窗口里那个 `<video>`。帧泵就是从这里抽帧的。
   */
  const tilePortsRef = useRef<Map<number, MessagePort>>(new Map());
  const tileSizeRef = useRef<Map<number, { width: number; height: number }>>(new Map());
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());

  /**
   * 通道比小窗清单晚到 —— 小窗得先把页面加载起来，主进程才会建通道。
   * 这个计数器就是「新通道到了」的信号，用来把帧泵叫醒。
   */
  const [tileEpoch, setTileEpoch] = useState(0);

  /**
   * `VideoTile` 的 `<video>` 注册入口，按对端缓存一份。
   *
   * **必须缓存**：每次渲染都新建一个函数的话，React 会在每次渲染时先拿旧函数
   * 回调一次 `null`、再用新函数回调元素；帧泵恰好在这个窗口期读 `videoElsRef`
   * 就会读到空的 —— 表现是「小窗全是黑的，但什么都不报错」，最难查的那一类。
   */
  const videoElRefs = useRef<Map<string, (el: HTMLVideoElement | null) => void>>(new Map());
  const videoElRef = useCallback((peerId: string) => {
    const cached = videoElRefs.current.get(peerId);
    if (cached) return cached;
    const callback = (el: HTMLVideoElement | null): void => {
      if (el) videoElsRef.current.set(peerId, el);
      else videoElsRef.current.delete(peerId);
    };
    videoElRefs.current.set(peerId, callback);
    return callback;
  }, []);

  /**
   * 订阅小窗状态与画面通道。
   *
   * 必须订阅而不是只读一次：小窗是**主进程**开的，用户还能直接把它关掉
   * （或者被系统收掉），不跟着走的话界面会一直显示「开着 3 个窗」而实际只剩 1 个。
   */
  useEffect(() => {
    const api = window.gameShare?.floatTiles;
    if (!api) return undefined;

    let alive = true;
    void api.getStatus().then((status) => {
      if (alive) setTiles(status);
    });
    const offStatus = api.onStatus((status) => setTiles(status));
    const offPort = api.onTilePort((port, meta) => {
      tilePortsRef.current.set(meta.index, port);
      setTileEpoch((n) => n + 1);
    });

    return () => {
      alive = false;
      offStatus();
      offPort();
    };
  }, []);

  /**
   * 小窗尺寸。只写 ref、不进 state —— 拖动小窗时这个事件是连续的，
   * 进 state 等于每拖一下就重渲染整个客户端，而界面上根本不显示这个数字。
   */
  useEffect(() => {
    const api = window.gameShare?.floatTiles;
    if (!api) return undefined;
    return api.onTileSize((info) => {
      tileSizeRef.current.set(info.index, { width: info.width, height: info.height });
    });
  }, []);

  /**
   * 小窗上按了「静音这一路」。
   *
   * 小窗里**没有声音**（音轨同样过不去），它只是个开关 —— 真正切的是主窗口里
   * 那个 `<video>.muted`。静音是**纯本机状态**、不发信令，这条与单窗口时一致。
   */
  useEffect(() => {
    const api = window.gameShare?.floatTiles;
    if (!api) return undefined;
    return api.onToggleMuteRequest((peerId) => toggleMute(peerId));
  }, [toggleMute]);

  /** 要报给主进程的对端清单：顺序即位置，静音状态一起带上（小窗上的按钮照着它显示） */
  const tilePeersPayload = useCallback(
    (): Array<{ peerId: string; name: string; muted: boolean }> =>
      floatPeers.map((peer) => ({
        peerId: peer.peerId,
        name: peer.nickname,
        muted: mutedPeers.has(peer.peerId),
      })),
    [floatPeers, mutedPeers],
  );

  /**
   * 对端清单或静音状态一变就整轮重报。
   *
   * 主进程那边是**幂等对齐**：多了就建、少了就关、同一个位置换了人只换内容不重建窗口
   * （重建会丢掉用户拖出来的位置）。所以这里可以放心地每次重报一遍。
   */
  useEffect(() => {
    if (!splitActive || !inRoom) return;
    const api = window.gameShare?.floatTiles;
    if (!api) return;
    void api.syncPeers(tilePeersPayload()).then(setTiles);
  }, [splitActive, inRoom, tilePeersPayload]);

  const handleToggleTiles = useCallback(
    async (enabled: boolean): Promise<void> => {
      const api = window.gameShare?.floatTiles;
      if (!api) return;
      setTilesBusy(true);
      try {
        if (enabled) {
          // 先喂清单再开模式：主进程开模式时会立刻按清单建窗，反过来的话会先开成
          // 一个「一个窗都没有」的空状态，小窗要等下一轮广播才出来。
          await api.syncPeers(tilePeersPayload());
        }
        setTiles(await api.setEnabled(enabled));
      } finally {
        setTilesBusy(false);
      }
    },
    [tilePeersPayload],
  );

  /**
   * 收起 / 展开那条控制条（缩成贴右下角的一颗小球）。
   *
   * **界面不自己先切**：窗口尺寸是主进程改的，先切成小球会出现一帧「小球画在一条
   * 620x76 的窗口里」。等 `float:tiles-status` 把 `barCollapsed` 推回来再切 ——
   * `invoke` 的返回值就是新状态，所以这一句就够了（广播那份是幂等的）。
   */
  const handleToggleBarCollapsed = useCallback(async (collapsed: boolean): Promise<void> => {
    const api = window.gameShare?.floatTiles;
    if (!api) return;
    setTiles(await api.setBarCollapsed(collapsed));
  }, []);

  /** 收起态：主窗口已经缩成右下角那颗小球了 */
  const barCollapsed = splitActive && tiles?.barCollapsed === true;

  /**
   * 浮窗那条控件是否被点开了（左上角那个 `.floatmenu` 就是它的开关）。
   *
   * 做成有状态的开关、而不是纯 hover 浮出，是这次反馈直接换来的：
   * hover 才浮出来的控件，用户根本不知道有它，只能去记快捷键。
   */
  const [floatMenuOpen, setFloatMenuOpen] = useState(false);

  /**
   * 这个展开状态只对「浮窗且没拆分」这一种形态有意义 —— 拆分了是另一条常驻控制条，
   * 退出浮窗了更用不上。不跟着收回去的话，下次再进浮窗会一进去就摊着一条控件。
   */
  useEffect(() => {
    if (!isFloat || splitActive) setFloatMenuOpen(false);
  }, [isFloat, splitActive]);

  /**
   * 小球上的拖动 props：**按住能拖，松手没动过就算点了一下**（展开）。
   *
   * 锁住引用是为了让拖动期间拿到的一直是同一份（拖动状态在模块级，不影响正确性，
   * 只是不给它每次渲染都换一个闭包）。
   */
  const ballDragProps = useMemo(
    () => floatBallProps(() => void handleToggleBarCollapsed(false)),
    [handleToggleBarCollapsed],
  );

  /**
   * 帧泵：把主窗口里每一路的画面按小窗的尺寸抽帧送过去。
   *
   * 几处不能随便改的地方：
   *
   * - **按源的节奏走**（`requestVideoFrameCallback`），不按屏幕刷新率。用
   *   `requestAnimationFrame` 驱动会在 60Hz 屏上把同一帧重复发两遍，白烧一倍带宽
   *   —— 这个坑在探测脚本里踩过，量出来是假的「120fps」。
   * - **缩放到小窗的实际像素、且不放大**（`Math.min(..., 1)`）。小窗被拖大之后
   *   是它自己把整幅画面拉满，仍然清晰 —— 因为每帧都是从源的分辨率重新缩的，
   *   而不是把一张已经缩小过的图放大。窗口比例与画面比例不一致时留黑边
   *   （由小窗那侧居中补齐），**不把画面拉变形**：看游戏时变形比黑边难受得多。
   * - **同时只允许一帧在途**：`createImageBitmap` 是异步的，不拦着的话源一快
   *   就会堆起一串待处理的位图。
   * - 通道按**序号**记；小窗页面一重载主进程就会重连通道，所以每轮都从 ref 里
   *   取最新那条（`tileEpoch` 就是干这个用的）。
   */
  useEffect(() => {
    if (!splitActive) return undefined;
    const list = tilesRef.current?.tiles ?? [];
    if (list.length === 0) return undefined;

    const stops: Array<() => void> = [];

    for (const tile of list) {
      const video = videoElsRef.current.get(tile.peerId);
      const port = tilePortsRef.current.get(tile.index);
      // 小窗刚建出来时通道还没到，等 tileEpoch 变化后重建这一轮
      if (!video || !port) continue;

      /**
       * 端口必须是**真端口**。
       *
       * `MessagePort` 过不了 `contextBridge`：主窗口的 `contextIsolation` 一旦被改回 true，
       * 交到这里的就变成一个**没有方法的空普通对象** —— 而判空是过不去的（空对象是真值），
       * 之后每一帧都在 `postMessage` 上抛 TypeError、又被下面的 catch 吃掉，
       * 表现就是「小窗全黑、控制台一句话都没有」。2026-09-17 实测就是这么踩了一整轮，
       * 所以这里显式认一次：认出来就写进日志，别再让它静默失效。
       */
      if (typeof port.postMessage !== 'function') {
        session.pushLog(
          `第 ${tile.index + 1} 路画面的通道不可用（拿到的端口没有 postMessage）—— 那个小窗会一直停在「等待画面」。多半是主窗口的 contextIsolation 被打开了`,
        );
        continue;
      }

      // 每个小窗一张画布。**不能共用**：`createImageBitmap` 读的是画布当前的内容，
      // 共用的话几个泵会互相覆盖，画出来的可能是别人的帧（而且是偶发的那种）。
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) continue;

      let cancelled = false;
      let handle = 0;
      let inFlight = false;

      const pump = (): void => {
        if (cancelled) return;
        // 先把下一帧排上再干活：源是 30fps、下面这段最多几毫秒，不会因此漏帧；
        // 反过来（干完再排）一旦某帧超时就会连丢两帧。
        handle = video.requestVideoFrameCallback(pump);
        if (inFlight) return;

        const srcW = video.videoWidth;
        const srcH = video.videoHeight;
        if (srcW === 0 || srcH === 0) return;

        // 尺寸优先用渲染层报上来的客户区尺寸；还没报就用主进程记的窗口尺寸；
        // 两个都没有才退回源尺寸（这时按原分辨率搬，偏大但不会错）
        const reported = tileSizeRef.current.get(tile.index);
        const box =
          reported ?? (tile.width > 0 && tile.height > 0 ? tile : { width: srcW, height: srcH });
        const scale = Math.min(box.width / srcW, box.height / srcH, 1);
        const width = Math.max(2, Math.round(srcW * scale));
        const height = Math.max(2, Math.round(srcH * scale));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        ctx.drawImage(video, 0, 0, width, height);

        inFlight = true;
        void createImageBitmap(canvas)
          .then((bitmap) => {
            inFlight = false;
            if (cancelled) {
              bitmap.close();
              return;
            }
            // 转移、不是拷贝：位图在 transfer list 里零拷贝过去，本地这份随即作废
            port.postMessage({ bmp: bitmap }, [bitmap]);
          })
          .catch(() => {
            inFlight = false;
          });
      };

      handle = video.requestVideoFrameCallback(pump);
      stops.push(() => {
        cancelled = true;
        video.cancelVideoFrameCallback(handle);
      });
    }

    return () => {
      for (const stop of stops) stop();
    };
    // `session` 稳定（useState 初值），进依赖只是为了上面那条「端口不可用」的日志
  }, [splitActive, tileKey, tileEpoch, session]);

  /**
   * 窗口是否最大化 —— 只用来决定顶栏那个按钮画「□」还是「❐」。
   *
   * 主窗口是 `frame: false` 的，最大化/还原也是我们自己发的（顶栏那个按钮），
   * 但**双击顶栏拖动区同样会最大化** —— 那是系统行为，不经过我们的按钮。
   * 所以这个值只能听主进程回报，自己记的话图标立刻就说反话。
   */
  const [winMaximized, setWinMaximized] = useState(false);
  useEffect(() => window.gameShare?.windowControl?.onMaximized(setWinMaximized), []);

  return (
    <div className={isFloat ? 'app app--float' : 'app'}>
      <header className="app__header">
        <div className="app__title">
          <span className="app__logo">◧</span>
          <div>
            <h1>GameShare</h1>
            <p className="app__subtitle">多人异地游戏画面共享 · V0.1</p>
          </div>
        </div>

        <div className="app__header-right">
          {/* 浮窗模式：全屏游戏时用。快捷键在主进程里全局注册，这里只管显示状态。
              多开客户端时快捷键只有一个窗口抢得到，抢不到就如实标出来 ——
              否则用户按了没反应，只会以为是软件坏了。
              进浮窗后这条顶栏整个会藏起来，退出走快捷键或画面上的悬浮控件。 */}
          {floatWindow && (
            <label
              className="switch switch--boxed"
              title={
                floatWindow.hotkeyAvailable
                  ? `全屏游戏时按 ${floatWindow.hotkey.replace('Control+Alt+', 'Ctrl+Alt+')} 一键切换：窗口缩小、压在游戏上面、只留正在共享的画面。位置直接拖浮窗里的画面挪，大小拖右下角那个小三角；透明度在浮窗里的滑杆上调。只能压住无边框 / 窗口化全屏的游戏，独占全屏的要在游戏设置里改成无边框窗口化`
                  : '快捷键被别的窗口占用了（同时开多个客户端时只有一个能拿到），这里点开关作用一样'
              }
            >
              <input
                type="checkbox"
                checked={floatWindow.enabled}
                disabled={floatBusy}
                onChange={(e) => void handleToggleFloat(e.target.checked)}
              />
              <span>浮窗模式</span>
              {floatWindow.hotkeyAvailable ? (
                <span className="tag">{floatWindow.hotkey.replace('Control+Alt+', 'Ctrl+Alt+')}</span>
              ) : (
                <span className="tag tag--warn">快捷键冲突</span>
              )}
            </label>
          )}

          <div className={`status status--${connection.state}`}>
            <span className="status__dot" />
            <span>{STATE_LABEL[connection.state]}</span>
            {connection.rttMs !== null && <span className="status__rtt">{connection.rttMs} ms</span>}
          </div>

          {/* 窗口按钮。主窗口是 `frame: false` 的（见 electron/main.ts 里 frame 那段：
              原生标题栏在浮窗模式下拖不动，索性整个去掉），所以这三格得自己画。 */}
          <div className="winctl">
            <button
              type="button"
              className="winctl__btn"
              onClick={() => window.gameShare?.windowControl?.minimize()}
              title="最小化"
            >
              <span className="winctl__glyph winctl__glyph--min" />
            </button>
            <button
              type="button"
              className="winctl__btn"
              onClick={() => window.gameShare?.windowControl?.toggleMaximize()}
              title={winMaximized ? '还原' : '最大化'}
            >
              <span
                className={`winctl__glyph ${winMaximized ? 'winctl__glyph--restore' : 'winctl__glyph--max'}`}
              />
            </button>
            <button
              type="button"
              className="winctl__btn winctl__btn--close"
              onClick={() => window.gameShare?.windowControl?.close()}
              title="关闭"
            >
              <span className="winctl__glyph winctl__glyph--close" />
            </button>
          </div>
        </div>
      </header>

      <main className="app__body">
        <div className="app__side">
          {/* ---- 连接：地址和昵称各一行输入框，其余信息全部让位 ---- */}
          <section className="panel panel--tight">
            <div className="row">
              <input
                className="field__input field__input--compact"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                disabled={connected || connection.state === 'connecting'}
                spellCheck={false}
                placeholder={DEFAULT_SIGNALING_URL}
                title="信令服务器地址"
              />
              <button
                type="button"
                className={connected ? 'btn btn--ghost btn--shrink' : 'btn btn--primary btn--shrink'}
                onClick={handleConnect}
              >
                {connected || connection.state === 'connecting' ? '断开' : '连接'}
              </button>
            </div>

            {!inRoom && (
              <input
                className="field__input field__input--compact"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={16}
                placeholder="昵称（留空自动生成）"
              />
            )}

            {connection.detail && <p className="hint hint--warn">{connection.detail}</p>}
          </section>

          {/* ---- 本机信令 + 异地访问：合成一条状态栏，默认收起 ---- */}
          {embeddedServer && (
            <section className="panel panel--tight">
              <div className="collapse__head">
                <button
                  type="button"
                  className="collapse__toggle"
                  onClick={() => setServerOpen((v) => !v)}
                >
                  <span className="collapse__caret">{serverOpen ? '▾' : '▸'}</span>
                  <span>本机信令服务</span>
                  <span
                    className={`dot dot--${
                      embeddedServer.state === 'running' ? 'ok' : 'idle'
                    }`}
                  />
                  <span className="collapse__state">
                    {SERVER_STATE_LABEL[embeddedServer.state]}
                    {tunnelUrl && ' · 异地已开'}
                  </span>
                </button>

                <label className="switch" title="开启后本机就是一个信令服务器，别人可以连过来">
                  <input
                    type="checkbox"
                    checked={embeddedServer.enabled}
                    disabled={serverBusy}
                    onChange={(e) => void handleToggleServer(e.target.checked)}
                  />
                  <span>启用</span>
                </label>
              </div>

              {serverOpen && (
                <div className="collapse__body">
                  <p className="hint hint--dim">
                    {embeddedServer.state === 'running'
                      ? `端口 ${embeddedServer.port} · ${
                          embeddedServer.dualStack ? 'IPv4 + IPv6' : '仅 IPv4'
                        }`
                      : '未在监听。本机自用可直接填 http://localhost:8080'}
                  </p>

                  {embeddedServer.detail && <p className="hint hint--warn">{embeddedServer.detail}</p>}

                  {(embeddedServer.state === 'running' ||
                    embeddedServer.state === 'port-in-use') && (
                    <>
                      {/* 异地访问排在最前：它是唯一实测能跨网络的一条路 */}
                      {tunnel && (
                        <div className="tunnel">
                          <div className="tunnel__head">
                            <span className="tunnel__title">异地访问</span>
                            {tunnel.available ? (
                              <label
                                className="switch"
                                title="开启后本机信令会经 Cloudflare 隧道暴露到公网"
                              >
                                <input
                                  type="checkbox"
                                  checked={tunnel.enabled}
                                  disabled={tunnelBusy}
                                  onChange={(e) => void handleToggleTunnel(e.target.checked)}
                                />
                                <span>启用</span>
                              </label>
                            ) : (
                              <span className="tag tag--warn">不可用</span>
                            )}
                          </div>

                          <p className="hint hint--dim">
                            {TUNNEL_STATE_LABEL[tunnel.state]}
                            {tunnel.state === 'starting' && '（几秒到 40 秒）'}
                          </p>
                          {tunnel.detail && <p className="hint hint--warn">{tunnel.detail}</p>}

                          {tunnelUrl && (
                            <>
                              <p className="hint hint--dim">这行是**发给对方**填的，本机别填它：</p>
                              <p className="serverurl serverurl--remote">{tunnelUrl}</p>
                              <p className="hint hint--warn">
                                公网可达，知道的人都能连上信令服务。用完请关掉开关。
                              </p>
                            </>
                          )}
                        </div>
                      )}

                      {embeddedServer.lanUrls.length > 0 && (
                        <>
                          <p className="hint hint--dim">同一路由器 / 热点时填这个：</p>
                          {embeddedServer.lanUrls.map((url) => (
                            <p key={url} className="serverurl">
                              {url}
                            </p>
                          ))}
                        </>
                      )}

                      {publicServerUrls.length > 0 && (
                        <>
                          <p className="hint hint--dim">
                            公网地址（多数家庭网络连不上，需路由器放行入站；本机是双层 NAT，
                            实测不通，除非你确认自己的网络支持）：
                          </p>
                          {publicServerUrls.map((url) => (
                            <p key={url} className="serverurl serverurl--dim">
                              {url}
                            </p>
                          ))}
                        </>
                      )}

                      <p className="hint hint--dim">
                        首次启动 Windows 防火墙会弹窗，要点「允许访问」。
                      </p>
                    </>
                  )}
                </div>
              )}
            </section>
          )}

          {/* ---- 房间 ---- */}
          <section className="panel panel--tight">
            <h2>房间</h2>

            {!inRoom ? (
              <>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void run(() => session.createRoom(nickname))}
                    disabled={!connected || busy}
                  >
                    创建房间
                  </button>
                  <input
                    className="field__input field__input--code field__input--compact"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    maxLength={6}
                    placeholder="房间码"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn btn--shrink"
                    onClick={() => {
                      setJoinError(null);
                      void run(async () => {
                        try {
                          await session.joinRoom(joinCode.trim().toUpperCase(), nickname);
                        } catch (err) {
                          // run() 会照旧把它写进日志面板；这里额外提到界面上，
                          // 否则满员被拒只表现成「点了加入没反应」
                          setJoinError(ShareSession.describeError(err));
                          throw err;
                        }
                      });
                    }}
                    disabled={!connected || busy || !joinCode.trim()}
                  >
                    加入
                  </button>
                </div>

                {joinError && <p className="hint hint--warn">加入失败：{joinError}</p>}
                {!connected && <p className="hint hint--warn">请先连接信令服务器</p>}
              </>
            ) : (
              <>
                <div className="roomcode">
                  <span className="roomcode__value">{room.roomCode}</span>
                  <button
                    type="button"
                    className={copied === 'code' ? 'btn btn--tiny btn--done' : 'btn btn--tiny'}
                    onClick={() => void copyRoomCode()}
                  >
                    {copied === 'code' ? '已复制' : '复制'}
                  </button>
                  <button
                    type="button"
                    className={
                      copied === 'invite' ? 'btn btn--tiny btn--done' : 'btn btn--tiny btn--primary'
                    }
                    onClick={() => void copyInvite()}
                    disabled={!inviteAddress}
                    title="一次复制「信令地址 + 房间码」，对方照着填就能进"
                  >
                    {copied === 'invite' ? '已复制' : '复制邀请'}
                  </button>
                </div>

                <ul className="members">
                  {members.map((peer) => {
                    const isSelf = peer.peerId === room.self.peerId;
                    const link = links[peer.peerId];
                    return (
                      <li key={peer.peerId} className="member">
                        <span className="member__name">
                          {peer.nickname}
                          {isSelf && <span className="member__self">（我）</span>}
                        </span>
                        <span className="member__tags">
                          {peer.isHost && <span className="tag tag--host">房主</span>}
                          {isSelf && sharing && <span className="tag tag--live">共享中</span>}
                          {!isSelf && (
                            <span className={`tag tag--link tag--link-${link?.state ?? 'new'}`}>
                              {LINK_LABEL[link?.state ?? 'new']}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>

                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void run(() => session.leaveRoom())}
                  disabled={busy}
                >
                  离开房间
                </button>
              </>
            )}
          </section>

          {/* ---- 语音 ---- */}
          <section className="panel panel--tight">
            <h2>语音</h2>
            <div className="row">
              <button
                type="button"
                className={micEnabled ? 'btn btn--danger' : 'btn'}
                onClick={() => void run(() => session.setMicEnabled(!micEnabled))}
                disabled={busy}
              >
                {micEnabled ? '关闭麦克风' : '开启麦克风'}
              </button>
            </div>
            {micEnabled && micSettings && (
              <p className="hint hint--dim">
                回声消除 {micSettings.echoCancellation ? '开' : '关'} · 降噪{' '}
                {micSettings.noiseSuppression ? '开' : '关'} · 自动增益{' '}
                {micSettings.autoGainControl ? '开' : '关'}
              </p>
            )}
            {/* 失败必须说出来。做成「失败了但按钮看着像开着」等于让用户对着空气说话 */}
            {micError && <p className="hint hint--warn">{micError}</p>}
            {!micEnabled && !micError && (
              <p className="hint hint--dim">默认关着。开了才会占用录音设备，关了会真的把设备释放掉。</p>
            )}
          </section>

          {/* ---- 共享 ---- */}
          <section className="panel panel--tight">
            <h2>共享画面</h2>

            {sharing ? (
              <>
                <p className="hint">
                  正在共享：{captureLabel ?? '未知源'}
                  <span className={appAudioEnabled ? 'tag tag--live' : 'tag'}>
                    {appAudioEnabled
                      ? (AUDIO_MODE_LABEL[audioMode ?? 'none'] ?? '含声音')
                      : audioMode === 'none'
                        ? '无声音'
                        : '声音已关'}
                  </span>
                  <span className={micEnabled ? 'tag tag--live' : 'tag'}>
                    {micEnabled ? '麦克风开' : '麦克风关'}
                  </span>
                </p>

                {/* 音频采集失败 → 三选项显式处理，绝不静默降级也不自动换模式。
                    「继续无声」收起告警；换模式与停止走各自完整流程。 */}
                {audioFailure && (
                  <div className="audio-failure" role="alert">
                    <p className="audio-failure__title">无法捕获此应用声音。</p>
                    <p className="hint hint--dim">{audioFailure.message}</p>
                    <div className="row">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => changeAudioMode('system')}
                      >
                        改用全部电脑声音
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={dismissAudioFailure}
                      >
                        继续共享（无声音）
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger"
                        onClick={() => {
                          setPickerOpen(false);
                          session.stopShare();
                        }}
                      >
                        取消共享
                      </button>
                    </div>
                    <p className="hint hint--dim">
                      不会自动改用别的声音模式 —— 换成哪一种由你决定。
                    </p>
                  </div>
                )}

                <div className="row">
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => {
                      setPickerOpen(false);
                      session.stopShare();
                    }}
                  >
                    停止共享
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void toggleSourcePicker()}
                    disabled={busy}
                  >
                    {pickerOpen ? '收起' : '更换源'}
                  </button>
                  {/* 暂停/恢复发送应用声音：只切这一条轨（replaceTrack(null)），画面不受影响、
                      也不重新采集。想换「采哪一种声音」用下面的模式选择。 */}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => session.setAppAudioEnabled(!appAudioEnabled)}
                    disabled={!hasAudio || busy}
                    title={hasAudio ? '只切应用声音这一路，画面不受影响' : '这次共享没采到应用声音'}
                  >
                    {appAudioEnabled ? '关闭应用声音' : '开启应用声音'}
                  </button>
                  {/* 隐藏的是本机预览格：不碰轨、不碰协商，共享照常发。
                      「是否显示自己」是 M4 布局项里最后补的一块。 */}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setShowSelf((v) => !v)}
                    title="只隐藏本机的预览格，不影响共享出去的画面"
                  >
                    {showSelf ? '隐藏自己' : '显示自己'}
                  </button>
                </div>

                {/* 共享声音的三种正式状态。共享中切换 = 用同一个源按新模式重采
                    （画面会闪一下）。屏幕源没有所属进程，选它会自动落回「全部电脑」。 */}
                <div className="row row--modes" role="radiogroup" aria-label="共享声音模式">
                  <span className="hint hint--dim">声音模式：</span>
                  {UI_AUDIO_MODES.map(({ mode, label, title }) => (
                    <button
                      key={mode}
                      type="button"
                      className={
                        audioModeChoice === mode ? 'btn btn--mode btn--mode-on' : 'btn btn--mode'
                      }
                      onClick={() => changeAudioMode(mode)}
                      disabled={busy}
                      title={title}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {pickerOpen && sourceError && <p className="hint hint--warn">{sourceError}</p>}
                {pickerOpen && sourceList}
                {pickerOpen && sources.length === 0 && !sourceError && (
                  <p className="hint hint--dim">没有可用的窗口或屏幕。</p>
                )}
              </>
            ) : (
              <>
                <div className="row row--modes" role="radiogroup" aria-label="共享声音模式">
                  <span className="hint hint--dim">声音模式：</span>
                  {UI_AUDIO_MODES.map(({ mode, label, title }) => (
                    <button
                      key={mode}
                      type="button"
                      className={
                        audioModeChoice === mode ? 'btn btn--mode btn--mode-on' : 'btn btn--mode'
                      }
                      onClick={() => setAudioModeChoice(mode)}
                      title={title}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="hint hint--dim">
                  默认「仅此应用」：只共享所选窗口那个应用的声音。选屏幕源时会自动改用「全部电脑」。
                </p>

                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void refreshSources()}
                    disabled={!inRoom}
                  >
                    枚举窗口 / 屏幕
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--shrink"
                    onClick={() =>
                      void run(async () => {
                        setActiveSourceId(null);
                        await session.startShare({ testPattern: true, label: 'TEST' });
                      })
                    }
                    disabled={!inRoom}
                    title="用合成的动画画面代替真实采集，便于自动化验证链路"
                  >
                    合成源
                  </button>
                </div>

                {!inRoom && <p className="hint hint--dim">进入房间后才能共享</p>}
                {sourceError && <p className="hint hint--warn">{sourceError}</p>}
                {sourceList}
              </>
            )}

            {/* ARCHITECTURE.md 4.5 要求的能力告知：这是使用层面的风险，代码绕不过去。
                默认收成一行，免得每次共享都占掉半屏。 */}
            <button type="button" className="notice__toggle" onClick={() => setRiskOpen((v) => !v)}>
              <span className="collapse__caret">{riskOpen ? '▾' : '▸'}</span>
              反作弊风险说明
            </button>
            {riskOpen && (
              <p className="notice__body">
                部分游戏（EAC / BattlEye / Vanguard 等）会把画面捕获判为异常操作，存在封号风险；
                另一些会直接阻止捕获，表现为黑屏或纯色画面。这属于游戏侧的限制，本软件无法绕过。
                若全屏下抓不到画面，多半是这款游戏用了独占全屏，改成无边框窗口化即可。
              </p>
            )}
          </section>

          {/* ---- 日志：默认收起 ---- */}
          <section className="panel panel--tight">
            <div className="collapse__head">
              <button
                type="button"
                className="collapse__toggle"
                onClick={() => setLogsOpen((v) => !v)}
              >
                <span className="collapse__caret">{logsOpen ? '▾' : '▸'}</span>
                <span>日志</span>
                <span className="badge">{state.logs.length}</span>
              </button>
            </div>

            {logsOpen && (
              <div className="logs logs--short">
                {state.logs.length === 0 ? (
                  <p className="hint hint--dim">暂无日志</p>
                ) : (
                  state.logs.map((line, i) => (
                    <div key={`${i}-${line}`} className="logs__line">
                      {line}
                    </div>
                  ))
                )}
              </div>
            )}
          </section>
        </div>

        {/* 浮窗里整块画面区就是**拖动区**：窗口是 `setFocusable(false)` 的，标题栏拖动
            与边框缩放都会先激活窗口、在非激活窗口上都不成立，所以只能自绘（见 float-drag.ts）。
            常规模式刻意不挂 —— 那时原生边框拖得动，挂了反而会吃掉画面区里的文字选择。
            收起成小球时换成 `ballDragProps`：同样是拖动，但多了一条「没动过就算点一下」
            （整块都是拖动区，没法在上面另挖一个按钮出来）。 */}
        <div
          className="app__stage"
          ref={stageRef}
          {...(isFloat ? (barCollapsed ? ballDragProps : floatDragProps) : null)}
        >
          {/* 浮窗的控件入口：左上角**常驻**的那个小方块，点它展开 / 收起下面那条。

              为什么是这么个形状 —— 2026-09-18 实测只开自己一端就切了浮窗，
              看到的是一条控件都没有的空态提示，退出去只能靠 `Ctrl+Alt+G`。
              两个原因叠在一起：

              ① 控件原先挂在 `isFloat` 那个分支里，而分支链最前面还有一层 `!inRoom`
                 （没进房时显示「进入房间后，这里显示其他玩家的画面」）——
                 那一层把整块接走了，控件连渲染都没有；
              ② 就算进了房，那条 `.floatbar` 也是 `opacity: 0`、等鼠标进窗才浮出来的。
                 「只在 hover 时才出现」等于没有 —— 同一条判据见 4.13.1 的小窗名字牌。

              所以：控件挪到分支链**外面**（`!inRoom` 也拦不住），并且由常驻的小方块
              当唯一入口 —— 它一直看得见，点一下才展开那条。展开后**不再靠 hover 收起**：
              否则「点了收起、鼠标还在窗口里」会让它立刻又浮出来，看着像按钮坏了。 */}
          {isFloat && !splitActive && (
            <>
              <button
                type="button"
                className={`floatmenu${floatMenuOpen ? ' floatmenu--open' : ''}`}
                onClick={() => setFloatMenuOpen((open) => !open)}
                aria-expanded={floatMenuOpen}
                title={
                  floatMenuOpen
                    ? '收起控件（透明度 / 拆分 / 退出浮窗都在那条上）'
                    : '展开控件：透明度 / 拆成小窗 / 退出浮窗（快捷键 Ctrl+Alt+G）'
                }
              >
                <span className="floatmenu__lines" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="floatmenu__text">{floatMenuOpen ? '收起' : '控件'}</span>
              </button>

              <div className={`floatbar${floatMenuOpen ? ' floatbar--pinned' : ''}`}>
                {/* 同一个拖动把手。`frame: false` 之后标题栏没了，这块画面区就是
                    唯一的拖动区 —— 摆个把手，别让人靠猜。 */}
                <span className="bar__grip" title="按住画面任意处拖动这个浮窗" />
                <span className="floatbar__label">透明度</span>
                <input
                  type="range"
                  className="floatbar__range"
                  min={Math.round((floatWindow?.minOpacity ?? 0.3) * 100)}
                  max={100}
                  step={5}
                  value={Math.round((floatWindow?.opacity ?? 1) * 100)}
                  onChange={(e) => void handleOpacity(Number(e.target.value) / 100)}
                  title="调低能让后面的游戏透出来，代价是共享画面也一起变淡"
                />
                <span className="floatbar__value">
                  {Math.round((floatWindow?.opacity ?? 1) * 100)}%
                </span>
                {/* 拆分的入口只放在这里，不放顶栏：浮窗模式下顶栏整个是藏起来的，
                    而那正是唯一用得着它的场景 —— 摆在看不见的地方等于没有。 */}
                {floatPeers.length > 0 && (
                  <button
                    type="button"
                    className="floatbar__exit"
                    onClick={() => void handleToggleTiles(true)}
                    disabled={tilesBusy}
                    title={`每一路画面拆成一个独立小窗，各自拖动、各自缩放、各自置顶。窗数 = 总人数 − 1 = ${
                      floatPeers.length
                    } 个（自己这一路本地预览就能看）。画面仍然由这个窗口搬给它们，所以它会收成一条贴底的控制条 —— 声音和房间码都在那条上。`}
                  >
                    拆成 {floatPeers.length} 个小窗
                  </button>
                )}
                <button
                  type="button"
                  className="floatbar__exit"
                  onClick={() => void handleToggleFloat(false)}
                  title="回到正常界面（全局快捷键同效）"
                >
                  退出浮窗
                </button>
              </div>

              {/* 缩放手柄。窗口是 `setFocusable(false)` 的：原生边框的拖动与缩放都要先
                  激活窗口，在非激活窗口上一条都不成立 —— 所以自己画一个，而且要**看得见**：
                  自绘控件没人试过就等于不存在。所以它跟 `.floatmenu` 一样**常驻半透明**，
                  不再是 hover 才露头（那只有老手才知道能缩放）。拆分模式下不给它
                  （那时主窗口被收成固定高度的控制条，改高度没有意义）。 */}
              <div className="floatgrip" title="拖动改大小" {...floatGripProps} />
            </>
          )}
          {!inRoom ? (
            <div className="stage__empty">
              <p>进入房间后，这里显示其他玩家的画面。</p>
              <p className="hint hint--dim">
                本机联调：再开一个客户端（<code>npm run dev:desktop</code>）用同一房间码加入。
              </p>
            </div>
          ) : isFloat && splitActive ? (
            /* 拆分模式：主窗口已经被主进程收成一条贴底的窄控制条（620x76）。
               它不能关也不能最小化 —— **画面和声音都还在这个窗口里出**
               （音轨同样过不了小窗），下面那层看不见的画面就是帧泵的源。
               控件在这里是常驻可见的：一条只为控件而存在的条，再把控件藏起来
               就本末倒置了（不像下面那个浮窗悬浮条要靠 hover 才出）。 */
            <>
              {barCollapsed ? (
                /* 收起态：窗口只有 152x40，整窗就是这颗球。
                    
                    它上面**不放按钮** —— `.app__stage` 整块是拖动区，按钮吃掉哪一块，
                    哪一块就变成「从这儿开始拖不动」（和小窗名字牌同一种坑）。
                    所以展开靠「按位移判点击」：按住没动过 = 点了一下 = 展开，
                    动过 = 拖动（float-drag.ts 的 `floatBallProps`，悬浮球都是这个交互）。 */
                <div className="hostball" title="单击展开控制条 · 按住可拖到别处">
                  <span className="hostball__dot" />
                  <span className="hostball__text">{tiles?.tiles.length ?? 0} 个小窗</span>
                  <span className="hostball__expand">展开</span>
                </div>
              ) : (
                <div className="hostbar">
                  {/* 看得见的拖动把手。
                      
                      整条本来就能拖（`.app__stage` 挂着 floatDragProps），但「能拖」这件事
                      得有人告诉用户：窗口现在是 `frame: false` 的，**没有标题栏可拖了**，
                      不摆个把手，用户只会继续以为拖不动（2026-09-17 两次实机反馈都卡在这）。 */}
                  <span className="bar__grip" title="按住这条，把控制窗拖到不挡视线的地方" />
                  {/* 收起入口。摆在这条最前面：它是个「把整条收掉」的动作，
                      贴在条的头上有「折起来」的语感；摆到末尾会和「合并/退出」混成一排。 */}
                  <button
                    type="button"
                    className="hostbar__act hostbar__collapse"
                    onClick={() => void handleToggleBarCollapsed(true)}
                    title="把这条收成屏幕右下角的一颗小球 —— 画面不受影响，单击小球就展开"
                  >
                    收起
                  </button>
                  {room && (
                    <span className="hostbar__code" title="房间码">
                      {room.roomCode}
                    </span>
                  )}
                  <span className="hostbar__hint">
                    {tiles?.tiles.length ?? 0} 个小窗 · 按住这条挪本窗
                  </span>
                  <span className="hostbar__label">透明度</span>
                  <input
                    type="range"
                    className="hostbar__range"
                    min={Math.round((floatWindow?.minOpacity ?? 0.3) * 100)}
                    max={100}
                    step={5}
                    value={Math.round((floatWindow?.opacity ?? 1) * 100)}
                    onChange={(e) => void handleOpacity(Number(e.target.value) / 100)}
                    title="调低能让后面的游戏透出来，代价是画面也一起变淡"
                  />
                  <span className="hostbar__value">
                    {Math.round((floatWindow?.opacity ?? 1) * 100)}%
                  </span>
                  <button
                    type="button"
                    className="hostbar__act hostbar__act--primary"
                    onClick={() => void handleToggleTiles(false)}
                    disabled={tilesBusy}
                    title="把小窗收回来，恢复成一个窗口"
                  >
                    合并成一个窗口
                  </button>
                  <button
                    type="button"
                    className="hostbar__act"
                    onClick={() => void handleToggleFloat(false)}
                    title="回到正常界面（全局快捷键同效）"
                  >
                    退出浮窗
                  </button>
                </div>
              )}

              {/* 画面留在这层继续播：**声音是从这里出的**，帧泵也从这里抽帧。
                  视觉上收掉只用 opacity:0，别改 display:none —— 后者会让这层整个退出布局。
                  （2026-09-17 复跑探针：合成源下连 display:none 都照样出帧，所以这是
                  **保守选择**而不是实测结论；真实解码源没验过，别去试。） */}
              <div className="hostbar__videos" aria-hidden="true">
                <div className="floatgrid">
                  {floatPeers.map((peer) => renderRemoteTile(peer, 'grid'))}
                </div>
              </div>
            </>
          ) : isFloat ? (
            /* 浮窗模式：只剩画面本身。控件**不在这里** —— 它们跟着 `.floatmenu`
               挪到了分支链外面（见上面那段注释）。挂在分支里的时候，压在它前面的
               `!inRoom` 会在「还没进房」时把整块接走，浮窗就成了一个控件都没有的空壳，
               想退出去只剩快捷键（2026-09-18 实机反馈的正是这个）。 */
            <>

              {floatPeers.length === 0 ? (
                <div className="stage__empty">
                  <p>还没有人在共享画面。</p>
                  <p className="hint hint--dim">浮窗只摆正在共享的那几路。</p>
                </div>
              ) : focusedPeerId && floatPeers.some((p) => p.peerId === focusedPeerId) ? (
                /* 放大态：主画面吃满，其余几路缩成底边一条。
                   注意这里重排的只是**窗口内部**的比例，窗口尺寸不变。 */
                <div className="stage stage--focused stage--float">
                  <div className="stage__main">
                    {floatPeers
                      .filter((p) => p.peerId === focusedPeerId)
                      .map((p) => renderRemoteTile(p, 'main'))}
                  </div>
                  <div className="stage__strip">
                    {floatPeers
                      .filter((p) => p.peerId !== focusedPeerId)
                      .map((p) => renderRemoteTile(p, 'thumb'))}
                  </div>
                </div>
              ) : (
                <div
                  className="floatgrid"
                  style={{
                    gridTemplateColumns: `repeat(${floatGrid.cols}, minmax(0, 1fr))`,
                    gridTemplateRows: `repeat(${floatGrid.rows}, minmax(0, 1fr))`,
                  }}
                >
                  {floatPeers.map((peer) => renderRemoteTile(peer, 'grid'))}
                </div>
              )}
            </>
          ) : focusedPeerId ? (
            <div className="stage stage--focused">
              <div className="stage__main">
                {remotePeers.filter((p) => p.peerId === focusedPeerId).map((p) => renderRemoteTile(p, 'main'))}
              </div>
              <div className="stage__strip">
                {sharing && showSelf && renderSelfTile('thumb')}
                {remotePeers
                  .filter((p) => p.peerId !== focusedPeerId)
                  .map((p) => renderRemoteTile(p, 'thumb'))}
              </div>
            </div>
          ) : (
            <div className="grid">
              {sharing && showSelf && renderSelfTile('grid')}
              {remotePeers.map((peer) => renderRemoteTile(peer, 'grid'))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 单路画面
 * ------------------------------------------------------------------ */

interface VideoTileProps {
  peerId: string;
  title: string;
  stream: MediaStream | null;
  linkState: string;
  detail?: string;
  stats: LinkStats | null;
  self?: boolean;
  sharing?: boolean;
  remoteSharing?: boolean;
  /**
   * 远端三条轨按角色。有它之后播放层就不必再 `stream.getAudioTracks()` 按下标猜
   * 哪条是语音 —— 下标会随轨道增删漂移，角色不会。
   */
  tracks?: RemoteTracks | null;
  hasAudio?: boolean;
  /**
   * 分轨音量偏好（语音 / 共享声音各自独立）。不传 = 本地预览，不渲染音量控件。
   *
   * 「同一个 peer 不挂重复播放器」由结构保证：两条角色音轨各对应**一个**
   * `<audio>` 元素（ref 复用），轨道对象变化只换 `srcObject`，不另起元素。
   */
  audioPref?: PeerAudioPref;
  onAudioPref?: (patch: Partial<PeerAudioPref>) => void;
  /** 音量小面板是否展开（同一时刻只允许一个 tile 展开，由 App 层管） */
  volOpen?: boolean;
  onToggleVolPanel?: () => void;
  focused?: boolean;
  onToggleFocus?: () => void;
  /**
   * 元素挂载/卸载时把 `<video>` 交出去。
   *
   * 拆分模式的帧泵要从这个元素上抽帧（小窗拿不到媒体轨道，画面只能由主窗口搬），
   * 而帧泵是 React 之外的一个定时循环、拿不到组件内部的 ref —— 只能从这里交出去。
   */
  onVideoEl?: (el: HTMLVideoElement | null) => void;
  variant: TileVariant;
}

function VideoTile({
  title,
  stream,
  linkState,
  detail,
  stats,
  self,
  remoteSharing,
  tracks,
  hasAudio,
  audioPref,
  onAudioPref,
  volOpen,
  onToggleVolPanel,
  focused,
  onToggleFocus,
  onVideoEl,
  variant,
}: VideoTileProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const voiceRef = useRef<HTMLAudioElement | null>(null);
  const appAudioRef = useRef<HTMLAudioElement | null>(null);
  const [hasFrames, setHasFrames] = useState(false);

  const voiceTrack = tracks?.voice ?? null;
  const appAudioTrack = tracks?.appAudio ?? null;

  /**
   * 语音与应用声音**各接各的 `<audio>`，不混进 `<video>`**。
   *
   * 交给 `<video>` 一条整流就等于在播放层又把两条轨合成了一路，角色信息当场丢失，
   * 之后想单独静音 / 调音量只能回去猜下标 —— 那正是这轮改造要根除的东西。
   * 分开接之后「哪条是语音」一路保留到播放端。
   *
   * 没有角色表时（本地预览，以及 ontrack 还没到的那一小段）退回老行为：
   * 由 `<video>` 直接播整条流，至少保证「听得见」。
   */
  const roleAudio = voiceTrack !== null || appAudioTrack !== null;
  const voiceStream = useMemo(
    () => (voiceTrack ? new MediaStream([voiceTrack]) : null),
    [voiceTrack],
  );
  const appAudioStream = useMemo(
    () => (appAudioTrack ? new MediaStream([appAudioTrack]) : null),
    [appAudioTrack],
  );

  /**
   * 元素同时交给内部 ref 和外面（帧泵）。
   *
   * 用**回调 ref** 而不是在 effect 里上报：帧泵的 effect 与本组件的 effect 在同一批
   * 里跑，谁先谁后取决于 React 的调用顺序 —— 而回调 ref 在 commit 阶段就调过了，
   * 「帧泵启动时元素还没交出去」这个竞争窗口根本不存在。
   */
  const attach = useCallback(
    (el: HTMLVideoElement | null): void => {
      ref.current = el;
      onVideoEl?.(el);
    },
    [onVideoEl],
  );

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      setHasFrames(false);
    }
    if (stream) void video.play().catch(() => undefined);
  }, [stream]);

  // React 对 muted 的处理在部分版本里不会实时写回 DOM 属性，
  // 静音状态又必须立刻生效，所以除了 JSX 也显式落一次。
  //
  // video 元素自身恒静的场景：本地预览（本机播自己的系统声音等于双份回声）、
  // 有角色表（声音走下面两条 audio，不静就会同一路播两遍）、
  // 或者两路都被用户静了。
  // 没有角色表的那一小段退回老行为：video 直接播整条流，至少保证「听得见」。
  const noRoleAudio = voiceTrack === null && appAudioTrack === null;
  const bothMuted = Boolean(audioPref && audioPref.voiceMuted && audioPref.appMuted);
  useEffect(() => {
    if (ref.current) ref.current.muted = self ? true : !noRoleAudio || bothMuted;
  }, [self, noRoleAudio, bothMuted]);

  /**
   * 两条角色音轨的绑定、静音与音量。
   *
   * 静音 / 音量只切 `<audio>` 的本机属性（不发信令）—— 语音与应用声音
   ** 各自独立：关掉游戏声不影响队友说话，反过来也一样。
   */
  useEffect(() => {
    const pairs: Array<[HTMLAudioElement | null, MediaStream | null, boolean, number]> = [
      [voiceRef.current, voiceStream, audioPref?.voiceMuted ?? false, audioPref?.voiceVol ?? 1],
      [appAudioRef.current, appAudioStream, audioPref?.appMuted ?? false, audioPref?.appVol ?? 1],
    ];
    for (const [el, nextStream, m, v] of pairs) {
      if (!el) continue;
      if (el.srcObject !== nextStream) el.srcObject = nextStream;
      el.muted = m;
      el.volume = v;
      if (nextStream) void el.play().catch(() => undefined);
    }
  }, [voiceStream, appAudioStream, audioPref]);

  // 等真正解出画面再撤掉占位层，否则会出现「显示已连接但一片黑」
  const markFrames = useCallback(() => setHasFrames(true), []);

  const inbound = stats?.inbound ?? null;
  const route = stats?.route ?? null;
  const compact = variant === 'thumb';

  return (
    <div
      className={`tile tile--${linkState}${focused ? ' tile--focused' : ''}${
        onToggleFocus ? ' tile--clickable' : ''
      }`}
      onDoubleClick={onToggleFocus}
      // 缩略条里单击就切过去 —— 那里每格只有 168x95，双击很难点准。
      // 网格里保持双击，避免单击误触把别人的画面顶掉。
      onClick={compact ? onToggleFocus : undefined}
      title={onToggleFocus ? '双击放大 / 还原' : undefined}
    >
      {/*
        有角色音轨时把 video 元素静掉，声音交给下面两条 audio —— 不静的话
        同一路声音会被播两遍，听感上是一个极短的叠音。
      */}
      <video
        ref={attach}
        className="tile__video"
        autoPlay
        playsInline
        muted={!noRoleAudio || bothMuted}
        onLoadedData={markFrames}
        onPlaying={markFrames}
      />

      {/*
        两条角色音轨各用一个元素，刻意不合成一路：角色信息要一路保留到播放端，
        否则「单独静音他的游戏声」这种事又得回去猜下标。
        muted / volume 由上面的 effect 按分轨偏好实时落 DOM。
      */}
      {roleAudio && <audio ref={voiceRef} autoPlay playsInline />}
      {roleAudio && <audio ref={appAudioRef} autoPlay playsInline />}

      {!hasFrames && (
        <div className="tile__placeholder">
          <span>{stream ? '等待画面…' : '未收到画面'}</span>
        </div>
      )}

      <div className="tile__header">
        <span className="tile__title">{title}</span>
        {!compact && self && <span className="tag tag--live">本地</span>}
        {!compact && !self && !remoteSharing && <span className="tag">未共享</span>}
        {/* 放大不能只留双击：窗口刚被激活时第一次点击会被系统吞掉，
            双击就变成了「点了没反应」。给一个看得见的按钮，
            规则也从「得知道有这回事」变成「一眼能看见」。 */}
        {!compact && onToggleFocus && (
          <button
            type="button"
            className={focused ? 'tile__act tile__act--on' : 'tile__act'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFocus();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={focused ? '还原成网格' : '把这一路放大到主画面'}
          >
            {focused ? '还原' : '放大'}
          </button>
        )}
        {!compact && !self && voiceTrack && <span className="tag tag--live">语音</span>}
        {!compact && !self && appAudioTrack && <span className="tag tag--live">共享声</span>}
        {!compact && !self && onToggleVolPanel && (voiceTrack || appAudioTrack) && (
          <div className="tile__volwrap">
            <button
              type="button"
              className={volOpen ? 'tile__act tile__act--on' : 'tile__act'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleVolPanel();
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              title="分开调这一路的语音音量与共享声音音量"
            >
              音量
            </button>
            {volOpen && audioPref && onAudioPref && (
              <div className="tile__volpanel" onClick={(e) => e.stopPropagation()}>
                {voiceTrack && (
                  <label className="tile__volrow">
                    <span>语音</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={audioPref.voiceVol}
                      onChange={(e) => onAudioPref({ voiceVol: Number(e.target.value) })}
                    />
                    <button
                      type="button"
                      className={audioPref.voiceMuted ? 'tile__voldown' : 'tag'}
                      onClick={() => onAudioPref({ voiceMuted: !audioPref.voiceMuted })}
                      title="只静音他的麦克风，不影响共享声音"
                    >
                      {audioPref.voiceMuted ? '已静音' : '开'}
                    </button>
                  </label>
                )}
                {appAudioTrack && (
                  <label className="tile__volrow">
                    <span>共享声</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={audioPref.appVol}
                      onChange={(e) => onAudioPref({ appVol: Number(e.target.value) })}
                    />
                    <button
                      type="button"
                      className={audioPref.appMuted ? 'tile__voldown' : 'tag'}
                      onClick={() => onAudioPref({ appMuted: !audioPref.appMuted })}
                      title="只静音他的共享声音，不影响语音"
                    >
                      {audioPref.appMuted ? '已静音' : '开'}
                    </button>
                  </label>
                )}
              </div>
            )}
          </div>
        )}
        {!compact && !self && hasAudio === false && <span className="tag">无声音</span>}
        {!compact && (
          <span className={`tag tag--link-${linkState}`}>{LINK_LABEL[linkState] ?? linkState}</span>
        )}
      </div>

      {!compact && (
        <div className="tile__footer">
          {inbound ? (
            <>
              <span>
                {inbound.frameWidth}x{inbound.frameHeight}
              </span>
              <span>{inbound.framesPerSecond} fps</span>
              <span>{formatBitrate(inbound.bitrateBps)}</span>
              <span className={route?.relay ? 'tag tag--warn' : undefined}>
                {route
                  ? route.relay
                    ? `TURN(${route.localType})`
                    : `P2P(${route.localType})`
                  : '路径检测中'}
              </span>
              {route?.currentRoundTripTime != null && <span>{route.currentRoundTripTime} ms</span>}
            </>
          ) : (
            <span className="hint hint--dim">{detail || '统计采集中…'}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 浮窗里的行列数。
 *
 * 常规模式的网格每格写死最小 280x160（见 styles.css 的 `.grid`），
 * 窗口一缩小格子不跟着缩、会撑破容器 —— 浮窗要的是「在给定的这块地方里，
 * 几行几列最合适」。判据是每格宽高比离 16:9 有多远。
 *
 * 用**对数比**而不是绝对差：宽高比 1.6 和 0.63 是同一种偏差（一个偏宽一个偏高），
 * 绝对差会把它们判成不同远近，于是竖排窗口可能被排成横排。
 *
 * 尺寸还没测出来时（首帧）先按单列返回，量到之后自然会重排。
 */
function pickFloatGrid(
  width: number,
  height: number,
  count: number,
): { cols: number; rows: number } {
  if (count <= 1 || width <= 0 || height <= 0) return { cols: 1, rows: Math.max(count, 1) };

  const TARGET_ASPECT = 16 / 9;
  /** 与 styles.css 里 .floatgrid 的 gap 保持一致 */
  const GAP = 4;

  let best = { cols: 1, rows: count };
  let bestError = Number.POSITIVE_INFINITY;

  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const cellWidth = (width - GAP * (cols - 1)) / cols;
    const cellHeight = (height - GAP * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;

    const error = Math.abs(Math.log(cellWidth / cellHeight / TARGET_ASPECT));
    if (error < bestError) {
      bestError = error;
      best = { cols, rows };
    }
  }

  return best;
}

function formatBitrate(bps: number): string {
  if (bps <= 0) return '—';
  if (bps < 1_000_000) return `${Math.round(bps / 1000)} Kbps`;
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}
