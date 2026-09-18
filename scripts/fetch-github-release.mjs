/**
 * 在受限网络环境下下载 GitHub Release 产物。
 *
 * 为什么需要这个脚本：
 * 本机（以及国内大量开发机）直连 github.com 会超时、走系统代理又经常被
 * 中间的镜像/加速层卡住，`curl` 和 `Invoke-WebRequest` 都试过不行。
 * 实测可行的方式有两种，脚本会依次尝试：
 *
 *   1. 直连 —— 部分 Release 资源会跳转到 objects.githubusercontent.com
 *      等域名，这些域名在国内往往是通的，只有 github.com 本身被拦。
 *   2. 走本机代理的 HTTP CONNECT 隧道 —— 注意必须是「先 CONNECT 建隧道、
 *      再在隧道里跑 TLS」，直接对代理端口做 TLS 是错的（会被误判成代理不可用）。
 *
 * 用法：
 *   node scripts/fetch-github-release.mjs <url> <输出路径>
 *   node scripts/fetch-github-release.mjs <url> <输出路径> --proxy 127.0.0.1:7890
 *   node scripts/fetch-github-release.mjs <url> <输出路径> --no-proxy
 *
 * 代理默认取环境变量 HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy。
 * 下载完成后会打印体积；超过 --max-redirects（默认 8）次跳转则判为失败。
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';

const USAGE = `用法：node scripts/fetch-github-release.mjs <url> <输出路径> [--proxy host:port] [--no-proxy]`;

function parseArgs(argv) {
  const positional = [];
  let proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? null;
  let useProxy = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-proxy') {
      useProxy = false;
    } else if (arg === '--proxy') {
      proxy = argv[i + 1] ?? null;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { url: positional[0], out: positional[1], proxy, useProxy };
}

/** 直连取一次响应，onBody 收响应体 */
function requestDirect(url, onBody) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: 25000, headers: { 'User-Agent': 'node', Accept: '*/*' } },
      (res) => {
        const head = [`HTTP/1.1 ${res.statusCode}`];
        for (const [k, v] of Object.entries(res.headers)) head.push(`${k}: ${v}`);
        res.on('data', onBody);
        resolve({ status: res.statusCode, head: head.join('\r\n'), stream: res });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('直连超时'));
    });
    req.on('error', reject);
  });
}

/** 经 HTTP 代理建 CONNECT 隧道 */
function openTunnel(proxy, host, port = 443) {
  const [phost, pport] = proxy.includes(':') ? proxy.split(':') : [proxy, '80'];
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: phost,
      port: Number(pport),
      method: 'CONNECT',
      path: `${host}:${port}`,
      timeout: 20000,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`代理拒绝 CONNECT：HTTP ${res.statusCode}`));
      }
      const secured = tls.connect({ socket, servername: host });
      secured.on('secureConnect', () => resolve(secured));
      secured.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('代理连接超时'));
    });
    req.on('error', (e) => reject(new Error(`代理不可用：${e.code ?? e.message}`)));
    req.end();
  });
}

/** 经代理取一次响应 */
function requestViaProxy(proxy, url, onBody) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    openTunnel(proxy, u.host).then((socket) => {
      let buffered = Buffer.alloc(0);
      let headerDone = false;
      socket.on('data', (chunk) => {
        if (headerDone) return onBody(chunk);
        buffered = Buffer.concat([buffered, chunk]);
        const idx = buffered.indexOf('\r\n\r\n');
        if (idx === -1) return;
        headerDone = true;
        const head = buffered.subarray(0, idx).toString('latin1');
        const rest = buffered.subarray(idx + 4);
        resolve({
          status: Number(head.split('\r\n')[0].split(' ')[1]),
          head,
          stream: socket,
        });
        if (rest.length) onBody(rest);
      });
      socket.on('error', reject);
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: node\r\n` +
          `Accept: */*\r\nConnection: close\r\n\r\n`,
      );
    }, reject);
  });
}

function locationOf(head) {
  const m = head.match(/^location:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}

async function run(useProxy, proxy, url, url0, { silent = false } = {}) {
  let current = url;
  let total = 0;

  for (let hop = 0; hop < 8; hop += 1) {
    const sink = (chunk) => {
      total += chunk.length;
    };
    const res = useProxy ? await requestViaProxy(proxy, current, sink) : await requestDirect(current, sink);

    if (res.status >= 300 && res.status < 400) {
      const loc = locationOf(res.head);
      res.stream.destroy();
      if (!loc) throw new Error('重定向但响应里没有 Location');
      const next = new URL(loc, current).toString();
      if (!silent) console.log(`  ${res.status} → ${new URL(next).host}`);
      current = next;
      continue;
    }

    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

    // 拿到最终响应，把后续数据写进文件。上面 sink 收到的字节不计入文件，
    // 所以这里从头开始：重新发一次最终请求专门用于落盘。
    res.stream.destroy();
    break;
  }

  // 落盘
  const out = url0;
  const file = fs.createWriteStream(out);
  total = 0;
  let status = 0;
  await new Promise((resolve, reject) => {
    const sink = (chunk) => {
      total += chunk.length;
      file.write(chunk);
    };
    const p = useProxy ? requestViaProxy(proxy, current, sink) : requestDirect(current, sink);
    p.then((res) => {
      status = res.status;
      res.stream.on('end', resolve);
      res.stream.on('close', resolve);
      res.stream.on('error', reject);
      if (typeof res.stream.resume === 'function') res.stream.resume?.();
    }, reject);
  });
  await new Promise((r) => file.end(r));

  if (status !== 200 || total < 1024) {
    fs.rmSync(out, { force: true });
    throw new Error(`最终响应异常（HTTP ${status}，${total} 字节）`);
  }
  return total;
}

async function main() {
  const { url, out, proxy, useProxy } = parseArgs(process.argv.slice(2));
  if (!url || !out) {
    console.error(USAGE);
    process.exit(2);
  }

  const abs = path.resolve(out);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  console.log(`目标   ${url}`);
  console.log(`输出   ${abs}\n`);

  if (!url.startsWith('https://')) {
    console.log('⚠ 只处理 https，其余协议请另想办法');
  }

  const attempts = [];
  if (proxy && useProxy) attempts.push({ label: `直连`, useProxy: false });
  attempts.push(
    proxy && useProxy
      ? { label: `代理 ${proxy}`, useProxy: true, proxy }
      : { label: '直连（未配置代理）', useProxy: false },
  );

  for (const attempt of attempts) {
    process.stdout.write(`\n[${attempt.label}]\n`);
    try {
      const bytes = await run(attempt.useProxy, attempt.proxy, url, abs);
      fs.chmodSync(abs, 0o755);
      console.log(`\n✓ ${(bytes / 1024 / 1024).toFixed(1)}MB → ${abs}`);
      return;
    } catch (err) {
      console.log(`  ✗ ${err.message}`);
    }
  }

  console.error('\n✗ 全部方式失败。若目标主机在国内不可达，换一个可达的镜像再试。');
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
