import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * TURN 凭据的**纯逻辑**部分：解析、校验、打码、存盘。
 *
 * --- 为什么要与 electron 拆开 ---
 *
 * 这个文件不 import `electron`，所以**可以在纯 node 里直接跑验收**
 * （`scripts/check-turn-ui.mjs` 就是这么做的）。
 * 之前把它和 `app.getPath()` 放在一起，一 import 就把 Electron 二进制拖进来，
 * 而本机 `ELECTRON_RUN_AS_NODE` 是预设的、electron 包在纯 node 下会炸 ——
 * 判据跑不起来，就等于没有判据。
 *
 * 路径由调用方注入（`configPath`），本文件只管「拿到路径之后怎么读写」。
 *
 * --- 为什么这里推翻了自己在 embedded-server.ts 里的原判断 ---
 *
 * 原来刻意做成「只从环境变量读、界面上不给输入框」，理由是
 * `TURN_KEY_SECRET` 是**计费凭据**，落盘就等于躺在磁盘上等人拷。
 *
 * 那个判断在「命令行玩家」前提下是对的，但代价是：
 * 想用 TURN 的人得先开一个 PowerShell 窗口、设两个变量、再从那个窗口启动 ——
 * 而 TURN 恰恰是**网络环境最差的那批人**才需要的（校园网 / 公司内网 / 手机流量），
 * 让最需要它的人去做最麻烦的事，是把难度放错了地方。
 *
 * 所以这里接受落盘，并把该做的防护做在明处：
 *
 * 1. **文件由调用方放在 `userData` 下**（Windows 上即 `%APPDATA%`，默认只有
 *    当前用户可读）；
 * 2. **界面上 secret 只在建出来的那一瞬间显示一次**，之后一律打码；
 * 3. **界面不回显 secret**，状态里只给 uid 的前 6 位；
 * 4. **环境变量仍然优先** —— 想临时换一组凭据照样能用。
 *
 * ⚠️ **这不是「更安全了」，是「更方便了」**。风险从「不落盘」变成
 * 「落一份本机明文」。仍然不要把 secret 发到群里、别提交进仓库 ——
 * 信令本身没有鉴权，谁读到它就能拿你的额度替别人中继。
 */

/** TURN 长期凭据。keyId 即 Cloudflare 的 uid，keySecret 即创建时返回的 key */
export interface TurnCredentials {
  keyId: string;
  keySecret: string;
}

/** 存盘的内容。刻意把 Cloudflare 账号也存下来 —— 下次想换 key 时不用重填 */
export interface PersistedTurn {
  keyId?: unknown;
  keySecret?: unknown;
  /** 建 key 时用的 Cloudflare 账号 id，只为「以后换 key」省一步。**不是凭据** */
  accountId?: unknown;
  /** 什么时候存的，仅用于排障，不参与任何判断 */
  createdAt?: unknown;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 解析已存的内容。
 *
 * **只认「两个字段都在且非空」**，否则一律当没配 —— 宁可说「没配」，
 * 也不能拿半套凭据去签发（那会得到一个必然失败的请求，
 * 而界面上看不出是「配错了」还是「网络不通」）。
 */
export function parsePersisted(raw: unknown): TurnCredentials | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as PersistedTurn;
  if (!isNonEmptyString(parsed.keyId) || !isNonEmptyString(parsed.keySecret)) return null;
  return { keyId: parsed.keyId.trim(), keySecret: parsed.keySecret.trim() };
}

/** 从已存内容里取 Cloudflare 账号 id（可能为空串） */
export function accountIdOf(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const parsed = raw as PersistedTurn;
  return isNonEmptyString(parsed.accountId) ? parsed.accountId.trim() : '';
}

/**
 * 读出已存的凭据。
 *
 * 读不出来 / 文件不存在 / JSON 坏了 / 只存了一半 ⇒ 当作没配。
 * **不报错、不弹窗**：TURN 是兜底不是前提，为它打扰用户是本末倒置
 * （与 embedded-server 同一原则）。
 */
export function loadTurnCredentialsFrom(configPath: string): TurnCredentials | null {
  try {
    return parsePersisted(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return null;
  }
}

/** 已存的 Cloudflare 账号 id（可能为空串） */
export function loadTurnAccountIdFrom(configPath: string): string {
  try {
    return accountIdOf(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return '';
  }
}

/**
 * 存盘。**写失败返回 false，不抛** —— 写不进去只影响「下次还记不记得」，
 * 不该让用户此刻就用不了 TURN。
 *
 * ⚠️ **刻意不写账号 token**：它的权限比 keySecret 大得多（能建/删这个账号下
 * 的所有 TURN key），而建完 key 就没用了，没有落盘的理由。
 */
export function saveTurnCredentialsTo(
  configPath: string,
  creds: TurnCredentials,
  accountId?: string,
): boolean {
  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    const payload = {
      keyId: creds.keyId,
      keySecret: creds.keySecret,
      ...(accountId ? { accountId } : {}),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 清除已存凭据。
 *
 * 写一个空对象而不是删文件：删文件要走删除通道（且本机那条通道是坏的，
 * 见 MEMORY 的环境约定），而写空对象效果一样且更稳。
 */
export function clearTurnCredentialsAt(configPath: string): boolean {
  try {
    writeFileSync(configPath, '{}\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 界面上显示用的 key 标识：只给前 6 位。**永不返回 secret** */
export function maskKeyId(keyId: string): string {
  return keyId.length <= 6 ? keyId : `${keyId.slice(0, 6)}…`;
}
