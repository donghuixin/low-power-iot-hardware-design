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
    if (packet.method === 'Runtime.exceptionThrown') {
      const problem=packet.params.exceptionDetails;
      errors.push(problem.exception?.description || problem.text);
    }
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
  async function placement() {
    return evaluate(`(() => {
      const p = LP.model.exportLayout(LP.App.p, LP.App.ev);
      return [...p.parts, ...p.satellites].map(item=>[item.ref,item.placed,!!item.locked,!!item.pinned]);
    })()`);
  }
  async function checkPassives(view) {
    const result = await evaluate(`(() => {
      const THREE = LP.App.renderer, groups = THREE.partGroups;
      const items = [...LP.App.p.parts,...LP.App.p.satellites].filter(p => p.placed && ['resistor','capacitor'].includes(p.visualPackage?.kind));
      const faults = [];
      for (const item of items) {
        const spec = item.visualPackage, g = LP.model.passiveGeometry(item);
        if (g.kind !== spec.kind || g.pads.length !== 2 || g.terminals.length !== 2 ||
            g.body.w !== spec.body.w || g.body.h !== spec.body.h) faults.push(item.ref + ' geometry');
        if (groups) {
          const node = groups.get(item.ref) || THREE.satMeshes.get(item.ref);
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
          LP.render2d.drawItem(ctx,item,!!item.kind,{});
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
  const media = value => send('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value }] });
  await media('no-preference');
  await send('Page.navigate', {url:page});
  await until(() => evaluate('!!window.__LP_READY'), 'planner did not load');
  await evaluate('document.querySelectorAll("dialog[open]").forEach(d=>d.close())');
  const empty = await placement();
  assert(empty.every(row=>row[1]===null),'fresh board contains placed components');
  assert(await evaluate('document.querySelector("#tray-return").disabled'));
  if(await evaluate('LP.App.hasInputPlacement')) {
    await evaluate('document.querySelector("#tray-preset").click()');
    const loaded = await placement();
    assert(loaded.some(row=>row[1]));
    await evaluate('LP.App.toggleLock(LP.App.p.parts.find(p=>p.placed&&!p.locked&&LP.model.isTrayPart(p)).ref)');
    const locked = await placement();
    await evaluate('document.querySelector("#tray-return").click()');
    assert.deepEqual(await placement(),empty,'all parts and pads must be returned');
    await evaluate('document.querySelector("#btn-undo").click()');
    assert.deepEqual(await placement(),locked,'undo bulk return must restore previous locks and placements');
    await evaluate('document.querySelector("#tray-return").click();document.querySelector(".tray-fixed-group")?.click()');
    assert(await evaluate('LP.App.p.parts.filter(x=>x.placementRole==="board_feature").every(x=>x.placed)'),'fixed pad group was stranded');
    await evaluate('document.querySelector("#tray-return").click();LP.App.autosave();window.beforeTrayReload=true');
    await send('Page.reload');
    await until(()=>evaluate('!window.beforeTrayReload && !!window.__LP_READY'),'empty layout reload');
    assert.deepEqual(await placement(),empty,'saved empty board reopened as preset');
    await evaluate('document.querySelector("#tray-preset").click()');
    assert.deepEqual(await placement(),loaded);
  }
  const core = await evaluate(`(() => {
    const app=LP.App, m=LP.model;
    if (!app.p.parts.some(p=>p.placed)) {
      const data=JSON.parse(document.querySelector('#example-data').textContent);
      const a=data.parts.find(x=>x.ref==='U1');
      a.display_name='AD9273'; a.placed={x:11,y:12,rot:0,side:'top'};
      const b=data.parts.find(x=>x.ref==='U2'); b.placed={x:24,y:12,rot:0,side:'top'};
      for(const s of data.satellites.filter(s=>['C1','C2'].includes(s.ref))) {
        s.visualPackage={kind:'capacitor',body:{x:0,y:0,w:1,h:0.5},pads:[
          {n:'1',x:-0.45,y:0,w:0.49,h:0.56},{n:'2',x:0.45,y:0,w:0.49,h:0.56}]};
      }
      const loaded=app.load(data,{skipRestore:true});
      if(!loaded.ok) throw Error(loaded.errors);
    }
    const physicalChildren=p=>m.placementChildren(app.p,p.ref).length+app.p.satellites.filter(s=>s.parent[0]===p.ref).length;
    const candidates=app.p.parts.filter(p=>p.placed&&!p.locked&&p.placed.side===(app.flipped?'bottom':'top')&&physicalChildren(p));
    const core=candidates.find(x=>x.ref===app.p.orbitFocus) || candidates.sort((a,b)=>physicalChildren(b)-physicalChildren(a))[0];
    if(!core)throw Error('fixture has no movable core with peripherals');
    const tray=[...document.querySelectorAll('#tray-list .tray-card')].map(e=>e.dataset.ref);
    const wrong=tray.filter(r=>{
      const x=m.itemByRef(app.p,r);
      return x.kind || ['resistor','capacitor'].includes(x.visualPackage?.kind) || (x.placementRole && x.placementRole!=='main');
    });
    if(wrong.length || !tray.includes(core.ref)) throw Error('tray: '+wrong.join(',')+' core '+core.ref);
    return core.ref;
  })()`);
  const initial = await placement();
  const modelState = expression => evaluate('(() => {const a=LP.App,m=LP.model,g=LP.geometry,c=m.partByRef(a.p,'+JSON.stringify(core)+'),r=a.renderer,children=[...m.placementChildren(a.p,c.ref),...a.p.satellites.filter(s=>s.parent[0]===c.ref)];'+expression+'})()');
  await modelState(`
    const s=children.find(x=>x.placed && (x.visualPackage || x.kind));
    const field=document.querySelector('#find-item');
    field.value=s.ref;document.querySelector('#item-search').requestSubmit();field.blur();
    if(a.sel?.ref!==s.ref)throw Error('peripheral not searchable '+s.ref);
  `);
  assert.equal(await evaluate('LP.App.animOn'), false);
  await evaluate('document.querySelector("#btn-anim").click()');
  async function mouse(type, point, modifiers=0) {
    const p={type,x:point.x,y:point.y,modifiers};
    if(type!=='mouseMoved') Object.assign(p,{button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
    await send('Input.dispatchMouseEvent',p);
  }
  async function click(point,modifiers=0) {
    await mouse('mouseMoved',point,modifiers); await mouse('mousePressed',point,modifiers); await mouse('mouseReleased',point,modifiers);
  }
  async function pressEscape() {
    for(const type of ['keyDown','keyUp']) await send('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  }
  async function gesture(view) {
    await evaluate('LP.ui.setView('+JSON.stringify(view)+')');
    await until(()=>evaluate('LP.App.view==='+JSON.stringify(view)+' && !!LP.App.renderer'),view+' not ready');
    await modelState('r.fit(false);a.redraw();return true');
    await checkPassives(view);
    if(view==='3d') {
      const label=await modelState("return document.querySelector('.label3d[data-ref='+c.ref+']')?.textContent");
      assert.equal(label,await modelState('return m.faceName(c)'));
    }
    assert(!(await modelState('return !!(r.orbitPos && Object.keys(r.orbitPos).length)')), 'idle orbit');
    const start=await modelState(`
      const stage=document.querySelector('#stage').getBoundingClientRect();
      if(a.view==='2d') {
        const card=document.querySelector('#tray-list [data-ref="'+c.ref+'"]');card.scrollIntoView({inline:'center',block:'nearest',behavior:'instant'});
        const box=card.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};
      }
      for(const h of [c.z||1,0]) {
        const q=r.boardToScreen(c.placed.x,c.placed.y,h);
        for(const dx of [0,2,-2,5,-5])for(const dy of [0,2,-2,5,-5]) {
          const x=q.x+dx,y=q.y+dy;
          if(r.pick(x,y)?.ref===c.ref && !LP.ui.isOverPanel(stage.x+x,stage.y+y))return {x:stage.x+x,y:stage.y+y};
        }
      }
      throw Error('could not hit '+c.ref);
    `);
    await click(start);
    const dest=await modelState(`
      if(a.drag?.ref!==c.ref)throw Error('component did not attach to pointer');
      const stage=document.querySelector('#stage').getBoundingClientRect(), pl=c.placed;
      for(const dist of [5,7,4,9,3,12,2,15,1,20,25,30,35,0.5])for(let j=0;j<16;j++) {
        const t=2*Math.PI*j/16, x=Math.round((pl.x+dist*Math.cos(t))*2)/2, y=Math.round((pl.y+dist*Math.sin(t))*2)/2;
        if(!LP.rules.quickLegal(a.p,c,{...pl,x,y}).ok)continue;
        const q=r.boardToScreen(x+a.drag.dx,y+a.drag.dy), px=stage.x+q.x,py=stage.y+q.y;
        if(px<=stage.x||py<=stage.y||px>=stage.right||py>=stage.bottom||LP.ui.isOverPanel(px,py))continue;
        return {x:px,y:py,boardX:x,boardY:y};
      }
      throw Error('no legal drop visible near '+c.ref);
    `);
    await mouse('mouseMoved',dest,1);
    const first = await until(()=>modelState('const q=r.orbitPos; return q&&Object.keys(q).length&&JSON.parse(JSON.stringify(q))'),view+' empty pickup orbit');
    const second = await until(async()=>{
      const next=await modelState('return r.orbitPos');
      return next && Object.keys(first).some(ref=>next[ref]&&Math.hypot(first[ref].x-next[ref].x,first[ref].y-next[ref].y)>0.25) && next;
    },view+' static orbit');
    const owned=await modelState('return children.filter(s=>!s.locked&&!s.pinned).map(s=>s.ref)');
    assert(Object.keys(second).length && Object.keys(second).every(ref=>owned.includes(ref)));
    assert.deepEqual(await placement(),initial,'pickup mutated physical layout');
    if(view==='2d') {
      await pressEscape();
      assert.deepEqual(await placement(),initial,'cancelling moved physical components');
      assert.equal(await evaluate('LP.App.drag'),null);
      await click(start); await mouse('mouseMoved',dest,1);
      await until(()=>modelState('return !!(r.orbitPos && Object.keys(r.orbitPos).length)'), 'repick did not orbit');
    }
    await modelState(`
      window.flyEvents=[]; const animate=r.animate;
      r.animate=function(type,data){if(type==='pop'&&data.orbit)window.flyEvents.push({ref:data.ref,from:data.from});
        return animate.call(this,type,data)};
      window.restoreAnimate=()=>{r.animate=animate};
    `);
    await click(dest,1);
    const changed=await until(()=>modelState(`
      if(a.drag||Math.hypot(c.placed.x-${dest.boardX},c.placed.y-${dest.boardY})>0.35)return false;
      return window.flyEvents.length && window.flyEvents.map(x=>({ref:x.ref,from:x.from,to:m.itemByRef(a.p,x.ref).placed}));
    `),view+' no committed drop or flight');
    assert(changed.some(x=>second[x.ref]&&x.to&&Math.hypot(x.to.x-x.from.x,x.to.y-x.from.y)>0.1),view+' missing flight to real coordinates');
    const after=await placement(), beforeMap=new Map(initial.map(x=>[x[0],x[1]]));
    const moved=after.filter(row=>owned.includes(row[0])&&row[1]&&JSON.stringify(beforeMap.get(row[0]))!==JSON.stringify(row[1]));
    assert(moved.length>0,view+' physical child coordinates did not move');
    const collisions=await modelState(`
      const rect=x=>x.kind?m.satFootprint(x):m.footprint(x);
      const occupied=[...a.p.parts,...a.p.satellites].filter(x=>x.placed);
      const refs=${JSON.stringify(moved.map(row=>row[0]))};
      return refs.flatMap(ref=>{
        const x=m.itemByRef(a.p,ref), b=rect(x);
        if(!g.rectInBoard(a.p.board.outline,b))return [ref+' outside'];
        const hit=occupied.find(o=>o!==x&&(o.through||o.placed.side===x.placed.side)&&g.overlaps(b,rect(o)));
        return hit?[ref+'/'+hit.ref]:[];
      });
    `);
    assert.deepEqual(collisions,[],view+' auto-placement overlaps');
    const waiting=await modelState('return children.filter(x=>!x.placed).map(x=>x.ref)');
    await evaluate('restoreAnimate();document.querySelector("#btn-undo").click()');
    assert.deepEqual(await placement(),initial,'undo failed to restore physical placement');
    if(view==='2d') {
      await evaluate('document.querySelector("#btn-anim").click()');
      await click(start); await mouse('mouseMoved',dest,1); await click(dest,1);
      assert.deepEqual(await placement(),after,'automatic placement changed with animation disabled');
      await evaluate('document.querySelector("#btn-undo").click();document.querySelector("#btn-anim").click()');
    }
    console.log(view,core,'drop',dest.boardX,dest.boardY,'orbit',Object.keys(second).length,'moved',moved.length,'flight',changed.length,'pending',waiting.join(','));
  }
  await gesture('2d');
  await gesture('3d');
  await media('reduce');
  await until(()=>evaluate('LP.App.systemReduced && LP.App.reducedMotion'),'reduced motion not active');
  await evaluate('document.querySelector("#btn-anim").click()');
  assert.equal(await evaluate('LP.App.reducedMotion'),false,'explicit page playback unavailable');
  await evaluate('window.beforeReducedReload=true');
  await send('Page.reload');
  await until(()=>evaluate('!window.beforeReducedReload && !!window.__LP_READY'),'reload');
  assert(await evaluate('LP.App.reducedMotion'),'reduced-motion preference ignored');
  assert.deepEqual(errors,[]);
  console.log('PASS: core-only tray, real pickup, orbit, drop, automatic legal placement and undo.');
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
