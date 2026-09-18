/**
 * 验证 cloudflared 隧道地址此刻能不能真的从公网访问到本机信令服务。
 *
 * 为什么需要这个：
 * cloudflared 日志里的 `Registered tunnel connection` 只说明它连上了 Cloudflare
 * 边缘节点，**不代表外网真能访问到本机 8080**。日志还会写
 * 「it may take some time to be reachable」—— 地址刚生成时有一段沉默期。
 *
 * 不先验这一步的话，对面连不上时分不清是
 *   (a) 隧道没通，
 *   (b) 隧道通了但 P2P 打洞失败。
 * 这两个问题的解法完全不同，先用这个脚本把它拆开。
 *
 * 走的是完整环路：本机 → Cloudflare 边缘 → 回到本机 8080。
 *
 * 用法：
 *   npm run check:tunnel -- developed-cashiers-convicted-stem.trycloudflare.com
 */
import https from 'node:https';

const HOST = process.argv[2];
if (!HOST) {
  console.error('用法: npm run check:tunnel -- <trycloudflare 域名>');
  process.exit(1);
}

function probe(path) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: HOST,
        port: 443,
        path,
        method: 'GET',
        timeout: 15_000,
        headers: { 'User-Agent': 'gameshare-verify' },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 160) }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'timeout' });
    });
    req.on('error', (e) => resolve({ status: 'ERR', body: e.code || e.message }));
    req.end();
  });
}

console.log(`\n隧道   https://${HOST}\n`);

const health = await probe('/health');
console.log(`  /health     ${health.status}  ${health.body ?? ''}`);

const handshake = await probe('/socket.io/?EIO=4&transport=polling');
console.log(`  socket.io   ${handshake.status}  ${handshake.body ?? ''}`);

const httpOk = health.status === 200 && String(health.body).includes('game-share');
const socketOk = handshake.status === 200 && String(handshake.body).includes('websocket');

console.log('');
if (httpOk && socketOk) {
  console.log('  ✓ 隧道端到端可达，另一台电脑可以填这个地址');
} else if (httpOk) {
  console.log('  ⚠ HTTP 通了但 socket.io 握手异常 —— 客户端连信令会失败，先别让对方测');
} else {
  console.log('  ✗ 隧道当前不可达。刚创建时可能还在传播，等 10 秒重试；');
  console.log('    仍然不通就确认隧道窗口还开着（窗口一关隧道就断了）。');
}
console.log('');
