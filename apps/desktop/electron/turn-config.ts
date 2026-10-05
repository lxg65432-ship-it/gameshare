/**
 * TURN 凭据的入口：把「存在哪」与「怎么建」接起来。
 *
 * 刻意分成两个文件：
 *   · `turn-store.ts` —— 纯逻辑（解析 / 校验 / 打码 / 读写），**不 import electron**，
 *     所以能在纯 node 里跑验收（见 scripts/check-turn-ui.mjs）；
 *   · 本文件 —— 决定路径（`userData` 下）、调 Cloudflare API 建 key、重启信令。
 *
 * 为什么值得多一个文件：本机 `ELECTRON_RUN_AS_NODE` 是预设的，
 * electron 包在纯 node 下 import 就炸 —— 判据跑不起来就等于没有判据。
 * 那个文件头还记着「为什么推翻原来不给输入框的判断」。
 */
import { app } from 'electron';
import path from 'node:path';

import {
  accountIdOf,
  clearTurnCredentialsAt,
  hasHardFormatIssue,
  inspectTurnFormat,
  loadTurnAccountIdFrom,
  loadTurnCredentialsFrom,
  maskKeyId,
  saveTurnCredentialsTo,
  type TurnCredentials,
} from './turn-store';

export { hasHardFormatIssue, inspectTurnFormat, maskKeyId };
export type { TurnCredentials };

/**
 * 凭据文件位置：`userData` 下，与浮窗尺寸 / 窗口模式那几个配置同处一地。
 *
 * Windows 上即 `%APPDATA%\<appname>\`，**默认只有当前用户可读** ——
 * 这是「明文落盘」这件事唯一实际生效的防护，所以路径不挪到项目目录。
 */
function configPath(): string {
  return path.join(app.getPath('userData'), 'turn-credentials.json');
}

/** 读出已存的凭据；没有则 null（理由见 turn-store.ts） */
export function loadTurnCredentials(): TurnCredentials | null {
  return loadTurnCredentialsFrom(configPath());
}

/** 已存的 Cloudflare 账号 id（可能为空串） */
export function loadTurnAccountId(): string {
  return loadTurnAccountIdFrom(configPath());
}

export function saveTurnCredentials(creds: TurnCredentials, accountId?: string): boolean {
  return saveTurnCredentialsTo(configPath(), creds, accountId);
}

export function clearTurnCredentials(): boolean {
  return clearTurnCredentialsAt(configPath());
}

/** 把已存内容原样解出来（给状态自述用；解析不了就是没配） */
export function accountIdFromRaw(raw: unknown): string {
  return accountIdOf(raw);
}

/* ------------------------------------------------------------------ *
 * 程序化创建 TURN key
 * ------------------------------------------------------------------ */

/** Cloudflare 建 key 的端点。**不是凭证签发端点**（那个在 rtc.live.cloudflare.com） */
const CF_TURN_KEYS = 'https://api.cloudflare.com/client/v4';

/** 建 key 的超时。给 10s：跨洋到 Cloudflare 边缘，冷启动可能慢 */
const CREATE_TIMEOUT_MS = 10_000;

export interface CreateKeyResult {
  ok: boolean;
  keyId?: string;
  keySecret?: string;
  /** 失败原因（直接可显示） */
  error?: string;
}

/**
 * 调 Cloudflare API 建一个 TURN key。
 *
 * 需要一个 **Calls Write 权限**的 API Token —— 那是账号级凭据，
 * 拿到它的人能建/删这个账号下的 TURN key。**只在建 key 这一次用**，
 * 本程序不把它存下来（建完就丢，只留结果）—— 这与 keySecret 的处理刻意不同：
 * keySecret 之后每次建房都要用，而账号 token 建完就没用了。
 *
 * 失败一律**带原因返回**，不抛：TURN 是兜底，失败不该把建房流程搞崩。
 */
export async function createTurnKey(
  accountId: string,
  apiToken: string,
): Promise<CreateKeyResult> {
  if (!accountId.trim() || !apiToken.trim()) {
    return { ok: false, error: 'Cloudflare 账号 ID 和 API Token 都要填' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${CF_TURN_KEYS}/accounts/${encodeURIComponent(accountId.trim())}/calls/turn_keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'gameshare' }),
      signal: controller.signal,
    });

    const raw = (await res.json().catch(() => null)) as
      | {
          success?: unknown;
          /**
           * ⚠️ **字段名 `key` 是文档里的，真实响应里叫 `secret`** ——
           * 2026-10-05 对着真账号建 key 实测确认。只读 `key` 会永远拿不到，
           * 而 `createTurnKey` 明明建成功了却报「接口形状可能变了」，
           * 是个**把成功报成失败**的洞。两个都认。
           */
          result?: { uid?: unknown; key?: unknown; secret?: unknown };
          errors?: Array<{ message?: unknown }>;
        }
      | null;

    if (!res.ok) {
      // Cloudflare 的错误正文有两种形状：带 errors 数组，或者只有状态码
      const detail = Array.isArray(raw?.errors)
        ? raw.errors.map((e) => String(e?.message ?? '')).filter(Boolean).join('；')
        : '';
      return {
        ok: false,
        error: `创建失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}。检查账号 ID 与 token 权限（需 Calls Write）`,
      };
    }

    const uid = raw?.result?.uid;
    // 文档写 key，实测是 secret。两个都认，谁有算谁的（2026-10-05 实测）
    const secret = firstNonEmptyString(raw?.result?.secret, raw?.result?.key);
    if (typeof uid !== 'string' || uid.trim() === '' || secret === null) {
      // 这条不能静默：响应形状变了却照样返回「成功」，用户会以为配好了其实没配
      return { ok: false, error: '响应里没有 uid / secret —— Cloudflare 接口形状可能变了' };
    }

    return { ok: true, keyId: uid.trim(), keySecret: secret };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: controller.signal.aborted
        ? `请求超时（${CREATE_TIMEOUT_MS / 1000}s）—— 可能是网络问题`
        : `请求失败：${reason}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 取第一个非空字符串，全都不是字符串或都空 ⇒ null */
function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}
