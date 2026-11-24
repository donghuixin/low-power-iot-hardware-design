/* 共享的屏幕反馈层，只投影本视面的真实端点或板框，不修改工程坐标。 */
(function (LP) {
  'use strict';
  const M = LP.model;
  let app, canvas, ctx, frame = 0, world, screen, face, pulses = [];

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
    if (!world || face !== app.flipped) { world = trace(); face = app.flipped; screen = null; }
    if (!screen) screen = project();
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
    pulses = pulses.filter(p => now - p.start < 650);
    for (const p of pulses) {
      const pos = app.renderer.boardToScreen(p.x, p.y, 0.7), t = (now - p.start) / 650;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, 5 + 26 * t, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255,211,63,' + (1 - t) + ')'; ctx.lineWidth = 3; ctx.stroke();
    }
    frame = requestAnimationFrame(draw);
  }

  function reset() {
    if (frame) cancelAnimationFrame(frame);
    world = screen = null; frame = 0; pulses = [];
    canvas.hidden = true;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (app.animOn && !document.hidden) frame = requestAnimationFrame(draw);
  }

  LP.motion = {
    init(application, layer) {
      app = application; canvas = layer; ctx = canvas.getContext('2d');
      for (const name of ['anim', 'load', 'select', 'view']) app.on(name, reset);
      app.on('change', () => { world = screen = null; });
      app.on('boardlive', () => { world = screen = null; });
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
