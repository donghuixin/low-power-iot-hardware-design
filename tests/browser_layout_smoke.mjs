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
  async function orbitFrame() {
    return evaluate(`(() => {
      const f = LP.motion.orbitFrame;
      if (!f || !f.members.length) return null;
      const canvas = document.querySelector('#motion-layer'), ctx = canvas.getContext('2d');
      const sx = canvas.width / canvas.clientWidth, sy = canvas.height / canvas.clientHeight;
      const members = f.members.map(m => {
        const item = LP.model.itemByRef(LP.App.p,m.ref);
        if ((item.orbitParent || item.parent?.[0]) !== f.core) throw Error('Unexpected orbit member '+m.ref+' for '+f.core);
        const px = Math.round(m.x*sx), py = Math.round(m.y*sy);
        const ink = ctx.getImageData(px-3, py-3, 7, 7).data.filter((a,i) => i%4===3 && a>40).length;
        return {ref:m.ref, x:m.x, y:m.y, ink};
      });
      return {core:f.core, center:f.center, members};
    })()`);
  }
  async function assertOrbit(view, expectedCore) {
    const first = await until(async () => {
      const f = await orbitFrame();
      return f?.core === expectedCore && f.members.some(m => m.ink>4) && f;
    }, view + ' has no visible orbit around ' + expectedCore);
    const second = await until(async () => {
      const next = await orbitFrame();
      if (next?.core !== expectedCore) return false;
      return next.members.some(b => {
        const a = first.members.find(m => m.ref === b.ref && m.ink>4);
        if (!a || b.ink<=4) return false;
        const ax = a.x-first.center.x, ay = a.y-first.center.y;
        const bx = b.x-next.center.x, by = b.y-next.center.y;
        return Math.abs(Math.atan2(ax*by-ay*bx, ax*bx+ay*by))>0.08;
      }) && next;
    }, view + ' has no angular displacement for a visible component');
    console.log(view, expectedCore, second.members.map(m=>m.ref).join(','));
    return second;
  }
  async function placement() {
    return evaluate(`(() => {
      const p = LP.model.exportLayout(LP.App.p, LP.App.ev);
      return [...p.parts, ...p.satellites].map(item=>[item.ref,item.placed,!!item.locked,!!item.pinned]);
    })()`);
  }
  async function checkPassives(view) {
    const result = await evaluate(`(() => {
      const THREE = LP.App.renderer, groups = THREE.partGroups;
      const items = LP.App.p.parts.filter(p => p.placed && ['resistor','capacitor'].includes(p.visualPackage?.kind));
      const faults = [];
      for (const item of items) {
        const spec = item.visualPackage, g = LP.model.passiveGeometry(item);
        if (g.kind !== spec.kind || g.pads.length !== 2 || g.terminals.length !== 2 ||
            g.body.w !== spec.body.w || g.body.h !== spec.body.h) faults.push(item.ref + ' geometry');
        if (groups) {
          const node = groups.get(item.ref);
          const names = node?.children.map(x=>x.name).sort().join(',');
          if (names !== 'body,pad:1,pad:2,terminal:1,terminal:2') faults.push(item.ref + ' 3D ' + names);
          for (const pad of spec.pads) {
            const mesh = node?.getObjectByName('pad:' + pad.n);
            if (!mesh || Math.abs(mesh.position.x-pad.x)>1e-5 || Math.abs(mesh.position.z+pad.y)>1e-5) faults.push(item.ref+' pad position');
          }
        } else {
          const ctx = document.createElement('canvas').getContext('2d'), rects=[];
          const rect = ctx.fillRect.bind(ctx);
          ctx.fillRect = function(x,y,w,h) {
            const {x:px,y:py} = ctx.getTransform().transformPoint(new DOMPoint(x+w/2,y+h/2));
            rects.push({x:px,y:py,w,h}); rect(x,y,w,h);
          };
          LP.render2d.drawItem(ctx,item,false,{});
          const matches = (a,b) => ['x','y','w','h'].every(k=>Math.abs(a[k]-b[k])<1e-5);
          if (rects.length!==4 || ![...spec.pads,...g.terminals].every(s=>rects.some(p=>matches(s,p)))) faults.push(item.ref+' 2D contacts');
        }
      }
      return {count:items.length,faults:faults.slice(0,8)};
    })()`);
    assert(result.count>0, view + ' passive fixture missing');
    assert.deepEqual(result.faults, []);
    console.log(view, result.count, 'two-terminal models');
  }
  await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: page });
  await until(() => evaluate('!!window.__LP_READY'), 'planner did not load');
  await evaluate('document.querySelectorAll("dialog[open]").forEach(d=>d.close())');
  assert.equal(await evaluate('LP.App.animOn'), false);
  await evaluate('document.querySelector("#btn-anim").click()');
  const defaultCore = await evaluate('LP.App.p.orbitFocus || null');
  if (defaultCore) {
    const previous = await placement();
    await checkPassives('2D project');
    await assertOrbit('2D project', defaultCore);
    await evaluate('LP.ui.setView("3d")');
    await until(() => evaluate('LP.App.view==="3d" && !!document.querySelector("#three-host canvas")'), '3D project unavailable');
    await assertOrbit('3D project', defaultCore);
    await checkPassives('3D project');
    await evaluate('document.querySelector("#btn-anim").click()');
    assert.equal(await orbitFrame(), null);
    assert.equal((await signature()).count, 0);
    assert.deepEqual(await placement(), previous);
    assert.deepEqual(errors, []);
    console.log('PASS: project focus, rendered component displacement, unchanged exported placement.');
  } else {
    await assertMoving('2D unplaced');
    assert.equal((await signature()).trace, '板框');
    await evaluate(`(() => {
      const data=JSON.parse(document.getElementById('example-data').textContent);
      const a=data.parts.find(x=>x.ref==='U1'), b=data.parts.find(x=>x.ref==='U2');
      a.display_name='AD9273'; a.placed={x:11,y:12}; b.name='IMU'; b.placed={x:24,y:12};
      for(const [i, shape, kind] of [[0,'res','resistor'],[1,'cap','capacitor']]) {
        data.parts.push({ref:i?'C901':'R901',role:'other',shape,w:2.3,h:0.9,footprint:i?'C0603':'R0603',
          pins:[],placed:{x:6+i*3,y:9},visualPackage:{kind,body:{x:0,y:0,w:1.6,h:0.8},
            pads:[{n:'1',x:-0.8,y:0,w:0.7,h:0.9},{n:'2',x:0.8,y:0,w:0.7,h:0.9}]}});
      }
      const loaded=LP.App.load(data); if(!loaded.ok)throw Error(loaded.errors);
      const renderer=LP.App.renderer, ctx=renderer.ctx, orig=ctx.fillText;
      window.labelProbe=[]; ctx.fillText=function(value,...args){window.labelProbe.push(value);return orig.call(this,value,...args)};
      renderer.fit(false); renderer.draw(); ctx.fillText=orig;
    })()`);
    assert(await evaluate('window.labelProbe.includes("AD9273")'));
    assert(!await evaluate('window.labelProbe.includes("U1")'));
    await checkPassives('2D example');
    await assertMoving('2D placed');
    await evaluate('document.getElementById("find-item").value="U1";document.getElementById("item-search").requestSubmit()');
    assert.equal(await evaluate('LP.App.sel.ref'), 'U1');
    const previous = await placement();
    await assertOrbit('2D example', 'U1');
    await evaluate('LP.ui.setView("3d")');
    await until(() => evaluate('LP.App.view==="3d" && !!document.querySelector("#three-host canvas")'), 'WebGL view unavailable');
    assert.equal(await evaluate('document.querySelector(".label3d[data-ref=U1]").textContent'), 'AD9273');
    assert(await evaluate('document.querySelector(".label3d[data-ref=U1]").getBoundingClientRect().width > 6'));
    await assertOrbit('3D example', 'U1');
    await checkPassives('3D example');
    await evaluate('LP.App.renderer.animate("ripple",{x:11,y:12,r:3});document.querySelector("#btn-anim").click()');
    assert(await evaluate(motion + '.hidden'));
    assert.equal((await signature()).count, 0);
    assert.equal(await orbitFrame(), null);
    assert.deepEqual(await placement(), previous);
    await sleep(180);
    assert.equal((await signature()).count, 0);
    await evaluate('LP.ui.setView("2d")');
    assert(await evaluate(motion + '.hidden'));
    assert.deepEqual(errors, []);
    console.log('PASS: visible faces, reference lookup, reduced-motion override, two-view playback and immediate stop.');
  }
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
