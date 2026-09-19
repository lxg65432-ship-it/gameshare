/**
 * 画质档位定义 —— 对应规格文档第 4 节「动态画质机制」。
 *
 * 重要约束（写死数值会炸的点）：
 * RTCRtpSender 的 scaleResolutionDownBy 只能「缩小」，不能放大，
 * 且基准是采集源的实际编码分辨率（track.getSettings().height），
 * 而不是显示器分辨率。因此这里只声明「目标高度」，
 * 实际缩放系数由 computeScaleResolutionDownBy() 在运行时按源换算。
 */

export const QualityLevel = {
  THUMBNAIL: 'THUMBNAIL',
  GRID: 'GRID',
  FOCUS: 'FOCUS',
  FOCUS_HIGH: 'FOCUS_HIGH',
} as const;

export type QualityLevel = (typeof QualityLevel)[keyof typeof QualityLevel];

export interface QualityProfile {
  readonly level: QualityLevel;
  /** 用于 UI 展示，如 540p30 */
  readonly label: string;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly maxFramerate: number;
  /** 目标码率上限，单位 bps */
  readonly maxBitrate: number;
  /** 拥塞控制下限，防止弱网下码率被压到完全糊掉 */
  readonly minBitrate: number;
}

export const QUALITY_PROFILES: Readonly<Record<QualityLevel, QualityProfile>> = {
  THUMBNAIL: {
    level: QualityLevel.THUMBNAIL,
    label: '360p30',
    targetWidth: 640,
    targetHeight: 360,
    maxFramerate: 30,
    maxBitrate: 700_000,
    minBitrate: 250_000,
  },
  GRID: {
    level: QualityLevel.GRID,
    label: '540p30',
    targetWidth: 960,
    targetHeight: 540,
    maxFramerate: 60,
    maxBitrate: 1_500_000,
    minBitrate: 400_000,
  },
  FOCUS: {
    level: QualityLevel.FOCUS,
    label: '1080p30',
    targetWidth: 1920,
    targetHeight: 1080,
    maxFramerate: 120,
    maxBitrate: 4_000_000,
    minBitrate: 1_200_000,
  },
  FOCUS_HIGH: {
    level: QualityLevel.FOCUS_HIGH,
    label: '1080p60',
    targetWidth: 1920,
    targetHeight: 1080,
    maxFramerate: 120,
    maxBitrate: 6_000_000,
    minBitrate: 2_000_000,
  },
};

/** 默认档位：普通分屏 = GRID = 540p30 */
export const DEFAULT_QUALITY: QualityLevel = QualityLevel.GRID;

/** 由低到高排序，UI 调节画质时按这个顺序循环 */
export const QUALITY_ORDER: readonly QualityLevel[] = [
  QualityLevel.THUMBNAIL,
  QualityLevel.GRID,
  QualityLevel.FOCUS,
  QualityLevel.FOCUS_HIGH,
];

export function isQualityLevel(value: unknown): value is QualityLevel {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(QUALITY_PROFILES, value)
  );
}

export function getProfile(level: QualityLevel): QualityProfile {
  return QUALITY_PROFILES[level];
}

/**
 * 换算 scaleResolutionDownBy。
 *
 * 返回值 >= 1：源本身就小于等于目标档位时返回 1
 * （WebRTC 不接受 scaleResolutionDownBy < 1，那等于放大会被忽略）。
 */
export function computeScaleResolutionDownBy(
  sourceHeight: number | undefined | null,
  targetHeight: number,
): number {
  if (!sourceHeight || sourceHeight <= 0) return 1;
  if (sourceHeight <= targetHeight) return 1;
  return sourceHeight / targetHeight;
}

/**
 * 档位标称的 maxBitrate / maxFramerate 都按 1080p@30 的基准设计。
 * 源比基准大（2K 带鱼屏 = 1080p 的 2.4 倍像素）或帧率更高时，
 * 按比例放宽编码上限 —— 上限不放宽，编码器在 degradationPreference='motion'
 * 下会把分辨率压得很低来保帧率，表现为「点了放大画面还是糊」。
 *
 * **只放大、不缩小**：源小于基准时保持标称值 —— 小源本来就吃不满标称预算，
 * 保留较高上限交给拥塞控制自适应即可，也保住了既有验收断言（合成源 720p
 * 下 FOCUS 仍是 4 Mbps）。
 *
 * 帧率因子用 sqrt（运动内容的码率随帧率亚线性增长），像素因子线性。
 * 整体钳在 24 Mbps：超过这个量级说明该降档而不是再加预算。
 */
const REF_PIXELS = 1920 * 1080;
const REF_FPS = 30;
const MAX_BITRATE_CAP = 24_000_000;

export function computeMaxBitrate(
  profile: QualityProfile,
  sourceWidth: number | undefined | null,
  sourceHeight: number | undefined | null,
  fps: number,
): number {
  let factor = 1;
  const pixels = (sourceWidth ?? 0) * (sourceHeight ?? 0);
  if (pixels > REF_PIXELS) factor *= pixels / REF_PIXELS;
  if (fps > REF_FPS) factor *= Math.sqrt(fps / REF_FPS);
  return Math.round(Math.min(profile.maxBitrate * factor, MAX_BITRATE_CAP));
}

/**
 * 编码帧率的实际取值 = min(档位上限, 用户选择的共享帧率)。
 *
 * 档位上限是「这一档允许到多高」：缩略条 30 帧足够（120 帧的缩略图纯烧带宽），
 * 网格 60，主画面放宽到 120。用户选择是「我愿意以多高帧率共享」——
 * 两者的较小值才是落下去的值。
 */
export function computeMaxFramerate(profile: QualityProfile, userFps: number): number {
  return Math.min(profile.maxFramerate, userFps);
}
