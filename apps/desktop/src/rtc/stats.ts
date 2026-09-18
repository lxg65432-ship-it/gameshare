import type { LinkStats, RouteInfo, VideoInbound, VideoOutbound } from './types';

/**
 * RTCPeerConnection 统计读取。
 *
 * 码率必须靠两次采样求差，getStats() 只给累计字节数。
 * 因此这里做成有状态的读取器，每次 read() 保留本次样本供下次做差。
 *
 * M1 用它来断言「画面真的通了」；M7 会在此基础上扩展 UI 展示。
 */

interface Sample {
  at: number;
  bytes: number;
  frames: number;
}

export class PeerStats {
  #prev = new Map<string, Sample>();

  /** 清掉历史样本，链路重建后必须调用，否则码率会算出负数或爆表 */
  reset(): void {
    this.#prev.clear();
  }

  async read(pc: RTCPeerConnection): Promise<LinkStats> {
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return { inbound: null, outbound: null, route: null };
    }

    const codecs = new Map<string, string>();
    const byId = new Map<string, Record<string, unknown>>();
    report.forEach((entry) => {
      const s = entry as unknown as Record<string, unknown>;
      byId.set(String(s.id), s);
      if (s.type === 'codec') {
        const mime = typeof s.mimeType === 'string' ? s.mimeType : '';
        const clock = typeof s.clockRate === 'number' ? ` ${s.clockRate / 1000}kHz` : '';
        codecs.set(String(s.id), `${mime}${clock}`);
      }
    });

    let inbound: VideoInbound | null = null;
    let outbound: VideoOutbound | null = null;

    for (const s of byId.values()) {
      if (s.type === 'inbound-rtp' && s.kind === 'video' && s.isRemote !== true) {
        inbound = this.#readInbound(s, codecs);
      } else if (s.type === 'outbound-rtp' && s.kind === 'video') {
        outbound = this.#readOutbound(s, codecs);
      }
    }

    return { inbound, outbound, route: this.#readRoute(byId) };
  }

  #diff(key: string, bytes: number, frames: number): { bitrateBps: number; fps: number } {
    const now = Date.now();
    const prev = this.#prev.get(key);
    this.#prev.set(key, { at: now, bytes, frames });
    if (!prev) return { bitrateBps: 0, fps: 0 };

    const dt = (now - prev.at) / 1000;
    if (dt <= 0) return { bitrateBps: 0, fps: 0 };

    return {
      // 计数器可能因重新协商回退，负数一律归零
      bitrateBps: Math.max(0, Math.round(((bytes - prev.bytes) * 8) / dt)),
      fps: Math.max(0, Math.round((frames - prev.frames) / dt)),
    };
  }

  #readInbound(s: Record<string, unknown>, codecs: Map<string, string>): VideoInbound {
    const bytes = num(s.bytesReceived);
    const frames = num(s.framesDecoded);
    const trackId = typeof s.trackIdentifier === 'string' ? s.trackIdentifier : String(s.id);
    const diff = this.#diff(`in:${trackId}`, bytes, frames);

    return {
      framesDecoded: frames,
      framesDropped: num(s.framesDropped),
      // 浏览器给的 framesPerSecond 在部分版本上缺失，用差分值兜底
      framesPerSecond: num(s.framesPerSecond) || diff.fps,
      keyFramesDecoded: num(s.keyFramesDecoded),
      bytesReceived: bytes,
      bitrateBps: diff.bitrateBps,
      packetsLost: num(s.packetsLost),
      jitter: round2(num(s.jitter)),
      frameWidth: num(s.frameWidth),
      frameHeight: num(s.frameHeight),
      codec: codecs.get(String(s.codecId)) ?? null,
    };
  }

  #readOutbound(s: Record<string, unknown>, codecs: Map<string, string>): VideoOutbound {
    const bytes = num(s.bytesSent);
    const frames = num(s.framesEncoded);
    const diff = this.#diff(`out:${String(s.id)}`, bytes, frames);

    return {
      framesEncoded: frames,
      framesPerSecond: num(s.framesPerSecond) || diff.fps,
      bytesSent: bytes,
      bitrateBps: diff.bitrateBps,
      qualityLimitationReason:
        typeof s.qualityLimitationReason === 'string' ? s.qualityLimitationReason : 'unknown',
      frameWidth: num(s.frameWidth),
      frameHeight: num(s.frameHeight),
      scaleResolutionDownBy: num(s.scaleResolutionDownBy) || 1,
      targetBitrate: typeof s.targetBitrate === 'number' ? s.targetBitrate : null,
      codec: codecs.get(String(s.codecId)) ?? null,
    };
  }

  /**
   * 找出实际承载媒体、且处于 succeeded 状态的候选对。
   *
   * 一条 PC 上可能有多个候选对（不同 m-line），只取真正在传流量的那个，
   * 否则会把 relay 链路误判成 P2P。
   */
  #readRoute(byId: Map<string, Record<string, unknown>>): RouteInfo | null {
    let best: Record<string, unknown> | null = null;
    let bestBytes = -1;

    for (const s of byId.values()) {
      if (s.type !== 'candidate-pair') continue;
      if (s.state !== 'succeeded' && s.nominated !== true) continue;
      const sent = num(s.bytesSent);
      const received = num(s.bytesReceived);
      if (sent === 0 && received === 0) continue;
      const total = sent + received;
      if (total > bestBytes) {
        bestBytes = total;
        best = s;
      }
    }

    if (!best) return null;

    const local = byId.get(String(best.localCandidateId));
    const remote = byId.get(String(best.remoteCandidateId));
    const localType = str(local?.candidateType) ?? 'unknown';
    const remoteType = str(remote?.candidateType) ?? 'unknown';

    return {
      localType,
      remoteType,
      protocol: str(local?.protocol) ?? str(remote?.protocol) ?? 'unknown',
      // 任一端是 relay，这条链路就走了 TURN
      relay: localType === 'relay' || remoteType === 'relay',
      currentRoundTripTime:
        typeof best.currentRoundTripTime === 'number' ? round2(best.currentRoundTripTime * 1000) : null,
      availableOutgoingBitrate:
        typeof best.availableOutgoingBitrate === 'number'
          ? Math.round(best.availableOutgoingBitrate)
          : null,
      localAddress: str(local?.address),
      remoteAddress: str(remote?.address),
    };
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
