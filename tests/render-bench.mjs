import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const port = Number(args.get('--port') ?? 9333);
const appPort = Number(args.get('--appPort') ?? 4319);
const video = resolve(args.get('--video') ?? 'debug/bake.mp4');
const size = args.get('--size') ?? '480';
const detail = args.get('--detail') ?? '1';
const lineWidth = args.get('--line') ?? '3';
const sensitivity = args.get('--sensitivity') ?? '0.6';
const maxFrames = args.get('--maxFrames') ?? '';
const outDir = resolve(args.get('--out') ?? 'tests/.bench');
const label = args.get('--label') ?? 'run';
const profile = args.get('--profile') === '1';
const workerProfile = args.get('--workerProfile') === '1';
const keepVideo = args.get('--keepVideo') === '1';

const chromePath =
  process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profileDir = join(tmpdir(), `desmos-bench-${port}`);
const downloadDir = join(outDir, 'download');

async function rmrf(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}: ${last}`);
}

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

const appProcess = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], {
  cwd: resolve(args.get('--cwd') ?? '.'),
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const appLog = [];
appProcess.stdout.on('data', (d) => appLog.push(String(d)));
appProcess.stderr.on('data', (d) => appLog.push(String(d)));

await rmrf(profileDir);
await rmrf(downloadDir);
await mkdir(downloadDir, { recursive: true });

const chromeProcess = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1200,1600',
  ],
  { stdio: 'ignore' },
);

const pageLog = [];

function capturePageEvent(message) {
  if (message.sessionId || !message.method) return;
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? [])
      .map((arg) => arg.value ?? arg.description ?? arg.type)
      .join(' ');
    pageLog.push(`[console.${message.params.type}] ${text}`);
    console.log(`PAGE console.${message.params.type}: ${text}`);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    const text = details.exception?.description ?? details.text;
    pageLog.push(`[exception] ${text}`);
    console.log(`PAGE exception: ${text}`);
  }
}

let ws;
let messageId = 0;
const pendingCalls = new Map();
const events = [];
const workerSessions = [];
let profiling = false;

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    pendingCalls.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function connect() {
  await waitFor(`http://127.0.0.1:${port}/json/version`, 30000, 'chrome');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    events.push(message);
    capturePageEvent(message);
    if (message.method === 'Target.attachedToTarget') {
      const info = message.params.targetInfo;
      if (info.type === 'worker' || info.type === 'service_worker') {
        const session = { sessionId: message.params.sessionId, info, profileable: false };
        workerSessions.push(session);
        if (profiling) {
          session.profileable = true;
          void (async () => {
            try {
              await send('Profiler.enable', {}, session.sessionId);
              await send('Profiler.setSamplingInterval', { interval: 200 }, session.sessionId);
              await send('Profiler.start', {}, session.sessionId);
            } catch (error) {
              session.profileable = false;
              console.log(`late worker profiler failed for ${info.url}: ${error.message}`);
            }
          })();
        }
      }
    }
    if (message.id && pendingCalls.has(message.id)) {
      const call = pendingCalls.get(message.id);
      pendingCalls.delete(message.id);
      if (message.error) call.reject(new Error(`${message.error.message}`));
      else call.resolve(message.result);
    }
  });
}

const evaluate = async (expression, awaitPromise = false) => {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500));
  return result.result?.value;
};

async function main() {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await send('Performance.enable');
  await send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });

  await waitFor(`http://127.0.0.1:${appPort}/`, 60000, 'vite preview');
  const params = new URLSearchParams();
  if (args.get('--perf') === '1') params.set('perf', '1');
  for (const extra of String(args.get('--params') ?? '').split(',').filter(Boolean)) params.set(extra, '1');
  const query = params.toString();
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/${query ? `?${query}` : ''}` });
  await sleep(1500);

  const doc = await send('DOM.getDocument', { depth: 1 });
  const input = await send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '#file',
  });
  await send('DOM.setFileInputFiles', { files: [video], nodeId: input.nodeId });

  await evaluate(`(() => {
    document.querySelector('#renderSize').value = ${JSON.stringify(size)};
    document.querySelector('#detailScale').value = ${JSON.stringify(detail)};
    document.querySelector('#lineWidth').value = ${JSON.stringify(lineWidth)};
    ${maxFrames ? `document.querySelector('#frames').value = ${JSON.stringify(maxFrames)};` : ''}
    document.querySelector('#sensitivity').value = ${JSON.stringify(sensitivity)};
  })()`);

  const capturePath = args.get('--captureExpressions');
  if (capturePath) {
    await evaluate(`(() => {
      window.__captured = [];
      window.__patchLog = [];
      window.__docs = [];
      const originalAppend = document.head.appendChild.bind(document.head);
      document.head.appendChild = (node) => {
        window.__patchLog.push('append:' + (node?.tagName ?? '?') + ':' + (node?.src ?? ''));
        if (node && node.tagName === 'SCRIPT' && String(node.src).includes('calculator.js')) {
          node.addEventListener('load', () => {
            window.__patchLog.push('loaded:' + typeof window.Desmos);
            const proto = window.Desmos.GraphingCalculator.prototype;
            const originalSet = proto.setExpressions;
            proto.setExpressions = function (expressions) {
              window.__captured = expressions;
              if (window.__docs) {
                let existing = -1;
                try { existing = this.getExpressions().length; } catch {}
                window.__docs.push({
                  existing,
                  requested: expressions.length,
                  chars: expressions.reduce((sum, e) => sum + e.latex.length, 0),
                  at: Math.round(performance.now()),
                });
              }
              return originalSet.call(this, expressions);
            };
          });
        }
        return originalAppend(node);
      };
    })()`);
  }

  const started = Date.now();
  const metricsBefore = await send('Performance.getMetrics');

  profiling = true;
  if (profile) {
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 200 });
    await send('Profiler.start');
  }
  for (const worker of workerSessions) {
    try {
      await send('Profiler.enable', {}, worker.sessionId);
      await send('Profiler.setSamplingInterval', { interval: 200 }, worker.sessionId);
      await send('Profiler.start', {}, worker.sessionId);
      worker.profileable = true;
    } catch (error) {
      console.log(`worker profiler start failed: ${error.message}`);
    }
  }

  await evaluate(`(() => {
    window.__bench = { start: performance.now(), progress: [] };
    document.querySelector('#render').click();
    document.querySelector('#renderGo').click();
    const text = () => document.querySelector('#render').textContent;
    const timer = setInterval(() => {
      const value = text();
      window.__bench.last = value;
      if (/^Rendering/.test(value)) {
        const frame = Number(value.replace(/[^0-9]/g, ''));
        if (window.__bench.progress.at(-1)?.[0] !== frame)
          window.__bench.progress.push([frame, performance.now()]);
      }
      if (value === 'Render') clearInterval(timer);
    }, 50);
  })()`);

  const timeout = Number(args.get('--timeout') ?? 3600) * 1000;
  let done = false;
  let heartbeat = Date.now();
  while (Date.now() - started < timeout) {
    await sleep(500);
    const last = await evaluate(`window.__bench?.last ?? ''`);
    if (Date.now() - heartbeat > 30000) {
      heartbeat = Date.now();
      const noticeText = await evaluate(`document.querySelector('#notice').textContent`);
      console.log(
        `HEARTBEAT ${Math.round((Date.now() - started) / 1000)}s status=${last}${noticeText ? ` notice=${noticeText}` : ''}`,
      );
    }
    if (last === 'Render') {
      const notice = await evaluate(`document.querySelector('#notice').textContent`);
      const info = await evaluate(`document.querySelector('#renderInfo').textContent`);
      if (notice) console.log(`NOTICE: ${notice}`);
      console.log(`INFO: ${info}`);
      done = true;
      break;
    }
  }

  const totalMs = Date.now() - started;
  const metricsAfter = await send('Performance.getMetrics');

  if (capturePath) {
    const patchLog = await evaluate(`JSON.stringify(window.__patchLog ?? null)`);
    console.log(`patch log: ${patchLog}`);
    const docs = await evaluate(`JSON.stringify(window.__docs ?? null)`);
    if (docs) console.log(`docs: ${docs}`);
    const captured = await evaluate(`JSON.stringify(window.__captured ?? null)`);
    if (captured) {
      await writeFile(resolve(capturePath), captured);
      console.log(`captured ${JSON.parse(captured).length} expressions to ${capturePath}`);
    }
  }

  const profiles = {};
  if (profile) {
    try {
      const result = await send('Profiler.stop');
      profiles.main = result.profile;
      await writeFile(join(outDir, `${label}.cpuprofile`), JSON.stringify(result.profile));
    } catch (error) {
      console.log(`main profiler stop failed: ${error.message}`);
    }
  }
  for (const [index, worker] of workerSessions.entries()) {
    if (!worker.profileable) continue;
    try {
      const result = await send('Profiler.stop', {}, worker.sessionId);
      await writeFile(join(outDir, `${label}-worker${index}.cpuprofile`), JSON.stringify(result.profile));
    } catch (error) {
      console.log(`worker ${index} (${worker.info.url}) profiler stop failed: ${error.message}`);
    }
  }
  profiling = false;

  const toMap = (metrics) => Object.fromEntries(metrics.metrics.map((m) => [m.name, m.value]));
  const before = toMap(metricsBefore);
  const after = toMap(metricsAfter);
  const metricDelta = {};
  for (const key of Object.keys(after)) {
    if (typeof after[key] === 'number' && typeof before[key] === 'number')
      metricDelta[key] = Math.round((after[key] - before[key]) * 1000) / 1000;
  }

  const bench = await evaluate(`JSON.stringify(window.__bench)`);
  const parsed = JSON.parse(bench ?? '{}');
  const progress = (parsed.progress ?? []).map(([percent, t]) => ({ percent, t: Math.round(t) }));

  let perfSummary = null;
  if (args.get('--perf') === '1') {
    const raw = await evaluate(`JSON.stringify(window.__perf ?? null)`);
    const dump = raw ? JSON.parse(raw) : null;
    if (dump) {
      const stats = (values) => {
        const sorted = values.slice().sort((a, b) => a - b);
        const sum = sorted.reduce((acc, v) => acc + v, 0);
        const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
        return {
          count: sorted.length,
          sum: Math.round(sum),
          median: Math.round(pick(0.5) * 100) / 100,
          p90: Math.round(pick(0.9) * 100) / 100,
        };
      };
      const workerFields = ['decode', 'read', 'canny', 'trace', 'segments', 'contours'];
      const encodeFields = ['wait', 'show', 'changed', 'sync', 'draw', 'encode', 'total'];
      perfSummary = {
        worker: Object.fromEntries(workerFields.map((field) => [field, stats(dump.worker.map((f) => f[field]))])),
        encode: Object.fromEntries(encodeFields.map((field) => [field, stats(dump.encode.map((f) => f[field]))])),
      };
    }
  }

  let output = null;
  for (let attempt = 0; attempt < 30 && !output; attempt++) {
    const files = await readdir(downloadDir);
    output = files.find((f) => /\.(mp4|webm)$/.test(f) && !f.endsWith('.crdownload')) ?? null;
    if (!output) await sleep(250);
  }
  let outputSize = 0;
  if (output) outputSize = (await import('node:fs/promises')).stat(join(downloadDir, output)).then((s) => s.size);

  const report = {
    label,
    video,
    size,
    detail,
    lineWidth,
    sensitivity,
    totalMs,
    done,
    progress,
    output: output ?? null,
    outputBytes: output ? await outputSize : 0,
    perf: perfSummary,
    metrics: metricDelta,
    workerTargets: workerSessions.map((w) => w.info.url),
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (profile) {
    const t0 = parsed.start ?? 0;
    const t1 = await evaluate('performance.now()');
    console.log(`profile window ${Math.round(t0)}..${Math.round(t1)}`);
  }

  for (const event of events) {
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
      console.log('PAGE ERROR:', event.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  }

  if (!keepVideo && output) await rm(join(downloadDir, output), { force: true });
  killTree(appProcess);
  killTree(chromeProcess);
  await sleep(400);
  await rmrf(profileDir);
  process.exit(done ? 0 : 2);
}

try {
  await main();
} catch (error) {
  console.error(error);
  console.error(appLog.join('').slice(-2000));
  killTree(appProcess);
  killTree(chromeProcess);
  process.exit(1);
}
