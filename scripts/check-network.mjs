#!/usr/bin/env node
/**
 * 本机 P2P 能力诊断。
 *
 * 回答一个问题：这台机器有没有资格谈「异地直连」，以及路在哪一条。
 * 换网络环境（换 WiFi、换运营商、开/关代理）后都该重跑一次，
 * 因为结论可能完全反过来。
 *
 * 诊断四项：
 *   1. 本机有哪些地址可用（尤其是有没有公网 IPv6 —— 那是唯一不需要 NAT 的路）
 *   2. DNS 解析环境是否健康（本机代理软件常把 Node 的 DNS 打坏，
 *      表现是「STUN 全不可达」，其实只是解析挂了）
 *   3. STUN 是否真的能拿到公网映射（拿不到就没有 srflx 候选，等于只能局域网用）
 *   4. NAT 类型：锥形还是对称（决定打洞有没有意义）
 *
 * 仅用 Node 内置模块，不依赖仓库其他部分，可以直接拷到任何机器上跑。
 *
 * 用法：node scripts/check-network.mjs
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import os from 'node:os';

/**
 * 候选 STUN 服务器。判定 NAT 类型的关键是目标必须分散在不同网段／不同运营商——
 * 同一个 /24 里的两台服务器可能走完全相同的路径，得出的「映射端口一致」什么都证明不了。
 */
const STUN_HOSTS = [
  'stun.miwifi.com',
  'stun.qq.com',
  'stun.chat.bilibili.com',
  'stun.hitv.com',
  'stun.nextcloud.com',
  'stun.voipbuster.com',
  'stun.l.google.com',
  'stun1.l.google.com',
];

const STUN_PORT = 3478;
const STUN_TIMEOUT_MS = 3_000;

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPublicIpv6(address) {
  if (address.includes('%')) return false;
  const lower = address.toLowerCase();
  if (lower === '::1') return false;
  if (lower.startsWith('::ffff:')) return false;
  if (/^fe[89ab]/.test(lower)) return false; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // ULA
  if (lower.startsWith('ff')) return false; // multicast
  return true;
}

function subnetOf(ip) {
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}.x.x`;
}

/* ---------------- 1. 本机地址 ---------------- */

function reportInterfaces() {
  section('本机地址');

  const lan = [];
  const publicV4 = [];
  const publicV6 = [];

  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue;
      if (entry.family === 'IPv4') {
        (isPrivateIpv4(entry.address) ? lan : publicV4).push(`${entry.address}  (${name})`);
      } else if (entry.family === 'IPv6' && isPublicIpv6(entry.address)) {
        publicV6.push(`${entry.address}  (${name})`);
      }
    }
  }

  console.log('  局域网 IPv4    ', lan.length ? lan.join('、') : '无');
  console.log('  公网 IPv4      ', publicV4.length ? publicV4.join('、') : '无（家宽正常，公网 IPv4 要单独申请）');
  console.log('  公网 IPv6      ', publicV6.length ? publicV6.join('、') : '无');

  if (publicV6.length > 0) {
    console.log('\n  → 有公网 IPv6。这条路的对方只要也能访问 IPv6 就能直连，完全绕过 NAT。');
    console.log('    前提是路由器放行入站，验证方法见 docs/REMOTE-TESTING.md。');
  }

  return { hasPublicV6: publicV6.length > 0 };
}

/* ---------------- 2. DNS 环境 ---------------- */

function lookupAll(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, addresses) => {
      resolve(err ? { err } : { addresses });
    });
  });
}

async function reportDns() {
  section('DNS 解析环境');

  console.log('  Node 用的 DNS 服务器（c-ares）  ', dns.getServers().join('、') || '（空）');

  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object {$_.ServerAddresses} | ForEach-Object { "$($_.InterfaceAlias) -> $($_.ServerAddresses -join ",")" }',
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      console.log('  Windows 网卡 DNS                ', line.trim());
    }
  } catch {
    console.log('  Windows 网卡 DNS                 读取失败（不影响后续判定）');
  }

  let caresOk = 0;
  let caresFail = 0;
  for (const host of STUN_HOSTS) {
    try {
      await dns.promises.resolve4(host);
      caresOk += 1;
    } catch {
      caresFail += 1;
    }
  }

  console.log('');
  console.log(`  c-ares 解析（dns.resolve）      成功 ${caresOk} / 失败 ${caresFail}`);
  console.log('  → Node 的 WebRTC 无关，但信令服务端若用 dns.resolve 会受影响');

  if (caresFail > 0 && caresOk === 0) {
    console.log('');
    console.log('  ⚠ c-ares 完全不可用。常见原因是本机代理软件把 DNS 指向了 127.0.0.1');
    console.log('    而那个端口并没有 DNS 服务。系统解析器走的是网卡 DNS，通常不受影响——');
    console.log('    所以下面所有探测都用系统解析，不能因为 c-ares 挂了就断言「网络不通」。');
  }

  return { caresOk, caresFail };
}

/* ---------------- 3. STUN 探测 + 4. NAT 判定 ---------------- */

function buildBindingRequest() {
  const transactionId = crypto.randomBytes(12);
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(0x0001, 0);
  packet.writeUInt16BE(0x0000, 2);
  packet.writeUInt32BE(0x2112a442, 4);
  transactionId.copy(packet, 8);
  return { packet, transactionId };
}

function parseMapped(message) {
  let offset = 20;
  while (offset + 4 <= message.length) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const vs = offset + 4;
    if (vs + length > message.length) break;
    if (type === 0x0020 && message.readUInt8(vs + 1) === 0x01) {
      const port = message.readUInt16BE(vs + 2) ^ 0x2112;
      const raw = Buffer.from(message.subarray(vs + 4, vs + 8));
      const cookie = [0x21, 0x12, 0xa4, 0x42];
      for (let i = 0; i < 4; i += 1) raw[i] ^= cookie[i];
      return { address: `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`, port };
    }
    offset = vs + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

/** 从同一个本地 UDP 端口向所有目标发查询，收集各自的映射结果 */
function probeStun(servers) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const pending = new Map();
    const results = [];
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      resolve(results);
    };

    socket.on('message', (message, rinfo) => {
      if (message.length < 20) return;
      const key = message.subarray(8, 20).toString('hex');
      const entry = pending.get(key);
      if (!entry) return;
      pending.delete(key);
      const mapped = parseMapped(message);
      if (mapped) results.push({ host: entry.host, serverIp: rinfo.address, mapped });
      if (pending.size === 0) finish();
    });

    socket.on('error', () => finish());

    const deadline = setTimeout(finish, STUN_TIMEOUT_MS + 500);

    socket.bind(0, () => {
      console.log(`  本地 UDP 端口（全程固定）  ${socket.address().port}`);
      console.log(`  探测目标                  ${servers.length} 个\n`);

      for (const server of servers) {
        const { packet, transactionId } = buildBindingRequest();
        pending.set(transactionId.toString('hex'), { host: server.host });
        socket.send(packet, STUN_PORT, server.ip, (err) => {
          if (err) pending.delete(transactionId.toString('hex'));
        });
      }

      setTimeout(finish, STUN_TIMEOUT_MS);
    });
  });
}

async function reportStunAndNat() {
  section('STUN 探测');

  const servers = [];
  for (const host of STUN_HOSTS) {
    const resolved = await lookupAll(host);
    if (resolved.err !== undefined) {
      console.log(`  ${host.padEnd(24)} 解析失败，跳过`);
      continue;
    }
    const v4 = resolved.addresses.filter((a) => a.family === 4).map((a) => a.address);
    if (v4.length === 0) {
      console.log(`  ${host.padEnd(24)} 无 A 记录，跳过`);
      continue;
    }
    for (const ip of v4.slice(0, 2)) servers.push({ host, ip });
  }

  if (servers.length === 0) {
    console.log('\n  一个 STUN 都没解析出来，先检查网络。');
    return { results: [], servers };
  }

  console.log('');
  const results = await probeStun(servers);

  section('结果');

  for (const r of results) {
    console.log(
      `  ${r.serverIp.padEnd(16)} ${r.host.padEnd(24)} 映射端口 ${String(r.mapped.port).padEnd(6)} (${subnetOf(r.serverIp)})`,
    );
  }
  console.log(`\n  ${results.length}/${servers.length} 个目标有响应`);

  section('判定');

  if (results.length === 0) {
    console.log('  没有任何响应 —— UDP 出站被拦，或全部 STUN 不可达。');
    console.log('  没有 srflx 候选，异地只能靠 TURN 中继。');
    return { results, servers };
  }

  const ports = [...new Set(results.map((r) => r.mapped.port))];
  const addrs = [...new Set(results.map((r) => r.mapped.address))];
  const subnets = [...new Set(results.map((r) => subnetOf(r.serverIp)))];

  console.log(`  公网出口地址    ${addrs.join('、')}`);
  console.log(`  映射端口集合    ${ports.join('、')}`);
  console.log(`  覆盖网段        ${subnets.length} 个`);
  console.log(`  有效样本        ${results.length} 个`);

  if (results.length < 3 || subnets.length < 2) {
    console.log('\n  ⚠ 样本不足（需要 ≥3 个响应且覆盖 ≥2 个网段），判定不可信。');
    console.log('    可以关掉代理软件后重跑，代理的 TUN 模式会干扰探测。');
    return { results, servers, ports, subnets };
  }

  if (ports.length === 1) {
    console.log('\n  ✓ 锥形 NAT（Cone）—— 不同网段的目标看到同一个映射端口，映射与目标无关。');
    console.log('    这是打洞最理想的情况：只要信令能互通，双方大概率能直连。');
  } else {
    console.log('\n  ✗ 对称 NAT（Symmetric）—— 每个新目标都换一个映射端口。');
    console.log('    打洞基本无望，异地必须靠 TURN 中继兜底。');
  }

  console.log('\n  注：本机若开着代理软件的 TUN / 透明代理，这里测到的是代理的 NAT 行为，');
  console.log('      不是运营商真实行为。想拿到真实结论就关掉代理重跑。');

  return { results, servers, ports, subnets };
}

async function main() {
  const { hasPublicV6 } = reportInterfaces();
  await reportDns();
  const nat = await reportStunAndNat();

  section('结论');

  const conclusive = nat.ports && nat.ports.length >= 1 && nat.results.length >= 3 && nat.subnets.length >= 2;
  const cone = conclusive && nat.ports.length === 1;

  if (hasPublicV6) {
    console.log('  · 有公网 IPv6 —— 优先走这条：对方能访问 IPv6 就能直连，不需要 STUN/TURN。');
  }
  if (cone) {
    console.log('  · NAT 是锥形 —— 打洞路线可行，信令通公网后即可测试跨网直连。');
  } else if (conclusive) {
    console.log('  · NAT 是对称 —— 打洞不可行，跨网需要 TURN 中继（M8）。');
  } else {
    console.log('  · NAT 类型未能判定 —— 样本不足，建议关掉代理重跑本脚本。');
  }
  console.log('');
}

main().catch((err) => {
  console.error('诊断脚本出错：', err);
  process.exit(1);
});
