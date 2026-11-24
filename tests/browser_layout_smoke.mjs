// Node 22+ and Chromium. Run with CHROME_BIN=/path/to/chrome node tests/browser_layout_smoke.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const binary = process.env.CHROME_BIN || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'chromium');
const page = pathToFileURL(path.resolve(process.argv[2] || fileURLToPath(new URL('../assets/layout-planner.html', import.meta.url)))).href;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-smoke-'));
const child = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-breakpad', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1440,920', 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
  let reason;
  for (let i = 0; i < 200; i++) {
    try { const v = await fn(); if (v) return v; } catch (err) { reason = err; }
    await sleep(100);
  }
  throw new Error(message + (reason ? ' ' + reason : ''));
}
let socket;
try {
  const port = await until(async () => Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'DevTools port unavailable');
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail; });
  let seq = 0;
  const pending = new Map(), errors = [];
  socket.onmessage = event => {
    const packet = JSON.parse(event.data);
    if (packet.method === 'Runtime.exceptionThrown') errors.push(packet.params.exceptionDetails.text);
    if (!packet.id || !pending.has(packet.id)) return;
    const { ok, fail } = pending.get(packet.id);
    pending.delete(packet.id);
    if (packet.error) fail(new Error(packet.error.message)); else ok(packet.result);
  };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    pending.set(++seq, { ok, fail }); socket.send(JSON.stringify({ id: seq, method, params }));
  });
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  const motion = 'document.getElementById("motion-layer")';
  async function signature() {
    return evaluate('(() => {const c=' + motion + ', d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let count=0, hash=0;for(let i=3;i<d.length;i+=4)if(d[i]){count++;hash=(Math.imul(hash,31)+i+d[i-1])>>>0;}return {count,hash,trace:c.dataset.trace};})()');
  }
  async function assertMoving(view) {
    const first = await until(async () => { const f = await signature(); return f.count > 40 && f; }, view + ' empty');
    const second = await until(async () => {
      const f = await signature();
      return f.count > 40 && f.hash !== first.hash && f;
    }, view + ' remained static; renderer errors: ' + errors.join(', '));
    console.log(view, first, second);
  }
  await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: page });
  await until(() => evaluate('!!window.__LP_READY'), 'planner did not load');
  await evaluate('document.querySelectorAll("dialog[open]").forEach(d=>d.close())');
  assert.equal(await evaluate('LP.App.animOn'), false);
  await evaluate('document.querySelector("#btn-anim").click()');
  await assertMoving('2D unplaced');
  assert.equal((await signature()).trace, '板框');
  await evaluate(`(() => {
    const data=JSON.parse(document.getElementById('example-data').textContent);
    const a=data.parts.find(x=>x.ref==='U1'), b=data.parts.find(x=>x.ref==='U2');
    a.display_name='AD9273'; a.placed={x:11,y:12}; b.name='IMU'; b.placed={x:24,y:12};
    const loaded=LP.App.load(data); if(!loaded.ok)throw Error(loaded.errors);
    const renderer=LP.App.renderer, ctx=renderer.ctx, orig=ctx.fillText;
    window.labelProbe=[]; ctx.fillText=function(value,...args){window.labelProbe.push(value);return orig.call(this,value,...args)};
    renderer.fit(false); renderer.draw(); ctx.fillText=orig;
  })()`);
  assert(await evaluate('window.labelProbe.includes("AD9273")'));
  assert(!await evaluate('window.labelProbe.includes("U1")'));
  await assertMoving('2D placed');
  assert.notEqual((await signature()).trace, '板框');
  await evaluate('document.getElementById("find-item").value="U1";document.getElementById("item-search").requestSubmit()');
  assert.equal(await evaluate('LP.App.sel.ref'), 'U1');
  await evaluate('LP.ui.setView("3d")');
  await until(() => evaluate('LP.App.view==="3d" && !!document.querySelector("#three-host canvas")'), 'WebGL view unavailable');
  assert.equal(await evaluate('document.querySelector(".label3d[data-ref=U1]").textContent'), 'AD9273');
  assert(await evaluate('document.querySelector(".label3d[data-ref=U1]").getBoundingClientRect().width > 6'));
  await assertMoving('3D placed');
  await evaluate('LP.App.renderer.animate("ripple",{x:11,y:12,r:3});document.querySelector("#btn-anim").click()');
  assert(await evaluate(motion + '.hidden'));
  assert.equal((await signature()).count, 0);
  await sleep(180);
  assert.equal((await signature()).count, 0);
  await evaluate('LP.ui.setView("2d")');
  assert(await evaluate(motion + '.hidden'));
  assert.deepEqual(errors, []);
  console.log('PASS: visible faces, reference lookup, reduced-motion override, two-view playback and immediate stop.');
} finally {
  socket?.close();
  child.kill();
  await sleep(350);
  const parent = await fs.realpath(os.tmpdir());
  const actual = await fs.realpath(profile);
  if (path.dirname(actual) === parent && path.basename(actual).startsWith('layout-smoke-')) {
    await fs.rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
  }
}
