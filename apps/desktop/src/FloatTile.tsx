import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getLang, subscribeLang, t } from './i18n';

/** 语言订阅（与 App 的 useI18n 同构；小窗是独立组件树，自己挂一份） */
const useI18n = (): typeof t => {
  useSyncExternalStore(subscribeLang, getLang);
  return t;
};

/**
 * 拆分模式下的小窗页面：一个原生窗口里只画**一路**画面。
 *
 * 它是同一个 `index.html` 的另一种形态 —— 主进程用 `?floatTile=<序号>` 把它区分开
 * （见 `src/main.tsx`）。判断依据是 URL，不是后端状态：这样热更新、窗口重载
 * 都不会把它认错成主窗口。
 *
 * 为什么是 canvas 而不是 `<video>`：小窗**拿不到轨道**。
 * `MediaStreamTrack` 与 `MediaStream` 都不是可转移对象，过不了进程边界
 * （实测见 `scripts/_probe-track-xfer.cjs`），所以画面由主窗口当帧泵搬过来
 * —— 一帧一个 `ImageBitmap`，走 MessagePort 的 transfer list。
 * 代价是 video 元素自带的东西都要自绘，好处是**拖大不会糊**：
 * 每帧都是从源的全分辨率重新缩放的。
 */

interface DragState {
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  winX: number;
  winY: number;
  winW: number;
  winH: number;
}

export default function FloatTile() {
  const t = useI18n();
  const params = new URLSearchParams(window.location.search);
  const index = params.get('floatTile') ?? '0';

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasFrameRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);

  /**
   * 对端身份是**状态**，不是常量。
   *
   * URL 参数只是「建窗那一刻」的快照。同一个序号换了人时主进程**不会重新导航**
   * 这个窗口（重建会闪一下），它把新身份跟着新通道一起送过来（见 float-tiles.ts
   * 的 connectTile）。所以这里必须跟着通道更新 —— 否则小窗会一直挂着上一个人的
   * 名字，而「静音这一路」还会发给一个已经不在房间里的人。
   */
  const [peerId, setPeerId] = useState(params.get('peer') ?? '');
  const [name, setName] = useState(params.get('name') ?? t('tileFloat.defaultPeer'));
  const [muted, setMuted] = useState(params.get('muted') === '1');

  const [hasFrame, setHasFrame] = useState(false);
  const [hovering, setHovering] = useState(false);

  /**
   * 上报客户区尺寸。
   *
   * 帧泵按**小窗的实际像素**缩放，所以这个数字必须准 —— 报错了的画面不是拉伸
   * 就是糊。窗口一被拖动大小就要重报，而且首次要**主动报一次**：
   * 主进程建窗时给的尺寸未必等于渲染完成后的客户区尺寸。
   */
  useEffect(() => {
    const api = window.gameShareTile;
    const report = (): void => {
      api?.reportSize(window.innerWidth, window.innerHeight);
    };
    report();
    window.addEventListener('resize', report);
    return () => window.removeEventListener('resize', report);
  }, []);

  /* ---------------- 收帧并绘制 ---------------- */

  useEffect(() => {
    const api = window.gameShareTile;
    const canvas = canvasRef.current;
    if (!api || !canvas) return undefined;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return undefined;

    let alive = true;
    const unsubscribe = api.onPort((port, meta) => {
      // 身份跟着通道走：同一个序号换了人时这个窗口不会重新导航，
      // 新名字与新 peerId 只能从新通道的 meta 上取（见 float-tiles.ts 的 connectTile）
      setPeerId(meta.peerId);
      setName(meta.name);

      port.onmessage = (event: MessageEvent): void => {
        if (!alive) return;
        const bmp = (event.data as { bmp?: ImageBitmap } | null)?.bmp;
        if (!bmp) return;

        // canvas 的像素尺寸跟窗口客户区走：1:1 绘制，不经浏览器缩放（更清晰）
        const cw = canvas.clientWidth || bmp.width;
        const ch = canvas.clientHeight || bmp.height;
        if (canvas.width !== cw || canvas.height !== ch) {
          canvas.width = cw;
          canvas.height = ch;
        }

        // 居中 + letterbox。帧泵是按**源的宽高比**缩放的，窗口比例不对时留黑边，
        // 而不是把画面拉变形 —— 看游戏画面时变形比黑边难受得多。
        const scale = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
        const w = bmp.width * scale;
        const h = bmp.height * scale;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        bmp.close();

        if (!hasFrameRef.current) {
          hasFrameRef.current = true;
          setHasFrame(true);
        }
      };
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  /* ---------------- 静音状态跟着主窗口走 ---------------- */

  useEffect(() => {
    const api = window.gameShareTile;
    if (!api) return undefined;
    return api.onMuted((next) => setMuted(next));
  }, []);

  /* ---------------- 拖动与缩放 ---------------- */

  /**
   * 拖动与缩放全部走 IPC 自绘，**不用 `-webkit-app-region: drag`，也不用系统边框**。
   *
   * 原因：小窗是 `setFocusable(false)` 的（不可激活）。而系统的窗口拖动 / 边框缩放
   * 都会先激活窗口 —— 一拖就把游戏弄失焦，「调出浮窗后游戏不能操控」那个毛病
   * 会原样回来。自己算屏幕坐标再让主进程 `setBounds` 与激活无关，行为确定。
   */
  const beginDrag = useCallback(
    (mode: DragState['mode']) =>
      (event: React.PointerEvent<HTMLElement>): void => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = {
          mode,
          startX: event.screenX,
          startY: event.screenY,
          winX: window.screenX,
          winY: window.screenY,
          winW: window.innerWidth,
          winH: window.innerHeight,
        };
      },
    [],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const api = window.gameShareTile;
    if (!api) return;
    const dx = event.screenX - drag.startX;
    const dy = event.screenY - drag.startY;
    if (drag.mode === 'move') {
      // 尺寸一并下发（按下时锁定）：主进程不用每帧展开 getBounds()，
      // 非 100% 缩放屏上的 roundtrip 取整误差就不会逐帧累积成「拖动变大」。
      api.moveTo(drag.winX + dx, drag.winY + dy, drag.winW, drag.winH);
    } else {
      api.resizeTo(drag.winW + dx, drag.winH + dy);
    }
  }, []);

  const endDrag = useCallback((): void => {
    dragRef.current = null;
  }, []);

  const toggleMute = useCallback((): void => {
    // 声音在主窗口出，这里只是开关：把请求转过去，等主窗口把新状态推回来
    window.gameShareTile?.toggleMute(peerId);
  }, [peerId]);

  return (
    <div
      className={`tilewin${hasFrame ? '' : ' tilewin--idle'}`}
      data-tile-index={index}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
      onPointerDown={beginDrag('move')}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <canvas ref={canvasRef} className="tilewin__canvas" />

      {!hasFrame && <div className="tilewin__wait">{t('tileFloat.waiting')}</div>}

      {/*
        名字**常驻**，不跟着悬浮条一起隐。
        早先它挂在下面那条 hover 才浮出来的条里 —— 拆分之后几个小窗长得一模一样，
        想分清哪个是谁得把鼠标逐个划过去，实用上等于没有。
        静音状态也借它一并常驻（只在别处 hover 才看得到的话，画面在动却没人出声，
        用户会先去怀疑画面而不是去怀疑静音）。
      */}
      <span className={`tilewin__name${muted ? ' tilewin__name--muted' : ''}`} title={name}>
        {name}
      </span>

      <div className={`tilewin__bar${hovering ? ' tilewin__bar--on' : ''}`}>
        <button
          type="button"
          className={`tilewin__mute${muted ? ' tilewin__mute--on' : ''}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggleMute}
          title={muted ? t('tileFloat.unmuteTitle') : t('tileFloat.muteTitle')}
        >
          {muted ? t('tileFloat.muted') : t('tileFloat.live')}
        </button>
      </div>

      {/* 缩放靠这个角：窗口是 frame:false 且 thickFrame:false，没有系统边框可拖 */}
      <div
        className={`tilewin__grip${hovering ? ' tilewin__grip--on' : ''}`}
        onPointerDown={(event) => {
          event.stopPropagation();
          beginDrag('resize')(event);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title={t('tileFloat.gripTitle')}
      />
    </div>
  );
}
