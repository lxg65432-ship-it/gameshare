import os from 'node:os';

/**
 * 本机可用作信令服务器地址的 IP 枚举。
 *
 * 为什么要专门做这件事：
 * 「对方该填什么地址」这个问题在不同网络环境下答案完全不同——
 * 同一个局域网填内网 IP，跨运营商要填公网 IP，而本机如果拿到公网 IPv6，
 * 那才是真正全球可达、且完全绕过 NAT 的一条路。让用户自己去 ipconfig 里
 * 挑，挑错的表现是「一直转圈连不上」，排查成本极高。
 *
 * 这里只负责「列出候选」，不做可达性判断——入站能不能通取决于路由器和防火墙，
 * 必须要外部视角才能验证（见 docs 里的跨网测试指引）。
 */

export type AddressKind = 'lan' | 'public';

export interface AdvertisableAddress {
  family: 4 | 6;
  address: string;
  interfaceName: string;
  kind: AddressKind;
  /** 对方可直接粘贴到客户端输入框里的 URL */
  url: string;
  /** 人话说明，用于日志和界面展示 */
  note: string;
}

export interface AdvertisableAddresses {
  /** 私网 IPv4，仅同一局域网可用 */
  lan: AdvertisableAddress[];
  /** 公网 IPv4（家宽一般没有，除非单独申请过） */
  publicV4: AdvertisableAddress[];
  /** 公网 IPv6，全球可达，但需要路由器放行入站 */
  publicV6: AdvertisableAddress[];
  all: AdvertisableAddress[];
}

/** 私有 / 保留 IPv4 判断 */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // APIPA
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/**
 * 公网可路由 IPv6 判断。
 * 排除环回、link-local（fe80::/10）、ULA（fc00::/7）、组播（ff00::/8）、
 * IPv4 映射地址，以及带 zone id 的地址（%ens0 这种只在链路内有意义）。
 */
function isPublicIpv6(address: string): boolean {
  if (address.includes('%')) return false;
  const lower = address.toLowerCase();
  if (lower === '::1') return false;
  if (lower.startsWith('::ffff:')) return false;
  if (lower.startsWith('fe8') || lower.startsWith('fe9')) return false;
  if (lower.startsWith('fea') || lower.startsWith('feb')) return false;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false;
  if (lower.startsWith('ff')) return false;
  return true;
}

/** IPv6 地址放进 URL 必须用方括号包裹，否则冒号会被当成分隔符 */
export function formatHostForUrl(address: string, family: 4 | 6): string {
  return family === 6 ? `[${address}]` : address;
}

export function buildUrl(address: string, family: 4 | 6, port: number): string {
  return `http://${formatHostForUrl(address, family)}:${port}`;
}

export function listAdvertisableAddresses(port: number): AdvertisableAddresses {
  const result: AdvertisableAddresses = { lan: [], publicV4: [], publicV6: [], all: [] };

  for (const [interfaceName, addresses] of Object.entries(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue;

      if (entry.family === 'IPv4') {
        const kind: AddressKind = isPrivateIpv4(entry.address) ? 'lan' : 'public';
        const item: AdvertisableAddress = {
          family: 4,
          address: entry.address,
          interfaceName,
          kind,
          url: buildUrl(entry.address, 4, port),
          note: kind === 'lan' ? '同一局域网可用' : '公网 IPv4',
        };
        (kind === 'lan' ? result.lan : result.publicV4).push(item);
        result.all.push(item);
      } else if (entry.family === 'IPv6' && isPublicIpv6(entry.address)) {
        const item: AdvertisableAddress = {
          family: 6,
          address: entry.address,
          interfaceName,
          kind: 'public',
          url: buildUrl(entry.address, 6, port),
          note: '公网 IPv6，跨网络可达（需路由器放行入站）',
        };
        result.publicV6.push(item);
        result.all.push(item);
      }
    }
  }

  return result;
}

/**
 * 按推荐优先级给出「最可能让对方连上的那个地址」。
 *
 * 顺序是刻意的：公网 IPv6 排第一。它不需要经过 NAT 映射，
 * 只要路由器放行入站就能直达；而内网 IPv4 只在同一局域网成立。
 */
export function pickRecommended(addresses: AdvertisableAddresses): AdvertisableAddress | null {
  return addresses.publicV6[0] ?? addresses.publicV4[0] ?? addresses.lan[0] ?? null;
}

/**
 * 生成给用户看的地址清单文本行。
 *
 * 独立服务、内嵌服务、一键启动脚本三处都要打印同样的内容，
 * 集中在这里免得三份格式各自漂移。
 */
export function formatAddressLines(addresses: AdvertisableAddresses, port: number): string[] {
  const lines: string[] = [];

  if (addresses.publicV6.length > 0) {
    lines.push('  公网 IPv6 —— 跨网络首选，不需要 NAT 映射');
    for (const item of addresses.publicV6) lines.push(`      ${item.url}`);
    lines.push('      需要路由器放行该端口入站，否则外网仍连不上（见 docs）');
    lines.push('');
  }

  if (addresses.publicV4.length > 0) {
    lines.push('  公网 IPv4');
    for (const item of addresses.publicV4) lines.push(`      ${item.url}`);
    lines.push('');
  }

  if (addresses.lan.length > 0) {
    lines.push('  局域网 IPv4 —— 只有连同一个路由器的设备能连');
    for (const item of addresses.lan) lines.push(`      ${item.url}`);
    lines.push('');
  }

  if (addresses.all.length === 0) {
    lines.push('  （没找到任何可用地址，检查网络连接）');
    lines.push('');
  }

  lines.push(`  本机自测            http://localhost:${port}`);
  return lines;
}
