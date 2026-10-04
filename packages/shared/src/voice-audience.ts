/**
 * 远端声音的「该给谁放」判据。
 *
 * --- 这条判据解决什么 ---
 *
 * 浮窗只摆**正在共享**的那几格（`floatPeers` 按 `remoteSharing` 过滤），
 * 而**语音轨与共享是解耦的**（`stopShare` 明确只摘 video + appAudio，不摘 voice）。
 *
 * 两者一拼就出过一个真 bug：`<audio>` 元素当时挂在 tile 里，
 * 于是「能不能听见」取决于「格子在不在」——
 * **开着麦但没共享画面的人，在浮窗里完全听不见**。
 * 而「边打游戏边听队友」正是浮窗的主场景，所以这是功能缺失、不是提示缺失。
 *
 * 常规模式为什么没暴露：那里按成员列表渲染全部格子，不看 `remoteSharing`，
 * 人人都有格子、人人都有播放器。浮窗是唯一会过滤的分支。
 *
 * --- 为什么做成纯函数 ---
 *
 * 这条判据的 bug 形态是「位置错了」：播放器被挪进了某个会过滤的分支里。
 * 而这种 bug **静态断言抓不到**（源码里 `<audio>` 字面量一直都在），
 * 渲染测试又太重。所以把「谁该被听见」从 JSX 的隐含逻辑里提成数据：
 * 判据独立可测，而调用它的位置只有一处，搬错了 typecheck / lint 会红。
 *
 * ⚠️ **别把 `sharing` 掺进这个判据。** 一掺就等于把「画面格子在不在」
 * 重新绑回「声音在不在」，那个 bug 原样回来。判据只认**音轨**。
 */

/** 远端三条轨的最小形状（与 rtc 层同构，这里只取判据要用的两条） */
export interface RoleTracksLike {
  voice?: unknown | null;
  appAudio?: unknown | null;
}

/** 判据输入：一个人此刻的状况 */
export interface VoiceAudienceInput {
  peerId: string;
  /** 该成员此刻在不在共享画面。**判据不看它** —— 留着是为了让调用处的意图明确 */
  sharing: boolean;
  /** 该成员此刻的远端音轨 */
  tracks: RoleTracksLike | null;
}

/**
 * 该成员此刻**有没有需要播放的东西**。
 *
 * 判据只有一条：**手上有没有音轨**。
 *
 * 有 `voice` ⇒ 有人在说话，该出声。
 * 有 `appAudio` ⇒ 对方在共享带声音的应用（此时他一定也在共享画面，
 * 但那不需要我们检查 —— 音轨本身就是证据）。
 * 两条都没有 ⇒ 不出声。
 *
 * 刻意**不看** `sharing`：见文件头「别把 sharing 掺进来」。
 */
export function hasRemoteAudio(input: VoiceAudienceInput): boolean {
  const { tracks } = input;
  if (!tracks) return false;
  return Boolean(tracks.voice) || Boolean(tracks.appAudio);
}

/**
 * 该放声音的全部成员（已滤掉自己与无音轨的人）。
 *
 * 返回**有序**结果而不是布尔：调用处要按它渲染元素，
 * 顺序变化会牵动 DOM 复用，所以判据里排一次比在 JSX 里散着过滤更好查。
 */
export function remoteAudioAudience(
  inputs: readonly VoiceAudienceInput[],
  selfPeerId: string,
): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    if (input.peerId === selfPeerId) continue;
    if (!hasRemoteAudio(input)) continue;
    out.push(input.peerId);
  }
  return out;
}
