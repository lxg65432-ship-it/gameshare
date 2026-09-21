/**
 * 极简 i18n：零依赖（apps/desktop 的 dependencies 保持为空的约定），
 * 模块级单例 + useSyncExternalStore 订阅，用法与 ShareSession 的状态订阅同构。
 *
 * 语言存 localStorage（gs.lang），切换即广播重渲染。
 *
 * 边界：只管 **UI 静态文案**。日志（pushLog）是诊断记录，保持中文不进字典；
 * 邀请文本的人读行保持中文（收邀请的一方多半也是中文用户，且解析器兼容）。
 * 动态文案用 {name} 占位符 + fmt()。
 */

export type Lang = 'zh' | 'en';

const ZH = {
  /* app / 顶栏 */
  'app.tagline': '为游戏而生，不止于游戏',
  'lang.toggle': 'EN',
  'lang.toggleTitle': '切换界面语言 / Switch UI language',

  /* 状态词 */
  'state.conn.idle': '未连接',
  'state.conn.connecting': '连接中',
  'state.conn.connected': '已连接',
  'state.conn.disconnected': '已断开',
  'state.link.new': '待建连',
  'state.link.connecting': '协商中',
  'state.link.connected': '已连接',
  'state.link.disconnected': '中断',
  'state.link.failed': '失败',
  'state.link.closed': '已关闭',
  'state.server.running': '运行中',
  'state.server.port-in-use': '未启动',
  'state.server.failed': '启动失败',
  'state.server.stopped': '已关闭',
  'state.tunnel.stopped': '未开启',
  'state.tunnel.starting': '建立中…',
  'state.tunnel.running': '已就绪',
  'state.tunnel.failed': '失败',

  /* 声音模式 */
  'audio.app': '仅此应用',
  'audio.app.title': '只共享所选窗口那个应用（及其子进程）的声音',
  'audio.system': '全部电脑',
  'audio.system.title': '共享整机声音，但排除本软件自己播放的语音',
  'audio.none': '无声',
  'audio.none.title': '只共享画面，不发送任何声音',
  'audio.tag.app': '应用声音',
  'audio.tag.system': '全部声音',
  'audio.tag.none': '无声音',
  'audio.withSound': '含声音',

  /* 连接区 */
  'conn.netSettings': '网络设置',
  'conn.netSettingsHide': '收起网络设置',
  'conn.serverAddr': '信令服务器地址（默认本机自用）',
  'conn.serverAddrTitle': '信令服务器地址',
  'conn.connect': '连接',
  'conn.disconnect': '断开',
  'conn.nickname': '昵称（留空自动生成）',

  /* 房间 */
  'room.title': '房间',
  'room.create': '创建房间',
  'room.join': '加入',
  'room.codePlaceholder': '房间码 / 粘贴邀请',
  'room.codeTitle': '填 6 位房间码，或直接粘贴朋友发来的整段邀请（自动填地址并加入）',
  'room.copied': '已复制',
  'room.copyInvite': '复制邀请',
  'room.copyInviteTitle': '复制完整邀请（含地址与房间码），朋友粘贴到房间码框即可自动加入',
  'room.needSignaling': '先点上方「连接」；收到朋友的邀请，直接粘贴到房间码框会自动连入',
  'room.joinFailed': '加入失败：',
  'room.leave': '离开房间',
  'room.memberSelf': '（我）',
  'room.tagHost': '房主',
  'room.tagSharing': '共享中',

  /* 本机信令 */
  'server.title': '本机信令服务',
  'server.enable': '启用',
  'server.enableTitle': '开启后本机就是一个信令服务器，别人可以连过来',
  'server.remoteOn': ' · 异地已开',
  'server.portInfo': '端口 {port} · {stack}',
  'server.stackDual': 'IPv4 + IPv6',
  'server.stackV4': '仅 IPv4',
  'server.notListening': '未在监听。本机自用不用改地址（默认即 http://localhost:8080）',

  /* 异地隧道 */
  'tunnel.title': '异地访问',
  'tunnel.enableTitle': '开启后本机信令会经 Cloudflare 隧道暴露到公网',
  'tunnel.unavailable': '不可用',
  'tunnel.startingHint': '（几秒到 40 秒）',
  'tunnel.copyHint': '地址不用抄——点房间里的「复制邀请」发给对方即可：',
  'tunnel.publicWarn': '公网可达，知道的人都能连上信令服务。用完请关掉开关。',
  'tunnel.lanHint': '同一路由器 / 热点时填这个：',
  'tunnel.publicHint':
    '公网地址（多数家庭网络连不上，需路由器放行入站；本机是双层 NAT，实测不通，除非你确认自己的网络支持）：',
  'tunnel.firewall': '首次启动 Windows 防火墙会弹窗，要点「允许访问」。',

  /* 语音 */
  'mic.title': '语音',
  'mic.on': '关闭麦克风',
  'mic.off': '开启麦克风',
  'mic.statsEcho': '回声消除',
  'mic.statsNs': '降噪',
  'mic.statsAgc': '自动增益',
  'mic.on2': '开',
  'mic.off2': '关',
  'mic.hint': '默认关着。开了才会占用录音设备，关了会真的把设备释放掉。',

  /* 共享面板 */
  'share.title': '共享画面',
  'share.now': '正在共享：',
  'share.unknownSource': '未知源',
  'share.audioOff': '声音已关',
  'share.micOn': '麦克风开',
  'share.micOff': '麦克风关',
  'share.stop': '停止共享',
  'share.pickMore': '更换源',
  'share.pickHide': '收起',
  'share.toggleAppAudioOff': '关闭应用声音',
  'share.toggleAppAudioOn': '开启应用声音',
  'share.toggleAppAudioTitleOk': '只切应用声音这一路，画面不受影响',
  'share.toggleAppAudioTitleNo': '这次共享没采到应用声音',
  'share.hideSelf': '隐藏自己',
  'share.showSelf': '显示自己',
  'share.hideSelfTitle': '只隐藏本机的预览格，不影响共享出去的画面',
  'share.modeLabel': '声音模式：',
  'share.modeAria': '共享声音模式',
  'share.modeSwitchHint': '共享声音的三种正式状态。共享中切换 = 用同一个源按新模式重采（画面会闪一下）。屏幕源没有所属进程，选它会自动落回「全部电脑」。',
  'share.modeDefaultHint': '默认「仅此应用」：只共享所选窗口那个应用的声音。选屏幕源时会自动改用「全部电脑」。',
  'share.fpsLabel': '帧率：',
  'share.fpsUnit': '帧',
  'share.fpsAria': '共享帧率',
  'share.fpsTitle': '帧率越高画面越顺滑，需要的上行带宽也越大',
  'share.fpsHint': '帧率越高越吃上行带宽；带宽跟不上时编码器会自动降分辨率来保帧率。',
  'share.fpsSharingHint': '共享帧率：编码 maxFramerate 与采集端共同的上限。发送方本机设置，不走观看者请求；共享中切换即时生效（setParameters），不重协商。',
  'share.noSources': '没有可用的窗口或屏幕。',
  'share.needRoom': '进入房间后才能共享',
  'share.enumerate': '枚举窗口 / 屏幕',
  'share.testSource': '合成源',
  'share.testSourceTitle': '用合成的动画画面代替真实采集，便于自动化验证链路',

  /* 音频失败告警 */
  'audioFail.title': '无法捕获此应用声音。',
  'audioFail.toSystem': '改用全部电脑声音',
  'audioFail.keepSilent': '继续共享（无声音）',
  'audioFail.cancel': '取消共享',
  'audioFail.hint': '不会自动改用别的声音模式 —— 换成哪一种由你决定。',

  /* 源选择 */
  'source.screen': '屏幕',
  'source.window': '窗口',
  'source.current': '当前',
  'source.borderless': '无边框化',
  'source.borderlessRestore': '还原',
  'source.minimizeHint':
    '找不到某个窗口？已最小化的窗口不会出现在这里，Windows 层面也抓不到它 —— 切回前台再点「枚举」。全屏、被别的窗口盖住都不影响捕获。',

  /* 日志 */
  'log.title': '日志',
  'log.empty': '暂无日志',

  /* 侧栏 resizer */
  'sidebar.expand': '展开侧栏',
  'sidebar.collapse': '收起侧栏',
  'sidebar.resizeTitle': '拖动调宽 · 点把手收起',

  /* 浮窗 */
  'float.mode': '浮窗模式',
  'float.hotkeyConflict': '快捷键冲突',
  'float.hotkeyTitle':
    '全屏游戏时按 {hotkey} 一键切换：窗口缩小、压在游戏上面、只留正在共享的画面。位置直接拖浮窗里的画面挪，大小拖右下角那个小三角；透明度在浮窗里的滑杆上调。只能压住无边框 / 窗口化全屏的游戏，独占全屏的要在游戏设置里改成无边框窗口化',
  'float.hotkeyTakenTitle': '快捷键被别的窗口占用了（同时开多个客户端时只有一个能拿到），这里点开关作用一样',
  'float.barGripTitle': '按住画面任意处拖动这个浮窗',
  'float.opacity': '透明度',
  'float.opacityTitle': '调低能让后面的游戏透出来，代价是共享画面也一起变淡',
  'float.split': '拆成 {n} 个小窗',
  'float.splitTitle':
    '每一路画面拆成一个独立小窗，各自拖动、各自缩放、各自置顶。窗数 = 总人数 − 1 = {n} 个（自己这一路本地预览就能看）。画面仍然由这个窗口搬给它们，所以它会收成一条贴底的控制条 —— 声音和房间码都在那条上。',
  'float.exit': '退出浮窗',
  'float.exitTitle': '回到正常界面（全局快捷键同效）',
  'float.gripTitle': '拖动改大小',
  'float.emptyNoShare': '还没有人在共享画面。',
  'float.emptyOnlyShared': '浮窗只摆正在共享的那几路。',
  'float.enterRoomHint': '进入房间后，这里显示其他玩家的画面。',

  /* 控制条 / 小球 */
  'bar.ballTitle': '单击展开控制条 · 按住可拖到别处',
  'bar.ballTiles': '{n} 个小窗',
  'bar.ballExpand': '展开',
  'bar.gripTitle': '按住这条，把控制窗拖到不挡视线的地方',
  'bar.collapse': '收起',
  'bar.collapseTitle': '把这条收成屏幕右下角的一颗小球 —— 画面不受影响，单击小球就展开',
  'bar.tilesInfo': '{n} 个小窗 · 按住这条挪本窗',
  'bar.opacity': '透明度',
  'bar.opacityTitle': '调低能让后面的游戏透出来，代价是画面也一起变淡',
  'bar.merge': '合并成一个窗口',
  'bar.mergeTitle': '把小窗收回来，恢复成一个窗口',
  'bar.exit': '退出浮窗',
  'bar.exitTitle': '回到正常界面（全局快捷键同效）',

  /* 窗口按钮 */
  'win.minimize': '最小化',
  'win.restore': '还原',
  'win.maximize': '最大化',
  'win.close': '关闭',

  /* 画面格 */
  'tile.waiting': '等待画面…',
  'tile.noStream': '未收到画面',
  'tile.tagLocal': '本地',
  'tile.tagNotSharing': '未共享',
  'tile.tagNoAudio': '无声音',
  'tile.tagVoice': '语音',
  'tile.tagAppAudio': '共享声',
  'tile.restore': '还原',
  'tile.enlarge': '放大',
  'tile.focusTitle': '双击放大 / 还原',
  'tile.enlargeTitle': '把这一路放大到主画面',
  'tile.volume': '音量',
  'tile.volumeTitle': '分开调这一路的语音音量与共享声音音量',
  'tile.voice': '语音',
  'tile.appAudio': '共享声',
  'tile.muted': '已静音',
  'tile.on': '开',
  'tile.muteVoiceTitle': '只静音他的麦克风，不影响共享声音',
  'tile.muteAppAudioTitle': '只静音他的共享声音，不影响语音',
  'tile.pathDetecting': '路径检测中',
  'tile.statsCollecting': '统计采集中…',
  'tile.selfTitle': '{name}（本地预览）',

  /* 小窗（FloatTile） */
  'tileFloat.defaultPeer': '对端',
  'tileFloat.waiting': '等待画面…',
  'tileFloat.muted': '已静音',
  'tileFloat.live': '有声',
  'tileFloat.unmuteTitle': '取消静音这一路',
  'tileFloat.muteTitle': '静音这一路（只影响本机）',
  'tileFloat.gripTitle': '拖动改大小',
} as const;

export type I18nKey = keyof typeof ZH;

type Dict = Record<I18nKey, string>;

const EN: Dict = {
  'app.tagline': 'Built for games, and beyond',
  'lang.toggle': '中文',
  'lang.toggleTitle': '切换界面语言 / Switch UI language',

  'state.conn.idle': 'Disconnected',
  'state.conn.connecting': 'Connecting',
  'state.conn.connected': 'Connected',
  'state.conn.disconnected': 'Disconnected',
  'state.link.new': 'Pending',
  'state.link.connecting': 'Negotiating',
  'state.link.connected': 'Connected',
  'state.link.disconnected': 'Interrupted',
  'state.link.failed': 'Failed',
  'state.link.closed': 'Closed',
  'state.server.running': 'Running',
  'state.server.port-in-use': 'Not started',
  'state.server.failed': 'Start failed',
  'state.server.stopped': 'Closed',
  'state.tunnel.stopped': 'Off',
  'state.tunnel.starting': 'Starting…',
  'state.tunnel.running': 'Ready',
  'state.tunnel.failed': 'Failed',

  'audio.app': 'This app',
  'audio.app.title': "Only share the audio of the selected window's app (and its child processes)",
  'audio.system': 'Whole PC',
  'audio.system.title': 'Share all system audio, excluding GameShare itself',
  'audio.none': 'Muted',
  'audio.none.title': 'Share video only, no audio',
  'audio.tag.app': 'App audio',
  'audio.tag.system': 'System audio',
  'audio.tag.none': 'No audio',
  'audio.withSound': 'with audio',

  'conn.netSettings': 'Network',
  'conn.netSettingsHide': 'Hide network settings',
  'conn.serverAddr': 'Signaling server address (local by default)',
  'conn.serverAddrTitle': 'Signaling server address',
  'conn.connect': 'Connect',
  'conn.disconnect': 'Disconnect',
  'conn.nickname': 'Nickname (auto if empty)',

  'room.title': 'Room',
  'room.create': 'Create room',
  'room.join': 'Join',
  'room.codePlaceholder': 'Room code / paste invite',
  'room.codeTitle': 'Type the 6-character code, or paste a whole invite to connect & join automatically',
  'room.copied': 'Copied',
  'room.copyInvite': 'Copy invite',
  'room.copyInviteTitle': 'Copies a full invite (address + room code) — your friend just pastes it to join',
  'room.needSignaling': 'Click "Connect" above — or just paste an invite into the room code box and it connects automatically',
  'room.joinFailed': 'Join failed: ',
  'room.leave': 'Leave room',
  'room.memberSelf': ' (me)',
  'room.tagHost': 'Host',
  'room.tagSharing': 'Sharing',

  'server.title': 'Signaling server',
  'server.enable': 'On',
  'server.enableTitle': 'Turn this machine into a signaling server others can connect to',
  'server.remoteOn': ' · remote on',
  'server.portInfo': 'Port {port} · {stack}',
  'server.stackDual': 'IPv4 + IPv6',
  'server.stackV4': 'IPv4 only',
  'server.notListening': 'Not listening. For local use no address change is needed (default http://localhost:8080)',

  'tunnel.title': 'Remote access',
  'tunnel.enableTitle': 'Exposes the local signaling server to the internet via a Cloudflare tunnel',
  'tunnel.unavailable': 'Unavailable',
  'tunnel.startingHint': '(takes a few seconds up to 40s)',
  'tunnel.copyHint': "No need to copy the address — use \"Copy invite\" in the room section and send it:",
  'tunnel.publicWarn': 'Publicly reachable — anyone with the address can connect. Turn it off when done.',
  'tunnel.lanHint': 'On the same router / hotspot, use this:',
  'tunnel.publicHint':
    'Public addresses (most home networks cannot be reached directly; requires router port forwarding — tested not working behind double NAT):',
  'tunnel.firewall': 'Windows Firewall will prompt on first launch — click "Allow".',

  'mic.title': 'Voice',
  'mic.on': 'Mute microphone',
  'mic.off': 'Unmute microphone',
  'mic.statsEcho': 'Echo cancel',
  'mic.statsNs': 'Noise suppress',
  'mic.statsAgc': 'Auto gain',
  'mic.on2': 'on',
  'mic.off2': 'off',
  'mic.hint': 'Off by default. On: occupies the recording device. Off: releases it for real.',

  'share.title': 'Share screen',
  'share.now': 'Sharing: ',
  'share.unknownSource': 'unknown source',
  'share.audioOff': 'audio off',
  'share.micOn': 'mic on',
  'share.micOff': 'mic off',
  'share.stop': 'Stop sharing',
  'share.pickMore': 'Change source',
  'share.pickHide': 'Hide',
  'share.toggleAppAudioOff': 'Turn off app audio',
  'share.toggleAppAudioOn': 'Turn on app audio',
  'share.toggleAppAudioTitleOk': 'Toggles only the app-audio track; video is unaffected',
  'share.toggleAppAudioTitleNo': 'No app audio was captured in this share',
  'share.hideSelf': 'Hide self',
  'share.showSelf': 'Show self',
  'share.hideSelfTitle': 'Hides only your local preview tile; what you share is unaffected',
  'share.modeLabel': 'Audio mode:',
  'share.modeAria': 'Shared audio mode',
  'share.modeSwitchHint': 'Switching mid-share re-captures with the new mode (screen flashes once). Screen sources have no owning app, they fall back to "Whole PC".',
  'share.modeDefaultHint': 'Default "This app": only the selected window\'s app audio. Screen sources automatically use "Whole PC".',
  'share.fpsLabel': 'FPS:',
  'share.fpsUnit': 'fps',
  'share.fpsAria': 'Shared frame rate',
  'share.fpsTitle': 'Higher FPS is smoother but needs more upload bandwidth',
  'share.fpsHint': 'Higher FPS eats more upload; when bandwidth runs short the encoder lowers resolution to keep the frame rate.',
  'share.fpsSharingHint': 'Shared FPS: the common cap of encoder and capture. Sender-side setting; takes effect instantly while sharing (setParameters), no renegotiation.',
  'share.noSources': 'No windows or screens available.',
  'share.needRoom': 'Join a room before sharing',
  'share.enumerate': 'Enumerate windows / screens',
  'share.testSource': 'Test source',
  'share.testSourceTitle': 'Use a synthetic animated source instead of real capture, for automated checks',

  'audioFail.title': 'Cannot capture this app\'s audio.',
  'audioFail.toSystem': 'Switch to whole-PC audio',
  'audioFail.keepSilent': 'Keep sharing (no audio)',
  'audioFail.cancel': 'Cancel sharing',
  'audioFail.hint': 'It never falls back automatically — which mode to use is up to you.',

  'source.screen': 'Screen',
  'source.window': 'Window',
  'source.current': 'current',
  'source.borderless': 'Borderless',
  'source.borderlessRestore': 'Restore',
  'source.minimizeHint':
    "Can't find a window? Minimized windows never appear here and Windows cannot capture them — bring it to the foreground and enumerate again. Fullscreen or covered windows capture fine.",

  'log.title': 'Log',
  'log.empty': 'No logs yet',

  'sidebar.expand': 'Expand sidebar',
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.resizeTitle': 'Drag to resize · click the grip to collapse',

  'float.mode': 'Float overlay',
  'float.hotkeyConflict': 'Hotkey conflict',
  'float.hotkeyTitle':
    'Press {hotkey} in a fullscreen game: the window shrinks, stays above the game, only showing shared screens. Drag the picture to move it, drag the bottom-right grip to resize, adjust opacity on the slider. Works over borderless/windowed fullscreen only — exclusive fullscreen must be changed in the game settings',
  'float.hotkeyTakenTitle': 'The hotkey is taken by another window (only one client gets it when running multiple), the toggle here still works',
  'float.barGripTitle': 'Drag anywhere on the picture to move the overlay',
  'float.opacity': 'Opacity',
  'float.opacityTitle': 'Lower it to see the game behind — the shared picture fades too',
  'float.split': 'Split into {n} tiles',
  'float.splitTitle':
    'Each stream becomes its own always-on-top tile, draggable and resizable. Count = players − 1 = {n} (your own preview stays local). This window still feeds them the frames, so it collapses into a bottom bar — sound and room code live there.',
  'float.exit': 'Exit overlay',
  'float.exitTitle': 'Back to the normal UI (same as the global hotkey)',
  'float.gripTitle': 'Drag to resize',
  'float.emptyNoShare': 'Nobody is sharing yet.',
  'float.emptyOnlyShared': 'The overlay only shows actively shared streams.',
  'float.enterRoomHint': 'Join a room and other players\' screens will show up here.',

  'bar.ballTitle': 'Click to expand the control bar · hold to drag',
  'bar.ballTiles': '{n} tiles',
  'bar.ballExpand': 'Expand',
  'bar.gripTitle': 'Hold to drag this bar out of the way',
  'bar.collapse': 'Collapse',
  'bar.collapseTitle': 'Collapse this bar into a small ball at the bottom-right — sharing is unaffected; click the ball to expand',
  'bar.tilesInfo': '{n} tiles · hold to move this window',
  'bar.opacity': 'Opacity',
  'bar.opacityTitle': 'Lower it to see what\'s behind — the picture fades too',
  'bar.merge': 'Merge into one window',
  'bar.mergeTitle': 'Bring the tiles back into a single window',
  'bar.exit': 'Exit overlay',
  'bar.exitTitle': 'Back to the normal UI (same as the global hotkey)',

  'win.minimize': 'Minimize',
  'win.restore': 'Restore',
  'win.maximize': 'Maximize',
  'win.close': 'Close',

  'tile.waiting': 'Waiting for stream…',
  'tile.noStream': 'No stream received',
  'tile.tagLocal': 'Local',
  'tile.tagNotSharing': 'Not sharing',
  'tile.tagNoAudio': 'No audio',
  'tile.tagVoice': 'Voice',
  'tile.tagAppAudio': 'App audio',
  'tile.restore': 'Restore',
  'tile.enlarge': 'Enlarge',
  'tile.focusTitle': 'Double-click to enlarge / restore',
  'tile.enlargeTitle': 'Enlarge this stream to the main stage',
  'tile.volume': 'Volume',
  'tile.volumeTitle': 'Adjust voice and app-audio volume for this stream separately',
  'tile.voice': 'Voice',
  'tile.appAudio': 'App audio',
  'tile.muted': 'Muted',
  'tile.on': 'on',
  'tile.muteVoiceTitle': 'Mute only their microphone, app audio unaffected',
  'tile.muteAppAudioTitle': 'Mute only their app audio, voice unaffected',
  'tile.pathDetecting': 'detecting path…',
  'tile.statsCollecting': 'gathering stats…',
  'tile.selfTitle': '{name} (local preview)',

  'tileFloat.defaultPeer': 'Peer',
  'tileFloat.waiting': 'Waiting for stream…',
  'tileFloat.muted': 'Muted',
  'tileFloat.live': 'Sound on',
  'tileFloat.unmuteTitle': 'Unmute this stream',
  'tileFloat.muteTitle': 'Mute this stream (local only)',
  'tileFloat.gripTitle': 'Drag to resize',
};

const DICTS: Record<Lang, Dict> = { zh: ZH, en: EN };

let lang: Lang = (() => {
  const saved = window.localStorage.getItem('gs.lang');
  return saved === 'en' ? 'en' : 'zh';
})();

const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  window.localStorage.setItem('gs.lang', next);
  for (const l of listeners) l();
}

export function subscribeLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 取当前语言的文案。key 不存在时回落中文（迁移期兜底） */
export function t(key: I18nKey): string {
  return DICTS[lang][key] ?? ZH[key];
}

/** 带占位符的模板：fmt('{n} 个小窗', { n: 3 }) */
export function fmt(key: I18nKey, vars: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}
