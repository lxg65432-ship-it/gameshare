// STUN 候选探测用的 Electron 主进程。
//
// 为什么必须用 Electron 而不是 Node：
// Node 里 STUN 探测是通过 dgram 手写 UDP 包，走的是 Node 自己的网络栈；
// 而实际跑视频的是 Chromium 的 ICE 实现，它有自己的 DNS 解析器和套接字管理。
// 实测出现过「Node 层 STUN 正常，Chromium 里却报 code=701」的分裂，
// 所以候选能力必须用真正跑视频的那个运行时来验。
//
// 逐个体检候选 STUN 服务器，用来回答「哪些该留在默认列表里」。
// 关键判据是**有没有 srflx 候选**，不是有没有报错——同一个服务器完全可能
// 一边报 701（部分解析路径失败）一边成功拿到 srflx。
//
// 结果以 __PROBE_RESULT__ 前缀输出一行 JSON，由外层脚本解析。

const { BrowserWindow, app } = require('electron');

const RESULT_MARKER = '__PROBE_RESULT__';

/** 候选体检对象。默认列表就取自这里的实测结果。 */
const CANDIDATES = (process.env.GAMESHARE_STUN_CANDIDATES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const FALLBACK_CANDIDATES = [
  'stun.miwifi.com:3478',
  'stun.chat.bilibili.com:3478',
  'stun.hitv.com:3478',
  'stun.qq.com:3478',
  'stun.l.google.com:19302',
];

const COLLECT_MS = Number(process.env.GAMESHARE_STUN_COLLECT_MS || '5000');

/** 在渲染进程里执行：对给定 ICE 服务器配置收一遍候选，统计类型与错误 */
function buildProbeSource(candidates, collectMs) {
  return `
(async () => {
  async function collect(iceServers) {
    const pc = new RTCPeerConnection({ iceServers });
    const candidates = [];
    const errors = [];

    pc.onicecandidate = (event) => {
      if (event.candidate && event.candidate.candidate) {
        candidates.push(event.candidate.candidate);
      }
    };
    pc.onicecandidateerror = (event) => {
      errors.push({
        url: event.url || '',
        code: event.errorCode,
        text: event.errorText || '',
      });
    };

    pc.addTransceiver('video', { direction: 'recvonly' });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      pc.close();
      return { ok: false, reason: 'createOffer/setLocalDescription 失败：' + (err && err.message) };
    }

    await new Promise((resolve) => setTimeout(resolve, ${collectMs}));

    const counts = {};
    const srflx = [];
    for (const line of candidates) {
      const typeMatch = line.match(/ typ (\\w+)/);
      const type = typeMatch ? typeMatch[1] : 'unknown';
      counts[type] = (counts[type] || 0) + 1;
      if (type === 'srflx') srflx.push(line);
    }

    pc.close();
    return { ok: true, counts, srflx, errors };
  }

  const candidates = ${JSON.stringify(candidates)};
  const results = [];
  for (const entry of candidates) {
    const outcome = await collect(entry.urls ? entry.urls : [{ urls: 'stun:' + entry }]);
    results.push({ label: entry.label || entry, ...outcome });
  }
  return results;
})()
`;
}

app.whenReady().then(async () => {
  const list = CANDIDATES.length > 0 ? CANDIDATES : FALLBACK_CANDIDATES;

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  try {
    await win.loadURL('about:blank');
    const source = buildProbeSource(list, COLLECT_MS);
    const results = await win.webContents.executeJavaScript(source, true);
    process.stdout.write(`${RESULT_MARKER}${JSON.stringify(results)}\n`);
    setTimeout(() => app.exit(0), 200);
  } catch (err) {
    process.stderr.write(`探测过程出错：${err && err.stack ? err.stack : err}\n`);
    setTimeout(() => app.exit(1), 200);
  }
});

app.on('window-all-closed', () => app.exit(1));

