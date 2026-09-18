/**
 * 探针：`--use-file-for-fake-audio-capture` 喂进去的麦克风轨，频谱里到底有什么。
 *
 * 结构轮里「0 号的 voice 里没有应用声音」这条一直红，读数是
 *   voice 上 1200Hz = -85.1、440Hz = -85.8、本底 = -124
 * —— 那条轨里确实有两个音。要么是喂进去的 WAV 之外还有别的东西，
 * 要么是远端链路串音。把麦克风单独拎出来量一次就能分开。
 *
 * 用法：
 *   node scripts/_probe-fake-mic.mjs            # 700 与 1200 各喂一次
 *   node scripts/_probe-fake-mic.mjs --hz 700
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const TEST_DIR = path.join(DESKTOP, 'test');
const CACHE = path.join(ROOT, '.cache', 'probe-fake-mic');
const RESULT_MARKER = '__HARNESS_RESULT__';

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FREQS = process.argv.includes('--hz')
  ? [Number(argValue('hz', '1200'))]
  : [700, 1200];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 `check-media-tracks.mjs` 同一份写 WAV（整数周期，循环处不咔哒） */
function writeSineWav(file, hz, seconds = 2, rate = 48000, amp = 0.35) {
  const cycles = Math.max(1, Math.round(hz * seconds));
  const total = Math.round((cycles * rate) / hz);
  const data = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) {
    const v = Math.sin((2 * Math.PI * cycles * i) / total) * amp;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return { file, total, cycles };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function createStaticServer(root) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const filePath = path.join(root, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(root) || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/** 本机预设了 ELECTRON_RUN_AS_NODE，不删掉子进程会退化成纯 Node、开不出窗口 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function probeOnce(electronPath, staticPort, wavFile, expectHz) {
  const child = spawn(electronPath, [path.join(TEST_DIR, 'electron', 'main.js')], {
    cwd: DESKTOP,
    env: {
      ...cleanEnv(),
      GAMESHARE_HARNESS_TOTAL: '1',
      GAMESHARE_HARNESS_URL: `http://127.0.0.1:${staticPort}/_probe-fake-mic.html`,
      GAMESHARE_SIGNALING_URL: 'http://127.0.0.1:1',
      GAMESHARE_HARNESS_VISIBLE: process.argv.includes('--visible') ? '1' : '0',
      GAMESHARE_HARNESS_TIMEOUT_MS: '60000',
      GAMESHARE_HARNESS_EXTRA_QUERY: `&expect=${expectHz}`,
      GAMESHARE_HARNESS_FAKE_MIC: wavFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    stdout += text;
    for (const line of text.split('\n')) {
      if (!line.trim() || line.includes(RESULT_MARKER)) continue;
      if (line.includes('Security Warning')) continue;
      console.log(`    ${line.replace(/^\[harness\]\s?/, '')}`);
    }
  });
  const stderrText = [];
  child.stderr.on('data', (c) => stderrText.push(String(c)));

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1));
    child.on('error', () => resolve(-1));
  });

  const markerLine = stdout.split('\n').find((l) => l.includes(RESULT_MARKER));
  if (!markerLine) {
    console.error(`    未拿到结果（exit=${exitCode}）`);
    const err = stderrText.join('').split('\n').filter((l) => l.trim() && !/deprecated/.test(l));
    if (err.length) console.error(err.slice(0, 6).map((l) => `      ${l}`).join('\n'));
    return null;
  }
  return JSON.parse(markerLine.slice(markerLine.indexOf(RESULT_MARKER) + RESULT_MARKER.length));
}

async function main() {
  const electronPath = require('electron');
  const staticPort = await findFreePort();
  const server = createStaticServer(here);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(staticPort, '127.0.0.1', resolve);
  });

  console.log('');
  console.log('假麦克风探针 —— 喂进去的 WAV 之外，这条轨里还有什么');

  try {
    for (const hz of FREQS) {
      const wav = writeSineWav(path.join(CACHE, `mic-${hz}.wav`), hz);
      console.log('');
      console.log(`━━━ WAV = ${hz}Hz（${wav.total} 帧 / ${wav.cycles} 周期）━━━`);
      const result = await probeOnce(electronPath, staticPort, wav.file, hz);
      const peer = result?.peers?.[0];
      if (!peer) {
        console.log('    ✗ 没有报告');
        continue;
      }
      if (!peer.ok) {
        console.log(`    ✗ 探针失败：${peer.failure}`);
        continue;
      }
      const onExpect = (peer.peaks ?? []).find((p) => Math.abs(p.hz - hz) < 30);
      const on440 = (peer.peaks ?? []).find((p) => Math.abs(p.hz - 440) < 30);
      console.log('');
      console.log(`    设备            ${peer.device ?? '未知'}`);
      console.log(`    本底 / 最强     ${peer.floor?.toFixed(1)} / ${peer.max?.toFixed(1)} dB`);
      console.log(
        `    WAV 的 ${hz}Hz    ${onExpect ? `${onExpect.db.toFixed(1)} dB` : '**不在谱峰里**'}`,
      );
      console.log(
        `    内置假音 440Hz  ${on440 ? `${on440.db.toFixed(1)} dB` : '不在谱峰里'}`,
      );
      console.log(`    谱峰            ${(peer.peaks ?? []).map((p) => `${p.hz}@${p.db.toFixed(0)}`).join(' ')}`);
      await sleep(500);
    }
  } finally {
    server.close();
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
