// Minimal Chrome DevTools driver for the browser checks: open a URL, run steps, print results.
// usage: node scripts/cdp.mjs <url> <steps-json>   Steps: {js}, {click: selector}, {type}, {key}, {wait}, {size: [w,h]}, {shot: file.png}.
import { spawn } from 'node:child_process';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [url, port] = [process.argv[2], 9333];
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, '--user-data-dir=/tmp/cdp-profile', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const waiting = new Map();
const send = (method, params = {}) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
try {
  let target;
  for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', JSON.stringify(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 400)); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') console.log('CONSOLE', JSON.stringify(d.params.args.map((a) => a.value ?? a.description)).slice(0, 400)); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } });
  await send('Runtime.enable');
  await send('Page.navigate', { url });
  await sleep(9000);
  const steps = JSON.parse(process.argv[3]);
  for (const s of steps) {
    if (s.wait) { await sleep(s.wait); continue; }
    if (s.shot) { const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(s.shot, Buffer.from(r.result.data, 'base64')); continue; }
    if (s.size) { await send('Emulation.setDeviceMetricsOverride', { width: s.size[0], height: s.size[1], deviceScaleFactor: 1, mobile: false }); continue; }
    if (s.click) { const p = await js(`(()=>{const r=document.querySelector(${JSON.stringify(s.click)}).getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`); for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p[0], y: p[1], button: 'left', clickCount: 1 }); continue; }
    if (s.type) { await send('Input.insertText', { text: s.type }); continue; }
    if (s.key) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: s.key, code: s.key, windowsVirtualKeyCode: 13, text: s.key === 'Enter' ? '\r' : undefined }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: s.key, code: s.key, windowsVirtualKeyCode: 13 }); continue; }
    console.log(JSON.stringify(await js(s.js)));
  }
} finally { chrome.kill(); }
