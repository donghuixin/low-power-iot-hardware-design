/* 在独立画布上投影关联器件的环绕预览；命中、撤销与导出始终使用板上的实位。 */
(function (LP) {
  'use strict';
  const M = LP.model;
  let app, canvas, ctx, frame = 0, world, screen, face, pulses = [];
  let parents, groups, group, groupKey, orbitFrame;

  function indexGroups() {
    parents = new Map();
    groups = new Map();
    const parts = new Map(app.p.parts.map(part => [part.ref, part]));
    const add = (item, owner, native) => {
      const core = parts.get(owner);
      if (!core || core === item) return;
      parents.set(item.ref, owner);
      if (!groups.has(owner)) groups.set(owner, { core, members: [] });
      groups.get(owner).members.push({ item, native });
    };
    for (const part of parts.values()) add(part, part.orbitParent || part.associatedParent, false);
    for (const sat of app.p.satellites) add(sat, sat.parent[0], true);
  }

  function visibleGroup() {
    if (!app.layers.sats || app.boardEditing || (app.drag && !app.drag.visible)) return null;
    if (!groups) indexGroups();
    const drag = app.drag, side = app.renderer.viewSide();
    const selected = drag ? drag.ref : app.sel && app.sel.ref;
    const key = JSON.stringify([selected, !!drag, drag && drag.pl && drag.pl.side, side]);
    if (key === groupKey) return group;
    groupKey = key;
    group = null;
    function consider(candidate) {
      if (!candidate) return null;
      const {core, members} = candidate;
      const pose = drag && drag.ref === core.ref ? drag.pl : core.placed;
      if (!pose || (!core.through && pose.side !== side)) return null;
      const visible = members.filter(({item, native}) => item.placed && item.placed.side === side &&
        !item.locked && !item.pinned && (!native || (item._active && !drag)));
      if (!visible.length) return null;
      const dist = ({item}) => Math.hypot(item.placed.x - pose.x, item.placed.y - pose.y);
      visible.sort((a, b) => Number(b.item.ref === selected) - Number(a.item.ref === selected) || dist(a) - dist(b));
      return { core, members: visible.slice(0, 8), total: visible.length };
    }
    if (selected) {
      // 拖动普通器件时只显示该器件本身的反馈。点选卫星可单独查看所属核心。
      group = consider(groups.get(selected) || (!drag && groups.get(parents.get(selected))));
    } else {
      group = consider(groups.get(app.p.orbitFocus));
      if (!group) for (const candidate of groups.values()) {
        const next = consider(candidate);
        if (next && (!group || next.total > group.total)) group = next;
      }
    }
    return group;
  }

  function drawOrbitLabel(item, pkg, body, origin, ax, ay, bx, by) {
    let horizontal = body.w >= body.h;
    let length = horizontal ? body.w : body.h;
    if (pkg && pkg.terminals.length === 2) {
      const [a, b] = pkg.terminals;
      horizontal = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y);
      length = horizontal ? Math.abs(a.x - b.x) - (a.w + b.w) / 2 : Math.abs(a.y - b.y) - (a.h + b.h) / 2;
    }
    const across = horizontal ? body.h : body.w;
    const ux = horizontal ? ax : bx, uy = horizontal ? ay : by;
    const vx = horizontal ? bx : ax, vy = horizontal ? by : ay;
    const unit = Math.hypot(ux, uy);
    if (unit < 0.01) return;
    // 只使用投影后本体中段可容纳的矩形，给金属端头留白。
    const width = length * unit - across * Math.abs(ux * vx + uy * vy) / unit;
    const height = across * Math.abs(ux * vy - uy * vx) / unit;
    if (width < 14 || height < 9) return;
    let angle = Math.atan2(uy, ux);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle <= -Math.PI / 2) angle += Math.PI;
    ctx.save();
    ctx.translate(origin.x + ax * body.x + bx * body.y, origin.y + ay * body.x + by * body.y);
    ctx.rotate(angle);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.min(13, Math.max(8, height * 0.58)) + 'px ui-monospace, monospace';
    const light = pkg?.kind === 'capacitor' || ['module', 'coin', 'usb_c', 'fpc', 'mic'].includes(item.shape);
    ctx.fillStyle = light ? '#282b2f' : '#f5f7f8';
    LP.render2d.drawFaceText(ctx, item, { x: -width / 2, w: width }, 0);
    ctx.restore();
  }

  function drawGroup(group, now) {
    const {core, members, total} = group, renderer = app.renderer;
    const drag = app.drag, pl = drag ? { ...drag.pl, ...(drag.raw || {}) } : core.placed;
    const height = (core.z || 1) + (drag ? 3.0 : 0.8);
    const project = (x, y, z) => renderer.boardToScreen(x, y, z);
    const center = project(pl.x, pl.y, height);
    // 两个绘制器都采用平行投影。每帧只需四个投影点，即可让导轨和封装随翻面、缩放、相机旋转。
    const px = project(pl.x + 1, pl.y, height), py = project(pl.x, pl.y + 1, height);
    const pz = project(pl.x, pl.y, height + 1);
    const ex = {x:px.x-center.x, y:px.y-center.y}, ey = {x:py.x-center.x, y:py.y-center.y};
    const ez = {x:pz.x-center.x, y:pz.y-center.y};
    const scale = Math.max(0.01, Math.hypot(ex.x, ex.y), Math.hypot(ey.x, ey.y));
    const pos = LP.render2d.orbitPositions(core, pl, members.map(m => m.item), now);
    const modelAt = (x, y, z = 0) => ({
      x: center.x + ex.x * (x-pl.x) + ey.x * (y-pl.y) + ez.x * z,
      y: center.y + ex.y * (x-pl.x) + ey.y * (y-pl.y) + ez.y * z
    });
    ctx.save();
    ctx.beginPath();
    let top = Infinity;
    for (const ring of pos.rings.filter(Boolean)) {
      for (let i = 0; i <= 64; i++) {
        const a = Math.PI * 2 * i / 64;
        const q = modelAt(pl.x + ring.rx * Math.cos(a), pl.y + ring.ry * Math.sin(a));
        top = Math.min(top, q.y);
        if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      }
    }
    ctx.strokeStyle = 'rgba(8,45,49,.75)'; ctx.lineWidth = 3; ctx.stroke();
    ctx.setLineDash([4, 5]); ctx.strokeStyle = '#71e8d2'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    const painted = [];
    for (let i = 0; i < pos.items.length; i++) {
      const q = pos.items[i], item = q.sat;
      const pkg = M.passiveGeometry(item), body = pkg ? pkg.body : {x:0, y:0, w:item.w, h:item.h};
      const z = Math.min(pkg ? pkg.height : (item.z || 0.45), 2), origin = modelAt(q.x, q.y, z);
      const cos = Math.cos(q.ang + Math.PI/2), sin = Math.sin(q.ang + Math.PI/2);
      const k = Math.min(1.8, Math.max(1, 13 / (scale * Math.max(body.w, body.h))));
      ctx.save();
      const ax = (ex.x*cos+ey.x*sin)*k, ay = (ex.y*cos+ey.y*sin)*k;
      const bx = (ey.x*cos-ex.x*sin)*k, by = (ey.y*cos-ex.y*sin)*k;
      if (renderer.kind === '3d') {
        const corners = [[-1,-1], [1,-1], [1,1], [-1,1]].map(([sx,sy]) => {
          const x = body.x + sx*body.w/2, y = body.y + sy*body.h/2;
          return { x:origin.x + ax*x + bx*y, y:origin.y + ay*x + by*y };
        });
        ctx.fillStyle = '#596165';
        for (let j = 0; j < corners.length; j++) {
          const a = corners[j], b = corners[(j+1)%4];
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
          ctx.lineTo(b.x-ez.x*z,b.y-ez.y*z); ctx.lineTo(a.x-ez.x*z,a.y-ez.y*z); ctx.closePath(); ctx.fill();
        }
      }
      ctx.transform(ax, ay, bx, by, origin.x, origin.y);
      LP.render2d.roundRectPath(ctx, body.x-body.w/2, body.y-body.h/2, body.w, body.h, Math.min(body.w,body.h)*0.1);
      ctx.lineWidth = 4/(scale*k); ctx.strokeStyle = '#16545a'; ctx.stroke();
      ctx.lineWidth = 2/(scale*k); ctx.strokeStyle = '#9affdf'; ctx.stroke();
      LP.render2d.drawItem(ctx, item, members[i].native, {floating:true});
      ctx.restore();
      drawOrbitLabel(item, pkg, body, origin, ax, ay, bx, by);
      painted.push({ref:item.ref, x:origin.x, y:origin.y, angle:q.ang, home:modelAt(item.placed.x, item.placed.y, -height)});
    }
    const label = M.faceName(core) + ' · 关联预览 ' + members.length + (members.length < total ? '/' + total : '');
    ctx.font = '600 11px system-ui, sans-serif';
    const width = ctx.measureText(label).width + 14;
    const cx = Math.max(width/2+2, Math.min(canvas.clientWidth-width/2-2, center.x));
    const cy = Math.max(13, top-13);
    LP.render2d.roundRectPath(ctx,cx-width/2,cy-9,width,18,5);
    ctx.fillStyle = 'rgba(13,53,56,.94)'; ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#c7ffed'; ctx.fillText(label,cx,cy);
    ctx.restore();
    orbitFrame = { core:core.ref, center, members:painted, total };
    canvas.dataset.orbitCore = core.ref;
  }

  function trace() {
    const p = app.p, renderer = app.renderer, selected = app.sel && app.sel.ref;
    const visible = new Map(p.parts.filter(x => x.placed &&
      renderer.onSide(x.through ? 'both' : x.placed.side)).map(x => [x.ref, x]));
    let best = null, score = -1;
    for (const net of p.nets) {
      const pins = net.pins.filter(([ref]) => visible.has(ref));
      if (pins.length < 2) continue;
      const start = pins.find(([ref]) => ref === selected) || pins[0];
      const end = pins.find(([ref]) => ref !== start[0]);
      if (!end) continue;
      const rank = (selected && start[0] === selected ? 4 : 0) + (net.class === 'power' ? 0 : 1);
      if (rank <= score) continue;
      const points = [start, end].map(([ref, id]) => M.pinWorld(visible.get(ref), id));
      if (!points.every(Boolean) || Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) < 0.1) continue;
      best = { name: net.name, points }; score = rank;
    }
    if (best) return best;
    const outline = LP.geometry.outlinePolygon(p.board.outline);
    return { name: '板框', points: [...outline, outline[0]] };
  }

  function project() {
    const projected = world.points.map(p => app.renderer.boardToScreen(p.x, p.y));
    let length = 0;
    const segments = [];
    for (let i = 1; i < projected.length; i++) {
      const a = projected[i - 1], b = projected[i], d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d > 0) { segments.push({ a, b, d, start: length }); length += d; }
    }
    return { projected, segments, length };
  }

  function draw(now) {
    frame = 0;
    if (!app.animOn || document.hidden || !app.renderer || !app.p) return;
    canvas.hidden = false;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w < 1 || h < 1) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * scale) || canvas.height !== Math.round(h * scale)) {
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale); screen = null;
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const activeGroup = visibleGroup();
    if (activeGroup) {
      drawGroup(activeGroup, now);
      canvas.dataset.trace = '';
    } else {
      orbitFrame = null;
      delete canvas.dataset.orbitCore;
      if (!world || face !== app.flipped) { world = trace(); face = app.flipped; screen = null; }
      if (!screen) screen = project();
      drawTrace(now);
    }
    pulses = pulses.filter(p => now - p.start < 650);
    for (const p of pulses) {
      const pos = app.renderer.boardToScreen(p.x, p.y, 0.7), t = (now - p.start) / 650;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, 5 + 26 * t, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255,211,63,' + (1 - t) + ')'; ctx.lineWidth = 3; ctx.stroke();
    }
    frame = requestAnimationFrame(draw);
  }

  function drawTrace(now) {
    const { projected, segments, length } = screen;
    canvas.dataset.trace = world.name;
    ctx.lineCap = 'round';
    ctx.beginPath();
    projected.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = 'rgba(8,44,55,.72)'; ctx.lineWidth = 3; ctx.stroke();
    ctx.setLineDash([7, 8]); ctx.lineDashOffset = -(now * 0.025) % 15;
    ctx.strokeStyle = '#67f7ee'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    if (length) for (let i = 0; i < 3; i++) {
      const distance = length * (0.5 - 0.47 * Math.cos(now / 810 + i * 2.095));
      const seg = segments.find(s => s.start + s.d >= distance) || segments[segments.length - 1];
      const t = (distance - seg.start) / seg.d;
      const x = seg.a.x + (seg.b.x - seg.a.x) * t, y = seg.a.y + (seg.b.y - seg.a.y) * t;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff6af'; ctx.fill(); ctx.strokeStyle = '#11696a'; ctx.lineWidth = 1.8; ctx.stroke();
    }
  }

  function reset() {
    if (frame) cancelAnimationFrame(frame);
    groups = group = groupKey = orbitFrame = world = screen = null; frame = 0; pulses = [];
    delete canvas.dataset.orbitCore; delete canvas.dataset.trace;
    canvas.hidden = true;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (app.animOn && !document.hidden) frame = requestAnimationFrame(draw);
  }

  LP.motion = {
    get orbitFrame() { return orbitFrame; },
    init(application, layer) {
      app = application; canvas = layer; ctx = canvas.getContext('2d');
      for (const name of ['anim', 'load', 'select', 'view']) app.on(name, reset);
      app.on('change', () => { groups = groupKey = world = screen = null; });
      app.on('boardlive', () => { groups = groupKey = world = screen = null; });
      app.on('drawn', () => { screen = null; });
      document.addEventListener('visibilitychange', reset);
    },
    pulse(type, data) {
      if (!app.animOn) return;
      const points = type === 'ripple' ? [data] : data.refs.map(ref => M.itemByRef(app.p, ref))
        .filter(item => item && item.placed && app.renderer.onSide(item.placed.side)).map(item => item.placed);
      const start = performance.now();
      pulses.push(...points.map(p => ({ x: p.x, y: p.y, start })));
    },
  };
})(globalThis.LP = globalThis.LP || {});
