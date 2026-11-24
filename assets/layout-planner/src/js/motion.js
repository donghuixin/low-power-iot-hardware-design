/* Screen-space feedback for brief 3D location pulses. Pickup and landing use board-space geometry in each renderer. */
(function (LP) {
  'use strict';
  let app, canvas, ctx, frame = 0, pulses = [];
  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pulses = [];
    canvas.hidden = true;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  function draw(now) {
    frame = 0;
    pulses = pulses.filter(p => now - p.start < 650);
    if (!pulses.length || app.reducedMotion || document.hidden) { stop(); return; }
    canvas.hidden = false;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * scale), h = Math.round(canvas.clientHeight * scale);
    if (!w || !h) { stop(); return; }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (const p of pulses) {
      const pos = app.renderer.boardToScreen(p.x, p.y, 0.7), t = Math.max(0, (now - p.start) / 650);
      ctx.beginPath(); ctx.arc(pos.x, pos.y, 5 + 26 * t, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255,211,63,' + (1 - t) + ')'; ctx.lineWidth = 3; ctx.stroke();
    }
    frame = requestAnimationFrame(draw);
  }
  LP.motion = {
    init(application, layer) {
      app = application; canvas = layer; ctx = canvas.getContext('2d');
      for (const name of ['load','anim','view']) app.on(name, stop);
      document.addEventListener('visibilitychange', stop);
    },
    pulse(type, data) {
      if (app.reducedMotion || document.hidden) return;
      const points = type === 'ripple' ? [data] : data.refs.map(ref => LP.model.itemByRef(app.p, ref))
        .filter(item => item && item.placed && app.renderer.onSide(item.placed.side)).map(item => item.placed);
      const start = performance.now();
      pulses.push(...points.map(p => ({x:p.x, y:p.y, start})));
      if (pulses.length && !frame) frame = requestAnimationFrame(draw);
    },
  };
})(globalThis.LP = globalThis.LP || {});
