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
    maxFramerate: 30,
    maxBitrate: 1_500_000,
    minBitrate: 400_000,
  },
  FOCUS: {
    level: QualityLevel.FOCUS,
    label: '1080p30',
    targetWidth: 1920,
    targetHeight: 1080,
    maxFramerate: 30,
    maxBitrate: 4_000_000,
    minBitrate: 1_200_000,
  },
  FOCUS_HIGH: {
    level: QualityLevel.FOCUS_HIGH,
    label: '1080p60',
    targetWidth: 1920,
    targetHeight: 1080,
    maxFramerate: 60,
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
