/**
 * 画面 + 声音采集的主进程入口。
 *
 * 从 `main.ts` 里抽出来单独一个模块，理由有两条：
 *
 * 1. **可验收**。这一层真正的产品语义是「渲染层说要哪种声音 → 主进程回哪一路 device id」，
 *    而这条链只有跑**真 handler** 才算验过。留在大文件里，验收脚本就只能自己抄一份
 *    handler 进去（验的是抄件，不是产物）—— `check-float-tiles` 的分组注释里
 *    对同一类问题已经写过一次。
 * 2. 这一块自带 4 个模块级状态（选中的源 / 要哪一种声音 / 上一次失败），
 *    和窗口管理、信令、隧道的状态没有任何关系，混在一起只会让「谁在改它」难查。
 *
 * 声音那部分的责任边界写在这里，别处不要再拼 device id：
 * 渲染层只表达 `application / system / none`（外加显式开启的 `loopback`），
 * 翻译成 Chromium 字符串的动作全在 `audio/strategies.ts`。
 */

import { desktopCapturer, ipcMain, session } from 'electron';

import { asStreamAudio } from './audio/device-ids';
import { audioCapabilities, describeMode, resolveAudioDevice } from './audio/strategies';
import {
  AudioCaptureError,
  isAudioCaptureMode,
  type AudioCaptureFailure,
  type AudioCaptureMode,
  type AudioTarget,
} from './audio/types';
import { tryPidOfWindowSource } from './audio/win32-window-pid';

/**
 * 渲染进程选定的采集源。
 *
 * getDisplayMedia() 是浏览器 API，本身不接受「指定某一窗口」这种参数，
 * 必须由主进程在 request handler 里决定回哪个源。所以渲染进程先用
 * capture:select-source 把选择放这里，再调用 getDisplayMedia()。
 *
 * **刻意不在 handler 里用完就清空**：Chromium 有可能对同一次
 * getDisplayMedia 调用重复进入 handler，清空会让第二次匹配不到源。
 */
let pendingCaptureSourceId: string | null = null;

/**
 * 本次采集要**哪一种**音频。**刻意不是布尔值。**
 *
 * 由渲染进程通过 capture:select-source 一起传进来 —— handler 拿不到
 * getDisplayMedia 的约束，只能靠这个值决定回不回音频、回哪一路。
 * 两边必须一致：渲染请求了 audio 而这里没给，Chromium 会直接让采集失败。
 *
 * 默认 `none`：没被要求就不采。渲染层那个「共享系统声音」的布尔开关会被
 * 翻译成 `system`（整机声音、但排除本软件自己）—— 普通 `loopback`
 * **不再是任何路径的默认值**，它只在显式开启高级兼容模式时才会被解析出来。
 */
let pendingCaptureAudioMode: AudioCaptureMode = 'none';

/**
 * 上一次采集失败的具体原因，等渲染层取走。
 *
 * getDisplayMedia() 抛到渲染层的只有 NotAllowedError 这类笼统错误，
 * 「到底为什么没采到」这个信息只在主进程这一侧。放在这里让渲染层取走，
 * 用户看到的才是具体原因，而不是一句没有信息量的「权限被拒绝」。
 * 取走即清空，一次失败对应一次读取，不串到下一次。
 *
 * 带上 failedMode / suggestion，是为了那条规定：**不允许自动静默降级**。
 * 主进程只负责说清「哪个模式失败了、可以换成什么」，换不换由调用方决定。
 */
let lastCaptureFailure: AudioCaptureFailure | null = null;

/**
 * 枚举可采集的源。
 *
 * list-sources 要缩略图给用户看，request handler 只按 id 找源、不需要图 ——
 * 后者拿到缩略图纯属白等（每个窗口都要抓一次图）。
 */
export function enumerateDesktopSources(options: {
  withThumbnails: boolean;
}): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources({
    types: ['window', 'screen'],
    // 缩略图用 JPEG：PNG 的 dataURL 在窗口多的时候能到几 MB，
    // 走 IPC 会明显卡顿，而列表里只需要看清是什么窗口。
    thumbnailSize: options.withThumbnails ? { width: 240, height: 135 } : { width: 0, height: 0 },
    fetchWindowIcons: options.withThumbnails,
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function registerCaptureHandlers(): void {
  /**
   * 启动时把音频能力打进日志。
   *
   * 这是**唯一**能在打包产物里核对「HWND→PID 那条 FFI 链到不到位」的地方：
   * 打包漏掉 koffi 时，界面上只表现为「按应用共享声音不可用」，
   * 而原因（`ffi-unavailable`）只有这里说得清。
   */
  const capabilities = audioCapabilities();
  console.log(
    `[main] 音频采集能力 ffi=${capabilities.ffi.available ? 'ok' : 'NO'} ` +
      capabilities.modes.map((m) => `${m.mode}=${m.available ? 'ok' : 'NO'}`).join(' '),
  );
  if (!capabilities.ffi.available) console.warn(`[main] FFI 不可用：${capabilities.ffi.detail}`);

  ipcMain.handle('capture:list-sources', async () => {
    const sources = await enumerateDesktopSources({ withThumbnails: true });

    return sources.map((source) => {
      const kind = source.id.startsWith('screen:') ? ('screen' as const) : ('window' as const);
      return {
        id: source.id,
        name: source.name,
        kind,
        thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
        appIcon: source.appIcon?.isEmpty() === false ? (source.appIcon?.toDataURL() ?? null) : null,
        /**
         * 窗口源顺手把 PID 解出来。
         *
         * 只在这里解：`source.id` 中间那段就是 HWND，`GetWindowThreadProcessId`
         * 一次调用几十微秒，几十个源加起来可以忽略。但**必须容错** ——
         * 某个窗口刚好在枚举与取 PID 之间关掉是常事，那一个记 null 就行，
         * 不能让整个列表跟着失败。
         */
        pid: kind === 'window' ? tryPidOfWindowSource(source.id) : null,
      };
    });
  });

  ipcMain.handle('capture:select-source', (_event, sourceId: unknown, options: unknown) => {
    pendingCaptureSourceId = typeof sourceId === 'string' && sourceId.length > 0 ? sourceId : null;

    /**
     * 第二个参数必须接住。
     *
     * 渲染层从 preload 一路把音频相关选项传到这里，而这个 handler 早先只声明了
     * sourceId、把 options 整个丢掉 —— 于是「要不要声音」恒为 false，
     * 表现是「界面标着含声音，对端却永远收不到音轨」。
     * 自动化验收走的是合成源（canvas + oscillator），到不了这条真实采集路径，
     * 所以这个 bug 在 smoke 里一直没有暴露。
     *
     * 现在收的是 `audioMode`；老的 `withAudio` 布尔仍然认，翻译成 **`system`**
     * （整机声音、排除本软件自己）—— **不是 loopback**：
     * 「共享系统声音」想要的语义从来就是它，而不是连自己播放一起采。
     */
    const raw = (typeof options === 'object' && options !== null ? options : {}) as {
      withAudio?: unknown;
      audioMode?: unknown;
    };

    if (isAudioCaptureMode(raw.audioMode)) {
      pendingCaptureAudioMode = raw.audioMode;
    } else if (raw.audioMode === undefined || raw.audioMode === null) {
      pendingCaptureAudioMode = raw.withAudio === true ? 'system' : 'none';
    } else {
      // 给了一个不认识的模式：宁可炸在这一点上，也不要静默挑一个顶上
      throw new Error(`不认识的音频模式：${JSON.stringify(raw.audioMode)}`);
    }

    return { ok: true };
  });

  /** 渲染层在 getDisplayMedia 失败后调用，取走主进程记下的具体原因 */
  ipcMain.handle('capture:take-failure', () => {
    const failure = lastCaptureFailure;
    lastCaptureFailure = null;
    return failure;
  });

  /** 四种音频模式在本机的可用性（含不可用的原因）。界面与验收脚本都用得上 */
  ipcMain.handle('capture:get-audio-capabilities', () => audioCapabilities());

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void (async () => {
        const wanted = pendingCaptureSourceId;
        let sources = await enumerateDesktopSources({ withThumbnails: false });
        let chosen = wanted ? (sources.find((s) => s.id === wanted) ?? null) : null;

        /**
         * 指定了源却没找到 → 再枚举一次。
         *
         * 窗口 id 是 `window:<hwnd>:0`，游戏进程一重启 hwnd 就变了。
         * 而「打开源列表 → 挑一个 → 点下去」之间隔着好几秒，正好够游戏重启一轮：
         * 列表里那一项还是旧的 hwnd，照着它去找必然落空。
         * 重枚举一次能把这种情况救回来。
         */
        if (wanted && !chosen) {
          await delay(150);
          sources = await enumerateDesktopSources({ withThumbnails: false });
          chosen = sources.find((s) => s.id === wanted) ?? null;
        }

        // 调用方没指定源（正常路径不会走到这里），退到主屏；
        // 指定了却找不到时**不退** —— 见下面的说明。
        if (!chosen && !wanted) {
          chosen = sources.find((s) => s.id.startsWith('screen:')) ?? sources[0] ?? null;
        }

        if (!chosen) {
          /**
           * 这里刻意不再退到 `sources[0]`。
           *
           * 原先写的是 `?? sources[0]`：选定的窗口匹配不上时，会不声不响地
           * 改成采整个屏幕。表现出来是「选了 A 却共享了 B」—— 画面上看着像成功了，
           * 实际共享的是别的东西，比直接失败难排查得多。
           *
           * 找不到的原因基本只有一类：那个窗口此刻不在可捕获列表里。
           * Chromium 会过滤掉**已最小化 / 不可见 / 无标题 / 被 DWM cloaked**
           * 的窗口（游戏切进独占全屏再切出来就属于最后一种），
           * 这些状态没有任何 API 能让它重新出现，只能让用户把窗口切回前台。
           */
          lastCaptureFailure = {
            message: wanted
              ? '要共享的那个窗口现在抓不到了：它可能刚被最小化、切进了独占全屏，或者被关掉重开过。' +
                '把游戏切回前台（保持窗口化、别最小化）之后，重新点「枚举」再选一次。'
              : '没有可用的采集源。',
            failedMode: null,
            suggestion: null,
          };
          // 不回调会让渲染进程的 getDisplayMedia 永久挂起，必须给个空对象收尾
          callback({});
          return;
        }

        lastCaptureFailure = null;

        /**
         * 音频：把「模式 + 目标」交给策略层解析成 Chromium 的 device id。
         *
         * 三条必须知道的：
         *
         * 1. **只有 Windows 有这几个回环实现**（Electron 文档写明了 currently only
         *    supported on Windows）。其他平台解析时抛 `unsupported-platform`，
         *    渲染层会把画面降级成无声 —— 不会因为声音起不来就整个共享失败。
         * 2. **解析失败不换模式。** 拿不到目标进程时直接失败、把原因记下来，
         *    并附一个**可选**的替代模式；绝不悄悄退到普通 `loopback` ——
         *    那会把本机自己的播放（也就是收到的远端语音）一起采进去，
         *    双向共享时构成啸叫环，而用户只会看到「有声音了」。
         * 3. 普通 `loopback` 只作为显式开启的高级兼容模式存在
         *    （`GAMESHARE_ALLOW_RAW_LOOPBACK=1`），**不再是任何路径的默认值**。
         */
        const target: AudioTarget = {
          sourceId: chosen.id,
          kind: chosen.id.startsWith('screen:') ? 'screen' : 'window',
          pid: chosen.id.startsWith('screen:') ? null : tryPidOfWindowSource(chosen.id),
        };

        let audio: string | null = null;
        try {
          audio = resolveAudioDevice(pendingCaptureAudioMode, target).deviceId;
        } catch (err) {
          lastCaptureFailure =
            err instanceof AudioCaptureError
              ? {
                  message: err.message,
                  failedMode: pendingCaptureAudioMode,
                  suggestion: err.suggestion,
                }
              : {
                  message: `采集「${describeMode(pendingCaptureAudioMode)}」失败：${
                    err instanceof Error ? err.message : String(err)
                  }`,
                  failedMode: pendingCaptureAudioMode,
                  suggestion: null,
                };
          /**
           * 音频解析不出来时**不给画面**。
           *
           * 调用方此刻要的正是「带着这个应用的声音一起共享」；静默给一路无声画面，
           * 等于把「没做对」伪装成「做成了」—— 用户看到画面出来了，以为成了。
           * 渲染层拿到这条原因后可以显式改用别的模式再试一次，那才是允许的下一步。
           */
          callback({});
          return;
        }

        /**
         * 每次采集把「最后交给 Chromium 的那个 device id」打一行。
         *
         * 这一层是**纯字符串透传**（见 `audio/device-ids.ts` 的文件头），写错一个
         * 字符没有任何编译期提示；而症状 ——「采回来的声音里带着本来不该有的东西」
         * 或者「明明选了按应用却像整机」—— 跟「模式选错了」长得一模一样。
         *
         * 排查这类问题时第一个要看的就是这一行：模式是不是真的落到了那一路。
         * 只在采集时打，一次一行，不刷屏。
         */
        console.log(
          `[capture] 音频：mode=${pendingCaptureAudioMode} 源=${chosen.id} ` +
            `pid=${target.pid ?? '-'} → device=${audio ?? '(无)'}`,
        );

        callback(audio ? { video: chosen, audio: asStreamAudio(audio) } : { video: chosen });
      })();
    },
    // 默认的 useSystemPicker 在 Windows 上会弹系统选择器，绕过我们的源列表，
    // 明确关掉才能保证「用户在应用里选的那个窗口」被采到。
    { useSystemPicker: false },
  );

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission !== 'media' && permission !== 'display-capture') {
      callback(false);
      return;
    }
    // 只信任自己的界面：打包后是 `file://`，开发期是 vite 的 loopback 地址
    callback(isOwnUiUrl(webContents.getURL()));
  });
}

/**
 * 这个 URL 是不是「我们自己的界面」。
 *
 * 早先写的是 `url.startsWith('http://localhost')`，两个毛病：
 *
 * 1. **前缀比较会放过 `http://localhost.evil.com`** —— 那是一个外部域名。
 *    要判就判**主机名**，不是整串。
 * 2. 只认 `localhost` 这一个写法。开发服务器或验收页跑在 `127.0.0.1`
 *    （同一个环回口，只是另一种写法）时会被一起拒掉，而拒绝的后果是
 *    `getDisplayMedia` 直接 NotAllowedError —— 看起来像「采集功能坏了」。
 *
 * 环回地址一共就三种写法：`localhost` / `127.0.0.1` / `::1`。
 */
function isOwnUiUrl(raw: string): boolean {
  if (raw.startsWith('file://')) return true;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    // 空串 / 非法 URL：拿不到来源就不放行
    return false;
  }
}
