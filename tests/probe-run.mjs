import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const url = process.argv[2];
const budget = Number(process.argv[3] ?? 900) * 1000;
const port = Number(process.env.PROBE_PORT ?? 9377);
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env.TEMP ?? '/tmp'}/probe-run-${port}`,
    '--no-first-run',
    '--disable-gpu',
    '--no-sandbox',
    '--mute-audio',
    '--window-size=1200,900',
  ],
  { stdio: 'ignore' },
);

const target = await (async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((entry) => entry.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('chrome did not expose a page target');
})();

const ws = new WebSocket(target);
await new Promise((resolve) => ws.addEventListener('open', resolve));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description).join(' ');
    console.log(`[${message.params.type}] ${text}`);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    console.log(`[exception] ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, { resolve, reject });
    ws.send(JSON.stringify({ id: callId, method, params }));
  });

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });

let previous = '';
const started = Date.now();
let finished = false;
while (Date.now() - started < budget && !finished) {
  await sleep(500);
  const result = await send('Runtime.evaluate', {
    expression: `document.querySelector('#out')?.textContent ?? ''`,
    returnByValue: true,
  });
  const text = result.result?.value ?? '';
  if (text !== previous) {
    const added = text.slice(previous.length).trim();
    if (added) console.log(added);
    previous = text;
  }
  if (/DONE|FAILED|SURVIVED/.test(text)) finished = true;
}

console.log(finished ? '--- probe finished ---' : '--- probe timeout ---');
ws.close();
chrome.kill();
process.exit(finished ? 0 : 1);
