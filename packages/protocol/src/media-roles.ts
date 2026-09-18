/**
 * 媒体轨道角色 —— 「哪条 m-line 是什么」的**唯一来源**。
 *
 * 每个玩家最多同时拥有三条互相独立的轨道：
 *
 * | 角色 | 内容 | 媒体类型 | 谁来采集 |
 * |---|---|---|---|
 * | `video` | 共享的窗口 / 屏幕 | video | `CaptureManager.startDisplay` |
 * | `voice` | 麦克风 | audio | `MicCapture`（AEC / NS / AGC） |
 * | `appAudio` | 被共享应用 / 整机的声音 | audio | 同一次桌面捕获的音频轨 |
 *
 * --- 为什么 `voice` 与 `appAudio` 必须是**两条** m-line，而不是混成一条 ---
 *
 * 三层理由，任一条都够：
 *   1. **接收端要能分别控制**（只静音游戏声、或只调语音音量）。混一条就再也分不开了。
 *   2. **opus 的编码策略对语音和音乐是相斥的**（语音要窄带 + DTX + 强 FEC，
 *      音乐要宽带 + 高码率）。混在一起编码器只能二选一，语音必然吃亏。
 *   3. 麦克风要开 AEC/NS/AGC，而系统回环**绝不能开**那套（会把音乐削掉）。
 *      两者约束不同源，混轨就没法各自带着自己的约束走完整条链路。
 *
 * --- m-line 顺序是硬约束 ---
 *
 * `TRACK_ROLES` 的**顺序就是 m-line 顺序**，两端必须一致：
 * 主动方按这个顺序 `addTransceiver`，被动方的 m-line 由对方的 offer 建出来，
 * 顺序反了直接报 `The order of m-lines in answer doesn't match order in offer`。
 *
 * ⚠️ **别把这里的「顺序」和 `stream.getAudioTracks()[0]` 那种数组下标混为一谈。**
 * 数组下标会随轨道增删、replaceTrack、重排而变，所以拿它认角色是错的；
 * 而 m-line 顺序是**协商产物**，一旦定下就不会变（本项目的 transceiver 建好之后
 * 只做 replaceTrack，从不重建），并且两端看到的是同一份。
 */

/** 三条轨的角色。**数组顺序即 m-line 顺序，改动它等于改协议。** */
export const TRACK_ROLES = ['video', 'voice', 'appAudio'] as const;

export type TrackRole = (typeof TRACK_ROLES)[number];

/** 每条角色落在 SDP 里的媒体类型。`voice` 与 `appAudio` 同为 audio，但是两条独立 m-line。 */
export const ROLE_MEDIA_KIND: Readonly<Record<TrackRole, 'video' | 'audio'>> = {
  video: 'video',
  voice: 'audio',
  appAudio: 'audio',
};

export function isTrackRole(value: unknown): value is TrackRole {
  return typeof value === 'string' && (TRACK_ROLES as readonly string[]).includes(value);
}

/** 角色 → m-line 序号 */
export function mLineIndexForRole(role: TrackRole): number {
  return TRACK_ROLES.indexOf(role);
}

/** m-line 序号 → 角色；越界返回 null（不猜） */
export function roleForMLineIndex(index: number): TrackRole | null {
  if (!Number.isInteger(index) || index < 0 || index >= TRACK_ROLES.length) return null;
  return TRACK_ROLES[index] ?? null;
}

/**
 * mid → 角色。
 *
 * Chromium 把 m-line 在 SDP 里的序号直接当作 mid（`"0"` / `"1"` / `"2"`），
 * 而且**这个 mid 是主动方在 offer 里定的，被动方的 transceiver 继承同一份** ——
 * 所以两端算出来的角色必然一致。
 *
 * 认不出来（null、非数字、越界）一律返回 `null`，由调用方去报错 —— 绝不退回
 * 「那就当它是第一条音频吧」。
 */
export function roleForMid(mid: string | null | undefined): TrackRole | null {
  if (mid === null || mid === undefined) return null;
  if (!/^\d+$/.test(mid)) return null;
  return roleForMLineIndex(Number(mid));
}

/**
 * 按角色组织的映射。
 *
 * 刻意做成泛型而不是直接写 `MediaStreamTrack`：`packages/protocol` 是**要给
 * 服务端也编译的**，那边没有 DOM 类型（`MediaStreamTrack` 压根不存在）。
 * 桌面端自己把它具体化成 `RoleMap<MediaStreamTrack | null>`，
 * 见 `apps/desktop/src/rtc/types.ts` 的 `LocalTracks` / `RemoteTracks`。
 */
export type RoleMap<T> = Record<TrackRole, T>;

/** 三条角色齐全、值都一样的映射。用来造「初始全空」的轨道表。 */
export function roleMap<T>(value: T): RoleMap<T> {
  return { video: value, voice: value, appAudio: value };
}
