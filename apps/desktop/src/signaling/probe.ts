import {
  classifyProbe,
  type ServerReachability,
} from '@game-share/shared';

/**
 * 信令地址的主动探测。
 *
 * 为什么要有这一步：Socket.IO 的 `connect_error` 只有一句
 * `xhr poll error`，而「对方隧道重启了」与「对方服务没起」共用这一句话。
 * 只靠它无法区分，而两者的处置完全相反（详见 shared/reachability.ts）。
 *
 * 探测的是 `/health` 而不是根路径：`/` 也能返回 JSON，但 `/health` 的语义更明确，
 * 且不依赖对方的页面路由 —— 万一对方在前面挂了反向代理，两个路径的表现可能不同。
 */

/** 探测超时。短一点：这一步在用户的等待路径上，不能拖慢太多 */
const PROBE_TIMEOUT_MS = 6_000;

/** 响应体最多读这么多字节。判据只需要看出「对面是谁」 */
const MAX_BODY_BYTES = 4_096;

/**
 * 探一个地址，返回「对面是谁」。
 *
 * **永不抛**：探测失败本身就是一种结论（`unreachable`），
 * 让它抛会把「诊断功能」变成「新的故障源」。
 */
export async function probeSignalingAddress(url: string): Promise<ServerReachability> {
  const base = url.trim();
  if (base === '') return 'unknown';

  // 补协议：用户手输时常常只填 `localhost:8080` 那样没协议的地址
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `http://${base}`;
  const target = `${withProtocol.replace(/\/+$/, '')}/health`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      method: 'GET',
      signal: controller.signal,
      // 明确不要任何缓存：同一个地址在隧道重启后可能从「本应用」变成
      // 「Cloudflare 错误页」，缓存会让判据停在过去。
      cache: 'no-store',
      headers: { accept: 'application/json, text/html;q=0.9, */*;q=0.8' },
    });

    // 读一点就够判身份，且必须**限制长度**：
    // 对方挂个大页面时，readToEnd 会把它整个拉进内存。
    const body = await readBounded(response);
    return classifyProbe(response.status, body);
  } catch (err) {
    // AbortError = 超时；TypeError = DNS/连接失败。
    // 两者都归到 unreachable：都是「没有应答」。
    if (err instanceof Error && err.name === 'AbortError') return 'unreachable';
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

/** 读响应体但最多取 `MAX_BODY_BYTES`，超了用流取消 */
async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  // 没有流（老环境 / 某些 polyfill）就直接读
  if (!body || typeof body.getReader !== 'function') {
    try {
      return (await response.text()).slice(0, MAX_BODY_BYTES);
    } catch {
      return '';
    }
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= MAX_BODY_BYTES) {
        // 主动取消：别为了 4 KB 的判据把对方的整个页面读完
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    // 读一半失败不算失败：已经拿到的部分可能已经够判身份
  } finally {
    reader.releaseLock?.();
  }
  return text.slice(0, MAX_BODY_BYTES);
}
