# 开发规约 · 按任务查

> 这份**不是架构论证**（那在 `ARCHITECTURE.md` 第 4 节，讲「为什么」和边界），
> 也不是判据速查卡（那在 `.workbuddy/memory/MEMORY.md`，每次会话自动加载）。
> 它是**开工前的检查清单**：我要动哪块 → 必读哪节 → 必跑什么 → 最容易踩什么。

---

## 0. 文档地图

| 什么时候读 | 读哪份 | 里面是什么 |
| --- | --- | --- |
| 新线程开工第一件事 | `.workbuddy/memory/HANDOFF.md` | 现在到哪了、下一步干什么、别踩的上下文陷阱 |
| 改任何代码之前 | `.workbuddy/memory/MEMORY.md` | 判据速查卡（自动加载，只给结论） |
| 动手改某一块功能 | **本文档** | 必读节 + 必跑验收 + 易踩坑 |
| 想知道某条约束为什么 | `docs/ARCHITECTURE.md` §4 | 完整论证、边界、代码位置 |
| 调整体计划 / 里程碑 | `docs/ROADMAP.md` | M0–M10 范围、验收标准、明确不做的 |
| 本机环境、打包、工具链 | `.workbuddy/memory/ENV-NOTES.md` | 路径、bat、坑位、替代 PowerShell 的办法 |
| 跨网络（异地）联调 | `docs/REMOTE-TESTING.md` | 五种方案、诊断顺序、手机蜂窝分诊 |

**「判据」和「正文」是两回事，别指望一份文件同时干两件事。**
速查卡要短到能每次加载；正文要长到能讲透。中间隔着的就是本文档。

### 新增一条约定时，往哪写

| 这条约定是… | 写进 |
| --- | --- |
| **判据**：一句话结论，动手时必须知道 | `MEMORY.md` 对应节，末尾带 `[4.x]` |
| **为什么 / 边界 / 代码位置** | `docs/ARCHITECTURE.md` 新增 §4.x |
| **症状 / 怎么查 / 跑什么命令** | 本文档 §1 或 §2 |
| 只是本轮的进度与状态 | `HANDOFF.md` |

**别把「为什么」写进 `MEMORY.md`。** 它每个会话都要整份加载，3000 字符里
装不下论证 —— 写进去的结果就是挤掉别的判据。2026-09-17 那次超限就是这么来的：
「代码约定」一节占了 44%，其中大半是与 `ARCHITECTURE.md` §4 重复的解释。

---

## 1. 按任务：必读 + 必跑 + 易踩

### 我要改「采集源 / 窗口枚举 / 选源」

- **必读**：§4.12（枚举前提）、§4.1（置顶与全屏）、§4.5（反作弊）
- **判据**：枚举被跳过只有四种原因 —— 最小化 `IsIconic` / 不可见 / 标题空 / DWM cloaked。
  **最小化是不枚举的判据，"全屏"不是**（无边框全屏能抓，实测以撒）。
- **易踩**：`setDisplayMediaRequestHandler` 里**不许**「找不到就退到 `sources[0]`」——
  等于「选了 A 却共享整个屏幕」，看着像成功、实际共享错东西，比直接失败难查十倍。
  失败就要如实失败，原因走 `capture:take-failure` 交给渲染层。
- **必跑**：`npm run smoke:all`；涉及枚举逻辑时实机看一遍源列表（脚本碰不到真实窗口状态）。
- **诊断工具**：`scripts/probe-windows.py`、`诊断窗口抓取.bat`

### 我要改「媒体约束 / 画质档位」

- **必读**：§4.3（缩放基准）、§4.4（可替换策略）、§4.8（实际分辨率）、§4.2（带宽账）
- **判据**：`scaleResolutionDownBy` 的基准是**采集源实际高度**（`track.getSettings().height`），
  不是目标档位，不能写死。换算函数在 `packages/protocol/src/quality.ts`。
  `QualityManager` 对外只暴露 `applyQuality(peerId, level)`，**内部实现必须可整体替换**
  （今天 `setParameters`、将来可能换 simulcast）—— 别把 `setParameters` 铺进 UI 层。
- **易踩**：Chrome 会在你要的下限之上**继续按带宽自适应降分辨率**。所以
  「看起来糊」有两种完全不同的病因：档位没生效 / 生效了但被带宽压。
  验证时把「解码分辨率」和「出分辨率」两列一起看才能区分。
- **必跑**：`npm run smoke:p2p`

### 我要改「m-line / transceiver / SDP 协商」

- **必读**：§4.16（三轨结构与数字反馈环）、§4.7（M1 时期两轨的坑，口径已过时）
- **判据**：`addTransceiver` **只由链路主动方**（`selfPeerId > remotePeerId`）调用；
  `direction` 恒 `sendrecv` 不随共享状态切换；开关共享只用 `sender.replaceTrack(track|null)`；
  **三条 m-line 顺序固定 video → voice → appAudio**（`media-roles.ts` 的 `TRACK_ROLES`
  是唯一来源），两端必须一致；**角色识别只用 mid**，绝不按 `getAudioTracks()[0]` 下标猜。
- **易踩**：
  - 症状极具误导性 —— 连接状态 `connected`、信令日志全正常，但画面只有一个方向有。
    取 transceiver 按媒体类型分别选（`!t.stopped && t.mid !== null && t.receiver.track?.kind === kind`）。
  - **`replaceTrack(null)` 之后接收端 `track.muted` 不翻**（不重协商，m-line 仍是 sendrecv）：
    判静默只能量电平（比基线峰值低 20 dB）；而且远端轨没出过流时 muted 本来就是 true，
    拿「muted 翻转」当等待条件会让循环第一轮就空转退出。
  - **换源先 `setLocalTrack(role, null)` 再 `capture.stop()`** —— 顺序反了，
    旧应用的声音会从旧轨继续漏出去。
  - **停止共享 ≠ 挂电话**：`stopShare` 只摘 video + appAudio，voice 照常。
- **必跑**：`npm run check:media-tracks`（两轮：结构+生命周期 / 数字反馈环）；
  动了协商本体再补 `npm run smoke:p2p`，且必须验「两端互相都看得见」，不能只看一边。

### 我要改「系统声音 / 静音」

- **必读**：**§4.15（四种模式 / device id / 进程树边界 / koffi 打包）** + §4.10（模式与静音）
- **判据**：业务层只说 `application` / `system` / `none`（外加显式开启的 `loopback`）；
  **device id 的唯一产地是 `electron/audio/device-ids.ts`**，别处拼字符串会被静态断言拦下。
  `application` = `applicationLoopback:<pid>`（目标 + 它的**直接**子进程，隔离度实测低 94~133 dB）；
  `system` = `loopbackWithoutChrome`（整机混音减本实例，实测压掉 22~58 dB，**run 之间会飘**）；
  `loopback` = 调试 / 高级兼容，必须 `GAMESHARE_ALLOW_RAW_LOOPBACK=1`。
- **易踩**：
  - **采集音频必须显式关掉 AEC/NS/AGC 三件套**（`CaptureManager.#requestDisplay` 的
    audio 约束）。不写的话 Chromium 默认给回环轨套 AEC：本机扬声器播着的远端语音
    被当成「回声」从 App Audio 里抑制，实测留下只低 5~11 dB 的残余 ——
    多人场景下数字反馈环等于半开；显式关闭后隔离度 80~108 dB（§4.16）。
  - **不许静默降级。** `application` 拿不到目标进程时**只抛错**，并附
    `suggestion: 'system'` —— 那是**建议**不是替换。换成普通 loopback 会把本机自己播出去的
    远端语音采回来 → 双向共享直接啸叫；悄悄换过去等于把「有声音」当成「做对了」。
  - 老界面那个 `withAudio: true` 一律翻译成 **`system`**，**不是**普通 `loopback`。
  - loopback 只有 Windows 支持；渲染进程请求了 audio 而主进程没给 → Chromium 让
    **整个采集失败**，所以两端约束必须一致（走 `capture:select-source`）。
  - **进程树只到「直接子进程」，不含孙子。** Electron 子应用的音频出自它的**渲染进程**
    （孙子那层）→ 采不到。别拿「支持进程树」这句话把它盖过去。
  - `applicationLoopback:<pid>` 的 id 在 `getSettings().deviceId` 里是**加盐哈希** ——
    别拿它去核对那个真字符串，只能断言策略层的纯函数结果。
  - 窗口 ↔ 进程**不是一对一**：只承诺「按应用」，**不承诺「按窗口」**。
  - 静音是**纯本机状态**，只切 `<video>.muted`，**不发信令**。
- **必跑**：`npm run check:app-audio`（**67 项**，改了 device id / 策略层 / `capture.ts` /
  打包配置之后必跑）；动了打包就再跑 `npm run check:embedded`。
  真实 loopback 与「双向共享到底会不会啸叫」只能实机听，自动化只到频域判据。

### 我要改「共享声音模式 / 音量 UI」（阶段四）

- **必读**：§4.17（用户可见的行为契约）、§4.16
- **判据**：三态 = 仅此应用（默认，窗口源）/ 全部电脑 / 无声；**屏幕源上「仅此应用」不可用**，
  显式落回「全部电脑」（选择器要同步，不许静默）；音频采集失败 → `state.audioFailure`
  挂起 + 三选项（换全部 / 继续无声 / 取消），**降级只到无声，永远不自动换普通 loopback**；
  换源（含改模式）= 先采新、成了再换轨，**失败保留原共享**；
  分轨音量只切本机 `<audio>` 的 volume/muted（不发信令）；语音 / 共享声 / 画面
  三个状态**独立显示**，不绑总开关。
- **易踩**：`state.audioFailure` 是「待用户决策」不是「已处理记录」；「关闭应用声音」
  （replaceTrack(null) 暂停发送）与「选无声模式」（重采）是两个粒度，别混成一个按钮。
- **必跑**：`npm run check:media-tracks`（改了 CaptureManager / startShare 必跑）；
  **升级 Electron / Chromium 也必跑** —— 三件套行为与窗口枚举都跟着 Chromium 走。

### 我要改「信令协议 / 房间 / 成员」

- **必读**：§2（流程）、§4.9（链路归属）、§5（内置信令的偏离）
- **判据**：`create/join/leave-room` 走 **ack**；状态变化与信令转发走**事件广播**；
  协议错误事件名 `protocol-error`；类型全归 `packages/protocol`（唯一事实来源）。
  **`fromPeerId` 只采信服务端注入的值**，不信客户端自报。
- **易踩**：**进房必须读 join ack 里的 `peers[].sharing`** —— 不读的话，
  后加入者看谁都是「未共享」，要等对方手动切一次才自愈。
  这是真实发生过的 bug，而且被测试顺序完美盖住（见 §3）。
- **必跑**：`npm run smoke:all`（信令 17 项）+ `npm run smoke:p2p`

### 我要改「客户端状态 / 链路生命周期」

- **必读**：§4.9
- **判据**：**链路归属由成员列表决定**。`onStateChange` 一律先问 `ShareSession.#isMember`，
  不在房间里就丢弃这次回调。
- **易踩**：`MeshManager.removePeer()` → `PeerLink.close()` 会在 `#prunePeer` **之后**
  回调一次 `onStateChange('closed')`，把刚删掉的 `links[peerId]` 又写回来 →
  state 里永远留一个 `{state:'closed'}` 幽灵条目，UI 上多一个「已断开」的空格子**且永不消失**。
- **必跑**：`npm run smoke:all` 里的「断开一端」轮次（这条就是它暴露出来的）

### 我要改「窗口 / 浮窗 / 置顶」

- **必读**：§4.13、§4.11、§4.1
- **判据**：进出浮窗**顺序不能反** —— 进：先放宽 `minWidth/minHeight` 再 `setBounds`；
  退：先把下限还回常规档再 `setBounds`。否则尺寸被旧下限卡住，不报错、只是拖不动。
  透明度**只能** `win.setOpacity()`，**不能用 `transparent: true`**（跟自由缩放打架）。
  **浮窗必须 `setFocusable(false)`**，退出浮窗**必须恢复 `true`** —— 否则要么游戏被抢走
  焦点变得不能操控，要么常规界面永远拿不到焦点。
  **topmost 保活间隔必须 ≤ 400ms**（`TOPMOST_KEEPALIVE_MS`）：不少游戏自己也置顶，
  它一激活就把浮窗压到带内下方，1.5 秒级会「掉下去一秒多才回来」，肉眼可见。
- **易踩**：`globalShortcut` 是**进程独占**的，多开客户端只有第一个抢得到，
  `register()` 返回 `false` —— 必须把失败报到界面上，否则用户按了没反应只会以为软件坏了。
  唤回浮窗只能用 `showInactive()`，**不能换 `restore()`**（后者激活窗口、把焦点从游戏抢走）。
  但 `showInactive()` **抬不动 z-order**（只负责显隐），别拿它当保活用。
  **别拿 `win.isFocused()` 当「用户正在操作浮窗」的判据** —— 浮窗模式下窗口不可聚焦，
  它恒为 `false`，保活会一直跑（这是设计如此）。
  **拖动与缩放必须自绘**（渲染层算坐标 → IPC → `setBounds`）：`setFocusable(false)` 的窗口
  上，系统那套「拖标题栏、拉边框」都不成立 —— 而它**不报错**，只表现为「浮窗拖不动」。
  改完必须验「改得动 + 别的窗口改不动」（`check:tiles` 第 4 组）。
  **不要原生边框**：不可激活的窗口上，标题栏、边框、**以及最小化/最大化/关闭三颗系统按钮**
  全都失效（非客户区同样要先激活）—— 只修拖动、留着边框，用户照样只看到「按下去没反应」。
  主窗口 `frame: false`；常规模式顶栏 `-webkit-app-region: drag`（子控件必须 `no-drag`），
  三颗按钮自绘（`win:minimize` / `win:toggle-maximize` / `win:close`）。
  **三档最小尺寸不能打架**：浮窗 260x150 → 控制条 620x76 → 收起后的小球 152x40，
  同一扇窗口上轮着来；每一档都必须**先 `setMinimumSize` 再 `setBounds`**，
  否则新尺寸被上一档静默夹回（76 被夹回 150；小球宽高两个方向一起错）。
  `restoreHost` 要把下限还回 260x150，并顺手清掉 `barCollapsed`。
  ⚠️ `-webkit-app-region` 的拖动**自动化测不了**（合成鼠标驱动不了系统的模态移动循环），
  只验得到「按下点被吞掉」＝命中生效。
  **同一个 `setFocusable(false)` 还有第二种死法：渲染层的 `navigator.clipboard` 也写不进去**
  （改抛 `Document is not focused`）—— 见下「我要改复制 / 剪贴板」。
  **浮窗的控件入口必须常驻，不能只靠 hover 浮出**（2026-09-18）：`!inRoom` 那一层会先接走
  整块，控件挂在 `isFloat` 分支里就等于「**还没进房时一个控件都没有**」（用户实见）；
  进了房那条也只是 `opacity: 0` 等鼠标进窗才浮出来 —— 而浮窗恰恰是「鼠标在游戏里」的场景，
  **看不到就等于没有**（与小窗名字牌同一条判据）。现在左上角常驻一个小方块 `.floatmenu`
  当唯一开关（点开 / 点收），那条不再跟 hover 走（hover 出来的东西收不掉：刚点完收起、
  鼠标还在窗口里，它下一秒又浮回来）。它也不能被展开的条压住 —— 条上没有第二个收起入口。
  见 §4.13.1 ⑩。
- **必跑**：`npm run check:topmost`（像素探针验 z-order + 焦点，22 项，**每组都带对照**）
  与 `npm run check:tiles` 第 4 组（拖动 / 缩放）

### 我要改「浮窗拆分模式 / 小窗」

- **必读**：§4.13.1（**拆分是浮窗的子模式**，退出浮窗必须连带收掉小窗）
- **判据**：小窗**拿不到轨道**（`MediaStreamTrack` 过不了进程边界，实测 `DataCloneError`），
  画面只能由**主窗口搬帧**：`drawImage` → `createImageBitmap` → `MessagePort` 的 **transfer list**。
  三件不能改的事：**每路一张 canvas**、**按 `requestVideoFrameCallback` 驱动**（不是 `rAF`，
  否则按刷新率重复搬同一帧）、**同时只允许一帧在途**。
  **换人不重建窗口** —— 新身份从 `connectTile` 的 `meta` 通道上送，别指望改 URL（页面不导航）；
  `muted` 必须随 `syncPeers` 透传。
- **易踩**：主窗口收成控制条后，画面那层**只能用 `opacity: 0` 收掉，别换 `display: none`**
  —— 换了没有收益只有风险（帧泵靠这一层出帧）。
  `MessagePort` / `ImageBitmap` **过不了 `contextBridge`**（过桥后变成没有方法的空对象），
  所以**小窗和主窗口都必须 `contextIsolation: false`** —— 主窗口这一条是 2026-09-17 实测补上的。
  判据不能是「端口到了」，只能是**「发一张位图过去看小窗收没收到」**：空对象是真值，
  只断言到达的话测试照样绿，而现场是全黑。
  ⚠️ **鼠标真拖画面 / 拉手柄、悬停条是纯 UI 交互，没有自动化覆盖**，只能实机看。
  **收起态那颗球同理，而且更硬**：球里**一个按钮都不能有**（整块是拖动区，按钮吃掉哪一块，
  哪一块就从那儿拖不动），展开靠「按位移判点击」（`floatBallProps` + `TAP_SLOP`）；
  **收起的只是控件，搬帧那层画面必须留着**（跟控件一起收掉 = 小窗全黑且不报错）。见 §4.13.1 ⑨。
- **小窗上常驻的东西**（如左上角的成员名字牌）：**必须 `pointer-events: none`** ——
  小窗整面都是拖动区（`.tilewin` 的 pointerdown），常驻元素一旦接住那一下，
  正好从它上面开始拖就拖不动（症状是「只有那一小块拖不动」，很难归因）。
  另外**不要给它加 `backdrop-filter`**：小窗画面是每帧重绘的 canvas，背景模糊会让
  每帧多一次全窗重采样。
- **必跑**：`npm run check:tiles`（117 项，八组：装载 / 帧泵 / 浮窗拖动 / 拆分叠在浮窗上 / 收起 / 控件入口 / 剪贴板 / 静态断言；
  其中 4 条静态断言钉住「名字牌常驻、不吃指针事件、字号 ≥13px」，另有 4 条钉住收起态
  「球里没有按钮 / 球不吃指针事件 / 收起态挂的是 `floatBallProps` / 搬帧那层不归收起三元管」；
  **「控件入口」那一组跑的是真页面** —— 它自己重跑一次 `vite build`，所以比别的组慢几秒，
  顺便也就把「源码里有那几个字符串、但元素被分支拦掉」这一类假绿堵住了）
- **改了名字牌 / 小窗上的标签 → 跑 `scripts/_probe-tile-name.cjs`**（真页面截图做**对照**：
  藏掉名字牌那块必须明显变暗，别处必须不变）。它自己会重跑 `vite build`，所以比 `check:tiles` 慢。

### 我要改「复制 / 剪贴板」

- **必读**：§4.14
- **判据**：**复制一律走主进程**（`electron/clipboard.ts` 的 `clipboard:write-text`，
  渲染层用 `App.tsx` 里的 `writeClipboard()`）。渲染层的 `navigator.clipboard` 在本工程里
  **必定失败**：权限白名单只放行 `media` / `display-capture`，写入被 `callback(false)` 拒掉；
  **放开白名单也不够** —— 浮窗是 `setFocusable(false)` 的窗口，写入会改成抛
  `Document is not focused`。主进程 `clipboard` 既不看权限也不看焦点，一条路覆盖两种模式。
- **易踩**：调用方**不能把失败只写成一行日志** —— 日志面板默认折叠，用户看到的就只是
  「按钮点了没反应」（2026-09-17 那条反馈有一半是这么来的）。复制成功要给按钮一个
  可见反馈（`.btn--done` 闪一下「已复制」）。
  ⚠️ 剪贴板写入是**异步落到浏览器进程**的：别在 `await writeText()` 之后立刻读系统剪贴板
  就下结论（会读到旧值）。量法见 `scripts/_probe-clipboard.cjs`。
- **必跑**：`npm run check:tiles` 第 6 组（真 preload → 真 handler → 真系统剪贴板；
  ⚠️ 它会真动系统剪贴板，脚本自己存原文还回去）

### 我要改「打包 / 交付」

- **必读**：`.workbuddy/memory/ENV-NOTES.md` §交付与打包
- **判据**：统一走 `npm run build:exe`（或双击 `build-exe.bat`），别直调 electron-builder。
  独立部署的信令产物**必须 CJS**（`bundle:signaling`）—— ESM 下 socket.io 会抛错。
- **易踩**：`package.json` 的 `build` 对象里**不能写 `//xxx` 注释键**，electron-builder 直接拒收。
  `release/` 常被上次的残留句柄锁住，会自动顺延成 `release-2`、`release-3`（正常，别管）。
  **原生模块（koffi）必须留在 asar 外**：`build-electron.mjs` 里标 `external` +
  `build.extraResources` 放进 `resources/audio-ffi/node_modules/`，且
  `koffi/` 与 `@koromix/koffi-win32-x64/` 的**嵌套相对位置不能动**（摊平 = 文件都在、加载就炸）；
  同时**必须在 `dependencies` 之外**（进了 `dependencies` 会撞 `npmRebuild: false` 与零运行时依赖）。
  漏了症状只是「按应用共享声音不可用」，与「这台机器上没有 koffi」长得一样 ——
  配置写着 ≠ 跑过：`release-4` 就是配置补上之后**从没打过一次包**的那一份，
  `resources/` 下根本没有 `audio-ffi`。
- **必跑**：`npm run build:exe` + **`npm run check:embedded`**（动了内置信令或打包配置时**必须**跑，
  开发通过 ≠ 打包后通过）+ `npm run check:app-audio`（其中两条会直接去**最新那份产物**里找
  `audio-ffi` 并真 `require` 一次；用 `GAMESHARE_CHECK_RELEASE_DIR=release-N` 可以指定看哪一份）

### 我要改「验收脚本 / 加断言」

- **必读**：`ENV-NOTES.md` §验收断言的写法；`check-app-audio.cjs` 的文件头（音频那几套判据
  的来龙去脉写得最细）
- **判据**：断言写「**实际值 == 按协议算出的期望值**」，不是笼统的「必须 > 1」。
  **走真模块、不抄 handler** —— 抄一份进脚本就是验抄件不验产物，实现漂移了照样绿。
  每一套判据都要配两样东西：一条**内部对照**（证明装置没聋，例如「在必然采得到的那条路上
  读数必须很大」）和一条**反向验证**（证明这个门限真会红）。
- **易踩**：
  - **新断言必须反向验证一次确实会红** —— 把修复回退（或把判据指向一个已知的坏输入），
    看它变红，再还原。没红过的绿灯不算绿灯。
  - **别让测量装置自己变成判据来源。** 频谱一律取**逐帧中位数**，不取时间峰值：
    一次瞬态（缓冲边界那点咔哒 / underrun）是宽带的，用峰值统计会在同一瞬间把**全频段**
    一起抬起来，读数的形状由咔哒决定、与谁在播什么无关。实测「只有本实例在播 1060 Hz」时，
    最响的几个 bin 落在 744~797 Hz 与 1860~1880 Hz —— 换中位数之后隔离度从 ~37 dB 变成
    116~136 dB，这才是一个按进程隔离该有的量级。A/B 抵不掉咔哒（两轮里它落在不同位置）。
  - **别在静音上搭判据。** 「A/B 差值 ≤ 6 dB」这种形状，在「本来就该是静音」的路上量的是
    两次噪声的差（实测 -81 / -68 这种量级，符号都翻过）。改成量**同一路信号在两个装置下的
    读数差** —— 一头真信号、一头真静音，中间隔着几十 dB，与噪声无关。
  - **多路声音并放时，某个频点的能量可能是别人的互调产物**（实测撞到过
    `1060 = 420 + 1360 − 720`），而且其中一类幅度正比于「我们那一路」、会跟着我们那一路
    一起消失，A/B 也抵不掉 ⇒ 这类判据只能在**隔离条件**下量，多声源下只作观察打印。
- **提醒**：`test/harness.ts` 默认「先进房、再共同共享」，**验不到「对方已在共享我才进房」**
  这类顺序，要验得显式造。

---

## 2. 症状 → 病因 对照表

看到下面这些现象时，先来这里对一下，别从头查。

| 你看到什么 | 多半是 | 出处 |
| --- | --- | --- |
| 连接状态 `connected`、信令正常，但只有一个方向有画面 | 两侧都建了 transceiver / 顺序不一致 | §4.7 |
| 有音轨、没有数据（音频永远单向） | 取 transceiver 时只认 video 不认 audio | §4.7 |
| 报 `The order of m-lines in answer doesn't match order in offer` | 两条 m-line 顺序两端不一致 | §4.7 |
| UI 上多一个「已断开」的空格子，**再也不消失** | 收尾回调没按成员列表过滤 | §4.9 |
| 第二个以后进房的人看谁都是「未共享」 | 没读 join ack 的 `peers[].sharing` | §4.9 / §2 |
| 源列表里**明明开着的窗口却找不到** | 该窗口被最小化了（不是"全屏"） | §4.12 |
| 「有时候能抓、有时候抓不到」 | 切后台被系统自动最小化，不是随机 | §4.12 |
| 双击画面**完全没反应** | 非活动窗口第一下点击被系统吃掉 | §4.11 |
| 调出浮窗后**游戏不能操控**（键鼠没反应） | 浮窗把焦点抢走了 → 必须 `setFocusable(false)` | §4.13 |
| **点回游戏，浮窗就掉到游戏后面** | 游戏自己也置顶，同 topmost 带内竞争 | §4.13 |
| 浮窗期间任务栏 / Alt+Tab 里**找不到客户端** | `setFocusable(false)` 的连带效果，退出浮窗即恢复 | §4.13 |
| 浮窗**拖到某个大小就拖不动** | `minWidth` 没临时放宽 | §4.13 |
| 浮窗模式下**标题栏拖不动 / 最小化 / 最大化 / 关闭全都没反应** | 不可激活的窗口没有可用的非客户区 → **干脆不要原生边框**，全部自绘 | §4.13 |
| 拆分后控制条**比设计的高一倍**、控件下面空一大块 | 浮窗下限 260x150 把 76 夹回去了 → 先 `setMinimumSize` 再 `setBounds` | §4.13 |
| **「复制 / 复制邀请」点了毫无反应**（日志里其实写着「复制失败」） | 渲染层 `navigator.clipboard` 的写入权限被权限白名单拒掉（抛 `NotAllowedError`），且被 catch 成一行日志；**放开白名单也救不了浮窗**（不可聚焦时改抛 `Document is not focused`）→ 统一走主进程 `clipboard:write-text` | §4.14 |
| 按 `Ctrl+Alt+G` 没反应 | 快捷键被同机另一个实例抢占了 | §4.13 |
| 双方都开声音时**蜂鸣 / 啸叫** | 采到了本机自己播出去的远端语音（数字正反馈）→ 用 `application` 或 `system`，别用普通 loopback | §4.15 |
| 共享**某个游戏窗口**，却把所有应用的声音都采进来了 | 那条走的是 `system`（整机减本实例），不是 `application` | §4.15 |
| 「按应用共享声音」**打包版不可用**，dev 正常 | `resources/audio-ffi/` 下没有 koffi（extraResources 没被跑过，或嵌套被摊平） | §4.15 |
| 目标应用**启动的子启动器**的声音采不到 | 进程树只到「直接子进程」，不再往下一层 | §4.15 |
| 界面说要「按窗口共享声音」但行为像按应用 | 窗口 ↔ 进程不是一对一，**只能承诺按应用**，界面文案别越界 | §4.15 |
| App Audio 里**混着远端队友的语音**（频谱上只低 5~11 dB 的残余） | `getDisplayMedia` 的 audio 约束没显式关 AEC 三件套，远端语音被当回声抑制 | §4.16 |
| 远端轨 `muted` **永远是 false**，拿它判静默判不出来 | `replaceTrack(null)` 不重协商 → 判静默只能量电平（比峰值低 20 dB） | §4.16 |
| 验收报「源列表里没有某窗口」，但窗口明明开着 | 窗口枚举是快照式的，刚就绪的窗口偶发漏一次 → 等一会重试枚举 | §4.16 |
| 浮窗盖不住某个全屏游戏 | 那游戏是**独占全屏**，无解，改无边框窗口化 | §4.13 |
| 拆分后**小窗画面定格**在最后一帧、什么都不报 | 主窗口那层画面被收出布局了（`display:none` 之类），帧源断了 | §4.13.1 |
| 拆分后小窗**显示的是上一个人的名字**、静音按钮也说反话 | `connectTile` 只送了 `index/peerId` 没送 `name` —— 页面不重新导航，URL 永远不会变 | §4.13.1 |
| 小窗的**声音按钮显示与实际相反** | `muted` 在 `syncPeers` → IPC 这一段被丢掉了 | §4.13.1 |
| 拆分后小窗**一直「等待画面」** | 位图走了 IPC 结构化克隆，而不是 `MessagePort` 的 transfer list | §4.13.1 |
| 退出浮窗后**任务栏里剩一堆没内容的小窗** | 退出浮窗没连带 `closeAllTiles` | §4.13.1 |
| 拆分后小窗**全黑、一直停在「等待画面…」，而日志和控制台一句报错都没有** | `MessagePort` 过了 `contextBridge` → 变成一个没有方法的**空对象**（真值，判空拦不住），每帧抛 TypeError 又被帧泵自己的 catch 吃掉。**主窗口 `contextIsolation` 必须为 false** | §4.13.1 |
| 画面看着糊 | 先分清：档位没生效 / 生效了被带宽压下去 | §4.8 |
| 界面显示「端口 8080 已被占用」 | **设计内行为**，后启动方放弃监听照常当客户端 | §5 |
| 第 4 个人加入「点了没反应」 | 房间满（4 人**含房主**），加入方最多 3 个 | §5 |
| 客户端的提示/错误看不见 | 日志面板默认收起，错误只写日志 | 见 §3 待办 |

---

## 3. 只在这份文档里、别处没有的约定

这些是操作层面的约定，`ARCHITECTURE.md` 里没有（它只讲架构约束）。

| 约定 | 为什么 |
| --- | --- |
| 协议错误事件名固定 `protocol-error` | 渲染层按名字订阅，改名等于静默断链 |
| 信令**默认双栈监听**（`host = '::'`） | 别改回 `'0.0.0.0'`，会丢 IPv6 可达性 |
| 地址清单只有一个来源：`apps/signaling/src/network-addresses.ts` | 多处各自枚举必然漂移 |
| `apps/signaling` 的**库入口是 `src/embed.ts`** | `src/index.ts` 是纯副作用入口，桌面端引它会重复起服务 |
| 端口被占用对内置信令**是正常路径** | 后启动方放弃监听、照常当客户端；**别改成报错** |
| `apps/desktop` 的 `dependencies` **保持为空** | Electron 主进程/渲染层都靠 workspace 源码与内置模块，加依赖会破坏打包瘦身 |
| **不加单实例锁** | 本机要开 4 个客户端互看（`requestSingleInstanceLock` 会让第 2 个直接退出） |
| 类型全归 `packages/protocol`，workspace 直接引 TS 源码 | `exports` → `./src/index.ts`，不走构建产物 |
| 停止共享**必须**发 `setSharing(false)` | `stopShare` 一律通知对端；**换源不走它**（由 `startShare` 静默停旧源），否则面板闪一帧「未共享」 |
| 加入失败的错**必须在界面上看得见** | 2026-09-18 补（原先是 M3 待办）：满员 / 房间不存在现在渲染成「加入失败：…」提示条；新加的报错入口别只 `pushLog` —— 日志面板默认收起，用户看到的是「点了没反应」 |
| 音频 device id 只有 `electron/audio/device-ids.ts` 一处产地 | 这几个字符串是**透传**给 Chromium 的，写错没有编译期提示，只有一句「采集失败」 |
| 音频解析失败**不许静默降级** | 换成普通 loopback 会把自己播的远端语音采回去 → 双向啸叫；「有声音」≠「做对了」 |
| koffi **不放进 `dependencies`** | 进了就会同时踩 `npmRebuild: false` 与「`apps/desktop` 依赖保持为空」两条约定；它靠 extraResources 落地 |

---

## 4. 命令全表

| 想干什么 | 命令 |
| --- | --- |
| 完整验收（提交/里程碑前必跑） | `npm run smoke:all` |
| 只跑信令层 | `npm run smoke` |
| 只跑 P2P 链路层 | `npm run smoke:p2p` |
| 类型检查（四个 workspace） | `npm run typecheck` |
| 代码风格 | `npm run lint` |
| 打包（含安装包） | `npm run build:exe` |
| **打包后**验证内置信令 | `npm run check:embedded` |
| 验证独立部署的信令产物（必须 CJS） | `npm run check:standalone` |
| 验证置顶能否压住全屏窗口 | `npm run check:topmost` |
| 验证浮窗拆分模式（小窗 / 帧泵） | `npm run check:tiles` |
| 验证应用级音频捕获（四模式 / 进程树 / 产物里的 koffi） | `npm run check:app-audio` |
| 验证三轨媒体结构 + 数字反馈环（两轮，4 窗口） | `npm run check:media-tracks` |
| 验证隧道（异地访问那条路） | `npm run check:tunnel` |
| 本机 P2P 能力诊断（输出结论，不判定） | `npm run check:network` |
| STUN 节点体检（走 Chromium ICE） | `npm run check:stun` |
| 本地**源码模式**跑客户端 | 双击 `dev.bat`（只能开一个，`strictPort`） |
| 跑**已打包**客户端（可多开） | 双击 `run.bat` |
| 一键打包 | 双击 `build-exe.bat` |

---

## 5. 提交前的清单

- [ ] `npm run typecheck` 绿
- [ ] `npm run lint` 绿
- [ ] `npm run smoke:all` 绿（信令 17 项 + P2P 各轮）
- [ ] 新增/修改的断言**反向验证过**（回退修复 → 确实变红 → 还原）
- [ ] 动了内置信令或打包配置 → `npm run check:embedded` 绿
- [ ] 动了协商 / m-line / 采集约束 → `npm run check:media-tracks` 绿
- [ ] **升级 Electron / Chromium** → `npm run check:media-tracks` 绿（AEC 三件套行为与窗口枚举都跟着 Chromium 走）
- [ ] 动了 device id / 音频策略层 → `npm run check:app-audio` 绿
- [ ] 动了浮窗/窗口层级 → `npm run check:topmost` 绿
- [ ] 动了浮窗拆分 / 小窗 / 帧泵 → `npm run check:tiles` 绿
- [ ] 文档同步：改了口径就改 `ARCHITECTURE.md` / `README.md` / `HANDOFF.md`
- [ ] **没被自动化覆盖的部分要如实说明**（纯 UI、系统行为、真实 loopback、跨 NAT）
