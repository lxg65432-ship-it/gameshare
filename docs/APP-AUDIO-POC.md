# 应用级音频捕获 —— 调查报告（代码核验 + 两轮 PoC）

> **第一轮**：2026-09-18，Electron 33.4.11 / Chromium 130，探针
> `scripts/_probe-app-audio-env.cjs`、`scripts/_probe-app-audio.cjs`、`scripts/_probe-target-app.cjs`
> **第二轮**：2026-09-18，Electron 43.7.2 / Chromium 150 与 44.4.2 / Chromium 152，
> 独立 PoC 在 `F:\app-audio-poc`（44）与 `F:\app-audio-poc43`（43），报告 `F:\app-audio-poc\REPORT.md`
> **正式项目**：第一轮一行未改；第二轮只做了 Electron 升级（见文末「本轮改动」）

---

## ⚠️ 更正声明（2026-09-18，第二轮 PoC 之后）

**本文档第一轮的因果判断有一处是错的，已经改正，特此置顶说明。**

| 第一轮的写法 | 更正后 |
|---|---|
| 「本机 Windows 10 build 19045 跑不了按进程采集：该 API 最低要求 build 20348」 | **错。** 同一个 Windows 10 build 19045 上，`applicationLoopback:<pid>` 在 **Electron 43.7.2 / Chromium 150** 与 **Electron 44.4.2 / Chromium 152** 上**都实测成功**，隔离深度 >120 dB。 |
| 「升级 Electron 解决不了这个问题」 | **错。** 恰恰相反：**升级就是解法**。失败的真实原因是 **Electron 33 / Chromium 130 这一代还没接上按进程采集的能力**，与 Windows 版本无关。 |
| 「推荐下一步是找一台 Windows 11 复测」 | **不需要了。** 19045 上已经跑通，「19045 不行」这个前提本身就不成立。 |
| 「`restrictOwnAudio` 能排除自己播放的声音」 | **不成立。** 43.7.2 与 44.4.2 上实测**完全无效**（约束被主进程 handler 覆盖，`getSettings().restrictOwnAudio === false`，频带能量与基线逐项一致）。第一轮没有直接测这一条，这里补上结论。 |
| 「`deviceId` 回显即证明 device id 生效」 | **不能当证据。** 回显只证明 Electron 没拦这个字符串。是否真生效只能靠**内容层面**（频带能量）判断。 |
| 「隔离深度 >120 dB」（本文档内几处） | **那是抽查到的最好一次，别当常数引用。** 后续在同批验收里连量到 **94~133 dB**，脚本门限因此只卡 **25 dB**。`200 Hz` 那几条原始读数仍是真的，变的是「把它当固定值」这个读法。 |

**保留原则**：下面的实验记录、原始数字、探针脚本**一条都没有删除** —— 它们是对的，
错的是对它们的解释。第一轮数据在新结论下依然有效，只是归因变了。

---

## 0. 更正后的结论速览（先看这段）

1. **当前实现确实是整机混音，且本软件自己播放的远端语音会原样混进去** —— 实测确证，不是推测。
2. **Chromium 底层早就实现了按进程 / 按实例的音频捕获**，Electron 把 `audio` 字段当
   **device id 原样透传**给 Chromium —— 所以**不需要写 C++ 就能用到它**。
3. **能不能用，取决于 Electron 版本，不取决于 Windows build**：

   | Electron | Chromium | `loopbackWithoutChrome` | `applicationLoopback:<pid>` |
   |---|---|---|---|
   | **33.4.11**（升级前） | 130 | ❌ 行为等同整机混音 | ❌ 启动失败（`NotReadableError`） |
   | **43.7.2**（升级后） | 150 | ✅ 生效，排除本实例 | ✅ 生效，含进程树，隔离 >120 dB |
   | 44.4.2 | 152 | ✅ 同上 | ✅ 同上 |

4. **不需要自己实现 WASAPI，也不需要完整 C++ / N-API 音频模块。**
5. `applicationLoopback:<pid>` 唯一还缺的是「窗口句柄 → PID」这一小块（FFI 几十行）；
   要零成本就用 `loopbackWithoutChrome`（但它只排除自己，不排除别的应用）。
6. 属于**阶段二**的事（本阶段不做）：把它接进采集链路、三轨拆分、把 System loopback
   从「默认」降为「高级手动选项」。

---

## A. 当前项目现状

### A1. 版本

| 项 | 值 |
|---|---|
| Electron | **43.7.2**（2026-09-18 从 33.4.11 升级完成；`apps/desktop/package.json` 的 `build.electronVersion` 显式锁定） |
| Chromium | **150.0.7871.250** |
| Node（Electron 内置） | 24.x（Electron 33 时代是 20.18.3） |
| 本机最低支持 | 代码里只判断 `process.platform === 'win32'`，**没有 Windows 版本门槛**（也不需要） |
| 本机系统 | Windows 10 **build 19045**（22H2） |

> 第一轮的表格里这几格还是 33.4.11 / 130.0.6723.191 / Node 20.18.3。升级这件事本身
> 就是本轮调查的直接产物 —— 见 §B3。

### A2. 画面采集路径

```
渲染层 CaptureManager.startDisplay(sourceId, { withAudio })
  → IPC  capture:select-source   (把 sourceId + withAudio 记在主进程的 pending 变量里)
  → navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: withAudio })
  → 主进程 session.setDisplayMediaRequestHandler 回调
  → callback({ video: chosen, audio: 'loopback' })
```

关键点：

- **源列表由我们自己的 UI 提供**（`desktopCapturer.getSources` → 渲染层缩略图列表），
  主进程 `useSystemPicker: false` 明确关掉系统选择器。
- 源 id 形如 `window:<hwnd>:0` / `screen:<n>:0`，`hwnd` 是窗口句柄（游戏重启即变，代码里有重枚举兜底）。
- **主进程是唯一能决定音视频源的地方**，渲染层只能表达"要不要音频"。

### A3. 音频采集路径

- **Windows 专有**，走 Electron 的 `audio: 'loopback'`，即 Chromium 的
  `AudioDeviceDescription::kLoopbackInputDeviceId = "loopback"` —— **默认渲染端点的整机混音**。
- 实测音轨：`label = "System audio"`、`deviceId = loopback`、`sampleRate = 48000`、`channelCount = 1`。
- **与 video 选的是窗口还是屏幕无关**（`main.ts` 注释已写明，本次实测再次确认）。
- **刻意不加任何音频约束**（`echoCancellation` / `noiseSuppression` / `autoGainControl` 一个都不设）——
  `CaptureManager` 注释说明这套是给麦克风的，套到回环上会把音乐和音效削掉。
- **拿不到就降级为无声画面**，重试一次（`withAudio: false`），不整个失败。

### A4. WebRTC track 架构（现状）

- 每条 m-line **只由主动方创建**，方向恒 `sendrecv`；开关共享只用 `replaceTrack(null)`；顺序固定 video → audio。
- **目前「麦克风」与「系统声音」都还没有独立音轨** —— `ShareSession` 只用了
  `{ withAudio !== false }` 这一个布尔，采到的 audio track 与 video track 在同一个 `MediaStream` 里。
- **没有麦克风采集**（`getUserMedia({ audio })` 目前没有被用到），所以第十条的
  "Voice Track / App Audio Track / Video Track 三轨" 里，**Voice 轨现在是不存在的**，需要新增。

---

## B. Chromium / Electron 能力结论

### B1. 分层判定（已更正）

| 层 | 结论 | 依据 |
|---|---|---|
| **Windows** | **支持，且 build 19045 就够** | 第一轮引的「`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` 最低 build 20348」是 **WASAPI 自己动手实现**时的门槛；走 Chromium 内置路径时本机不需要它。**19045 实测通过**。 |
| **Chromium** | **已实现**（Windows/macOS/ChromeOS） | 源码 `media/audio/win/audio_low_latency_input_win.cc`：`IsProcessLoopbackDevice` / `GetTargetProcessId` / `GetProcessLoopbackMode`；`audio_device_description.{h,cc}` 里有 `kApplicationLoopbackDeviceId` / `kLoopbackWithoutChromeId` / `kRestrictOwnAudioBrowserLoopbackDeviceId` |
| **Electron** | **类型定义里没暴露，但字符串能透传** | 43.7.2 的 `electron.d.ts` 里 `Streams.audio` 依然只写 `'loopback' \| 'loopbackWithMute' \| WebFrameMain`。但实测传 `'loopbackWithoutChrome'` / `'applicationLoopback:<pid>'` 都能生效 —— 见 B3。 |
| **Electron 33（升级前）** | **两条路都不通** | `applicationLoopback:<pid>` → `NotReadableError: Could not start audio source`；`loopbackWithoutChrome` → 行为等同整机混音。**归因是 Chromium 版本，不是系统版本。** |
| **Electron 43.7.2 / 44.4.2** | **两条路都通** | 见 §C2。 |

### B2. 三个可用的 device id（源码里的确切字符串）

```
"loopback"               kLoopbackInputDeviceId        默认端点整机混音（现用）
"loopbackWithMute"       kLoopbackWithMuteDeviceId     同上 + 静音本机播放
"loopbackWithoutChrome"  kLoopbackWithoutChromeId      系统音频，但排除本进程自己的声音
"loopbackAllDevices"     kLoopbackAllDevicesId         所有输出设备的混音
"applicationLoopback:<pid>"  kApplicationLoopbackDeviceId 前缀
                              → PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE（含子进程树）
```

> `"restrictOwnAudioBrowserLoopback:<token>"` **不在** `IsLoopbackDevice()` 的白名单里，
> 走的是另一条代码路径。第二轮实测把它当普通 device id 传会被接受，但语义对我们无用，
> **记为「不采用、不作为结论」**（见 §C2 附注）。

### B3. 最重要的一条：Electron 的 audio 字段是原样透传的

实测 `audio: 'loopbackWithoutChrome'` → 拿到的音轨 `deviceId` 就是 `loopbackWithoutChrome`，
`getDisplayMedia` 正常返回、没有抛错。

**推论：Electron 在 C++ 层没有对字符串做白名单校验，而是直接当 device id 交给 Chromium。**
于是"Electron 没暴露"这件事的性质变了 —— 不是"必须等上游开 API"，而是"**能碰到，只是没写进类型定义**"。

> ⚠️ **回显不等于生效**（第二轮更正）：device id 回显只证明字符串没被拦。
> 真正是否生效必须看内容 —— 第二轮用的就是频带能量（§C2）。第一轮把 E5 的「回显了但没隔离」
> 解释成「需要 process loopback 才能兑现 + 系统版本不够」，**这个解释是错的**；
> 真实原因是 Chromium 130 那一代还没接上这条路径。
>
> ⚠️ 风险同样存在：传一个 Chromium 不认的 id，可能触发 C++ `CHECK` 直接崩进程，所以只能传上面那几个。

---

## C. PoC 实测结果

### C1. 方法（两轮相同）

用**频带分离**替代听感，可复现、可断言：

- 本脚本（"本应用"）持续播放 **1000 Hz**
- 另一个独立进程（"目标应用"）持续播放 **400 Hz**
- 共享目标窗口，采 2.2 秒，用 `AnalyserNode` 量三个频带的峰值：
  `400±25 Hz`（目标应用）/ `1000±25 Hz`（本应用自己）/ `2000~3000 Hz`（底噪参考）

判据：**只有 400 Hz 有能量 = 隔离成立；两个都有 = 整机混音。**

### C2. 第二轮结果（Electron 43.7.2 / 44.4.2，本机 19045）—— **推翻第一轮归因的那一组**

四路声源同时响，判据：比本 case 最强那一路低 25 dB 以上、且低于 -95 dB 绝对下限 = 「无」。

- `200 Hz` = 另一个 Chromium 应用（独立 Electron 实例）
- `400 Hz` = **目标应用**（独立 python.exe，非 Chromium）
- `700 Hz` = **非目标应用**（另一个独立 python.exe）
- `1000 Hz` = **Electron 自己播放**（模拟"本机在放队友语音"）

| 模式 | 200(别的Chromium) | **400(目标)** | 700(非目标) | **1000(自己)** | 结论 |
|---|---|---|---|---|---|
| **普通 `loopback`** | ✅ -39.1 | ✅ -35.6 | ✅ -34.8 | ✅ **-39.8** | 整机混音，全采 |
| **`restrictOwnAudio`**（共享屏幕） | ✅ -39.1 | ✅ -35.5 | ✅ -34.8 | ✅ **-39.7** | **与基线逐项一致，完全无效** |
| **`restrictOwnAudio`**（共享窗口） | ✅ -38.7 | ✅ -35.2 | ✅ -34.4 | ✅ **-39.4** | 同上 |
| **`loopbackWithoutChrome`** | ✅ -37.0 | ✅ -33.5 | ✅ -32.7 | ❌ **-92.5** | **只排除自己**（抑制 52.7 dB） |
| **`applicationLoopback:<pidA>`** | ❌ -132.1 | ✅ **-30.9** | ❌ -155.1 | ❌ **-161.4** | **只有目标应用**（抑制 ≈120 dB） |

进程树验证（父进程出声 400 Hz + 子进程出声 700 Hz）：

| 用例 | 200 | **400** | **700** | 1000 |
|---|---|---|---|---|
| T1 基线 `loopback` | ❌ | ✅ -34.9 | ✅ -33.8 | ✅ -38.7 |
| **T2 `applicationLoopback:<父PID>`** | ❌ | ✅ **-31.2** | ✅ **-30.5** | ❌ -93.7 |
| **T3 `applicationLoopback:<子PID>`** | ❌ | ❌ -127.6 | ✅ **-30.1** | ❌ -127.7 |
| T4 `loopbackWithoutChrome` | ❌ | ✅ -32.3 | ✅ -31.5 | ❌ -62.1 |

**T2 是决定性的**：给父 PID，**子进程的 700 Hz 也被采到了** → `INCLUDE_TARGET_PROCESS_TREE` 真实生效。
T3 反向确认粒度是真的（给子 PID 就只有子进程）。**Electron 43.7.2 上完全一致。**

`loopbackWithoutChrome` 的排除范围单独验了，因为要区分「本实例」与「所有 Chromium 系」：

| 用例 | 200(别的Chromium) | 400(A) | 700(B) | 1000(自己) |
|---|---|---|---|---|
| E6 共享屏幕 | ✅ -37.0 | ✅ -33.5 | ✅ -32.7 | ❌ **-92.5** |
| E12 共享 A 窗口 | ✅ -37.2 | ✅ -33.7 | ✅ -33.0 | ❌ **-89.2** |

**是「本实例」范围** —— 另一个 Chromium 实例（200 Hz）完好保留，所以「共享浏览器里的视频窗口」不会被静音。

> 附注：`restrictOwnAudioBrowserLoopback:<自己的主进程 PID>` 直接当 device id 传会被接受，
> 效果是**另一个 Chromium 实例被压掉 37 dB、自己的声音完好** —— 对我们的任何需求都没用，
> 且 token 格式未公开、Electron 不暴露，**不采用**。

### C3. 第一轮结果（Electron 33.4.11 / Chromium 130）—— **原始记录，归因已更正**

| 实验 | audio 参数 | 400Hz（目标应用） | 1000Hz（本应用自己） | 底噪 | 判定 |
|---|---|---|---|---|---|
| **E1** | `loopback`（现状） | **-31.0 dB** | **-30.7 dB** | -87.1 | **两个都有 = 整机混音，未隔离** |
| **E2** | `loopback` + video=整屏（对照） | -28.3 dB | -28.3 dB | -57.7 | 与 E1 频率构成相同 |
| **E3** | `loopback` + `windowAudio:"window"` | -25.4 dB | -17.5 dB | -55.1 | 无隔离（差异只是测量波动） |
| **E4** | `loopback` + `--enable-blink-features=WindowAudioCapture` | -32.4 dB | -31.5 dB | -60.4 | **与不开 flag 完全一致** |
| **E5** | `loopbackWithoutChrome` | -32.3 dB | **-24.1 dB** | -59.0 | **仍未隔离**（deviceId 已生效，但行为等同整机） |
| **E6** | `applicationLoopback:<目标进程 pid>` | — | — | — | **采集失败**：`NotReadableError: Could not start audio source` |

### C4. 逐条解读（**解释已更正**）

- **E1 命中要害**：共享「目标窗口」时，本应用自己播放的声音**强度与目标应用相当**（-30.7 vs -31.0 dB）。
  这正是验收标准里"绝不能出现"的那一类。**这是当前架构的真实缺陷，不是配置问题。**
- **E2 说明 video 源不影响音频**：整屏和单窗口拿到的频率构成一样。
- **E3 + E4 说明 `windowAudio` 这条路在 Electron 里是死的**：三次 handler 调用收到的 request
  字段集合逐字相同（`frame / securityOrigin / userGesture / videoRequested / audioRequested`），
  **约束根本没被传到主进程**；打开 blink feature 也没有任何变化。
  （第二轮在 43/44 上复测，结论不变 —— `getSupportedConstraints()` 报 `restrictOwnAudio: true`，
  但约束在 `setDisplayMediaRequestHandler` 路径下完全不生效：主进程强制回 `audio:'loopback'`，
  device 选择权被主进程拿走，约束走不到那一步。）
- **E5 说明 Chromium 130 上 `loopbackWithoutChrome` 还没兑现**：device id 被接受了，
  但拿不到"排除自己"的效果。
- **E6 说明 Chromium 130 上 `applicationLoopback` 还没接上**：
  能被识别（否则不会走到"启动音频源"这一步），但**启动失败**。
  ~~「与 E5 一起指向同一个根因（系统版本）」~~ ← **这句话是错的，见顶部更正声明。**

### C5. 第一轮**没能**验证的（如实保留）

- **Case C 真实游戏**：本机没有可测游戏。
- **浏览器、普通播放器的应用级隔离**：第一轮在 Chromium 130 上验不了。
- ~~**Win11 上的 `applicationLoopback` / `loopbackWithoutChrome` 是否成立**~~ →
  **第二轮已在 19045 上跑通，Win11 不再是必要前提。**
- **真实游戏的多进程行为**：第二轮用「父+子双进程双音」等价验证过，但没有真游戏。

### C6. 顺带发现（与采集无关但影响设计）

- **Chromium 的源列表不包含本进程自己的窗口**：PoC 主进程开的 `PROBE-SELF` 窗口
  在 `desktopCapturer.getSources()` 里查无此人，而另一个 Electron 进程的 `PROBE-TARGET` 正常列出。
  ⇒ 将来"应用级音频"方案里，**本应用自己的窗口永远不可能是采集目标**（这其实正合需求）。
- **一个进程可以有多个窗口，一个窗口也可能不属于"真正出声"的进程**（见附录实测）。

---

## D. 推荐实现路线（**已更正**）

### 先说结论

**不用写原生模块。** 两条路今天就能用，选哪条是「成本 vs 隔离彻底程度」的取舍：

| 方案 | 做法 | 能否满足验收 | 代价 |
|---|---|---|---|
| **A. `loopbackWithoutChrome`** | `callback({ audio: 'loopbackWithoutChrome' })` | **满足**「队友语音 / 自己的提示音绝不回流」；**不满足**「只出现当前共享应用的声音」（别的应用比如音乐播放器还会进来） | **零成本**，一行改动，不需要 PID |
| **B. `applicationLoopback:<pid>`** | `callback({ audio: 'applicationLoopback:' + pid })` | **最贴合**：只采目标进程树，隔离 >120 dB | 需要一个「hwnd → PID」的小桥 |
| **C. 完整 WASAPI process loopback 原生模块** | N-API + 重采样 + 造 track | 能满足 | **本项目至今最重的一块**，在 A/B 可用之后**没有必要** |
| **D. 不共享声音** | —— | 兜底 | 必须**显式告知**用户，不许静默降级 |

### 方案 B 的 PID 从哪来

Electron 给的 `desktopCapturer` source id 形如 `window:1708206:0`，**中间那串就是 HWND**。所以路径是：

```
source.id  →  HWND  →  GetWindowThreadProcessId  →  PID  →  applicationLoopback:<PID>
```

最后一步是唯一的缺口。三个可行选项（成本从低到高）：

1. **FFI 库**（`koffi` 等，有预编译二进制，不需要 VS 工具链）—— 几十行代码
2. 极小 native addon（只是一次 `GetWindowThreadProcessId` 调用，不含任何音频代码）
3. **根本不需要**：直接用方案 A，零依赖

> ⚠️ `koffi` 属于**新依赖**，与本轮升级阶段无关，**阶段二开工前要先单独定**。

### 另外两条必须一起改的（与选哪条路线无关）

1. **System Loopback 必须从"默认"降级为"高级手动选项"**，且选中时明确写出
   "会把本机播放的一切（含队友语音）一起发出去"。**当前实现是静默的，这本身就是缺陷。**
2. **WebRTC 侧要先把轨道边界留出来**（Voice / App Audio / Video 三轨）。
   现在只有 video+audio 两条，且没有麦克风采集 —— 这一步不依赖上面任何一个方案，可以先做。

---

## 附录：窗口 → 进程映射的实测（对应第五条）

本机 22 个可见顶层窗口，用 `GetWindowThreadProcessId` + Toolhelp32 实测：

| 现象 | 实例（本机实测） | 对方案的含义 |
|---|---|---|
| **一个进程挂多个窗口** | `msedge.exe(22732)` 挂了 2 个窗口；`Weixin.exe(27644)` 挂 2 个；`explorer.exe(4160)` 挂 3 个 | "共享这个窗口只采这个窗口的声音"**做不到**——按进程采会把同进程其他窗口的声音一起带上 |
| **窗口宿主进程 ≠ 真正出声的进程** | `ApplicationFrameHost.exe(33736)` 持有"设置"窗口，实际应用是 `SystemSettings.exe(33788)` | UWP 场景下 HWND→PID 会指错，照抄会采到空音轨 |
| **父进程链会断** | `msedge.exe(22732)` 的父进程已不存在（reparent 到 0） | "往上找应用主进程"这条常见做法**不可靠** |
| **启动器 + 子进程** | `steamwebhelper.exe(20288)` ← `steam.exe(15236)` | 正是真实游戏的多进程形态，也正说明**必须用 `INCLUDE_TARGET_PROCESS_TREE`**（第二轮 T2 已实测生效） |

⇒ **不要假设 `HWND → PID → Capture(PID)` 一定正确。** 这一层要做取舍并在 UI 上讲清楚
（承诺"按应用"，不承诺"按窗口"）。

---

## 复现方式

```bash
# 第一轮（Electron 33 时代，探针还留在仓库里，记录用）
node scripts/run-electron.cjs scripts/_probe-app-audio-env.cjs
node scripts/run-electron.cjs scripts/_probe-app-audio.cjs --audio=loopback
node scripts/run-electron.cjs scripts/_probe-app-audio.cjs --audio=loopbackWithoutChrome
node scripts/run-electron.cjs scripts/_probe-app-audio.cjs --audio=applicationLoopback
node scripts/run-electron.cjs scripts/_probe-app-audio.cjs --window-audio-feature

# 第二轮（结论以这一组为准；PoC 在仓库外，不污染正式工程）
:: 基础对照（13 个用例，约 2 分钟）
cd F:\app-audio-poc
node run.cjs --extra-chromium --cases=E1,E2,E3,E4,E5,E6,E7,E8,E9,E10,E11,E12,E13 --ms=2000

:: 进程树验证
node run.cjs --scene=tree

:: Electron 43.7.2 对照组
cd F:\app-audio-poc43
node run.cjs --cases=E1,E2,E6,E7,E12
```

每次运行的完整 JSON 落在各自 `logs\result-<时间戳>.json`，含每个用例的四个频带 dB、deviceId、
显示面、以及 `getSupportedConstraints` 快照。**判据始终是内容（频带能量），不是 API 返回值。**

---

## 本轮改动（2026-09-18，只做 Electron 升级）

- `apps/desktop/package.json`：`electron` → `^43.7.2`，`build.electronVersion` → `43.7.2`
- `apps/desktop/package.json` 与本文档：Electron 33 → 43.7.2 带来的安装方式回归，
  见根 `scripts/ensure-electron.mjs`（Electron 42 起 npm 包不再有 postinstall，
  二进制改成惰性下载，`.npmrc` 的镜像与 E 盘缓存重定向都会失效）—— 该文件与本阶段
  「能装、能跑、能打包」直接相关，不是顺手重构。
- **本文档**：更正顶部五条因果判断；第一轮实验记录与数字**一条未删**。
- **未做**：`applicationLoopback` / `loopbackWithoutChrome` 接入采集链路、FFI、
  声音 UI、三轨拆分、WebRTC 重构、信令改动。这些属于阶段二。
