/*
 * render2d.js — 2D 俯视绘制层（Canvas 2D，默认视图）。
 * 世界坐标为毫米、y 向上；屏幕坐标为 CSS 像素、y 向下。翻板时从背面看，x 镜像。
 * 对上层提供与 3D 绘制层相同的接口：resize / fit / screenToBoard / boardToScreen / pick / requestDraw / focus / animate。
 */
(function (LP) {
  'use strict';
  const G = LP.geometry, M = LP.model;

  const MASK = {
    green: { top: '#1f5c46', top2: '#24694f', grid: 'rgba(255,255,255,0.07)', grid5: 'rgba(255,255,255,0.15)', silk: '#e9efe9' },
    blue:  { top: '#1d3e68', top2: '#234877', grid: 'rgba(255,255,255,0.07)', grid5: 'rgba(255,255,255,0.15)', silk: '#e6ecf5' },
    black: { top: '#1c1e21', top2: '#232529', grid: 'rgba(255,255,255,0.06)', grid5: 'rgba(255,255,255,0.13)', silk: '#e8e8e8' },
    white: { top: '#ebe9e3', top2: '#f3f1ec', grid: 'rgba(0,0,0,0.06)', grid5: 'rgba(0,0,0,0.13)', silk: '#3b3b3b' },
  };
  const SUBSTRATE = '#d7c79a';
  const COPPER = '#c9a35a';
  const ACCENT = { ok: '#14b8a6', warn: '#f59e0b', bad: '#ef4444', sel: '#38bdf8' };

  const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- 器件造型（局部坐标：毫米、y 向上、中心为原点） ----------
  function body(ctx, w, h, fill, r) { roundRectPath(ctx, -w / 2, -h / 2, w, h, r ?? Math.min(w, h) * 0.12); ctx.fillStyle = fill; ctx.fill(); }
  function sheen(ctx, w, h, a) {
    const g = ctx.createLinearGradient(0, h / 2, 0, -h / 2);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.5, 'rgba(255,255,255,0)');
    roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.12); ctx.fillStyle = g; ctx.fill();
  }
  function edgePads(ctx, w, h, sides, color) {
    ctx.fillStyle = color || '#d8b66a';
    const t = Math.min(0.2, Math.min(w, h) * 0.08);
    const pitch = 0.5;
    for (const s of sides) {
      const len = s === 'N' || s === 'S' ? w : h;
      const n = Math.max(1, Math.floor((len * 0.8) / pitch));
      const start = -((n - 1) * pitch) / 2;
      for (let i = 0; i < n; i++) {
        const c = start + i * pitch;
        const pw = 0.22, pl = t * 1.6;
        if (s === 'N') ctx.fillRect(c - pw / 2, h / 2 - pl, pw, pl);
        if (s === 'S') ctx.fillRect(c - pw / 2, -h / 2, pw, pl);
        if (s === 'E') ctx.fillRect(w / 2 - pl, c - pw / 2, pl, pw);
        if (s === 'W') ctx.fillRect(-w / 2, c - pw / 2, pl, pw);
      }
    }
  }
  function pin1(ctx, w, h) {
    const r = Math.min(0.28, Math.min(w, h) * 0.08);
    ctx.beginPath(); ctx.arc(-w / 2 + r * 2.4, h / 2 - r * 2.4, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
  }
  function legs(ctx, w, h, sides) {
    ctx.fillStyle = '#c9ccd2';
    const pitch = 1.27, lw = 0.4, ll = 0.6;
    for (const s of sides) {
      const len = s === 'E' || s === 'W' ? h : w;
      const n = Math.max(2, Math.floor((len * 0.9) / pitch));
      const start = -((n - 1) * pitch) / 2;
      for (let i = 0; i < n; i++) {
        const c = start + i * pitch;
        if (s === 'E') ctx.fillRect(w / 2, c - lw / 2, ll, lw);
        if (s === 'W') ctx.fillRect(-w / 2 - ll, c - lw / 2, ll, lw);
        if (s === 'N') ctx.fillRect(c - lw / 2, h / 2, lw, ll);
        if (s === 'S') ctx.fillRect(c - lw / 2, -h / 2 - ll, lw, ll);
      }
    }
  }
  /** 顶面小图标，画在右下角并调淡，不与居中的位号重叠。 */
  function icon(ctx, role, w, h) {
    if (!['imu', 'barometer', 'microphone', 'temp_humidity', 'magnetometer'].includes(role)) return;
    const s = Math.min(w, h) * 0.55;
    ctx.save();
    ctx.translate(w / 2 - s * 0.55, -h / 2 + s * 0.55);
    ctx.globalAlpha *= 0.55;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = s * 0.06; ctx.lineCap = 'round';
    if (role === 'imu') {
      const L = s * 0.38;
      const arrow = (dx, dy) => { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(dx, dy); ctx.stroke(); };
      arrow(L, 0); arrow(0, L); arrow(-L * 0.6, -L * 0.6);
    } else if (role === 'barometer' || role === 'microphone') {
      ctx.beginPath(); ctx.arc(s * 0.15, s * 0.1, s * 0.11, 0, Math.PI * 2); ctx.fillStyle = '#0d0e10'; ctx.fill();
    } else if (role === 'temp_humidity') {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = s * 0.03;
      const q = s * 0.22;
      for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(-q, i * q * 0.6); ctx.lineTo(q, i * q * 0.6); ctx.stroke(); ctx.beginPath(); ctx.moveTo(i * q * 0.6, -q); ctx.lineTo(i * q * 0.6, q); ctx.stroke(); }
    } else if (role === 'magnetometer') {
      ctx.beginPath(); ctx.moveTo(0, s * 0.3); ctx.lineTo(s * 0.08, 0); ctx.lineTo(0, -s * 0.3); ctx.lineTo(-s * 0.08, 0); ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
    }
    ctx.restore();
  }

  /** 画一个器件。item 为主器件或卫星；ghost 时只画轮廓。 */
  function drawItem(ctx, item, isSat, opts) {
    const w = item.w, h = item.h;
    const ghost = opts && opts.ghost;
    if (ghost) {
      if (item.shape === 'coin') { ctx.beginPath(); ctx.arc(0, 0, Math.min(w, h) / 2, 0, Math.PI * 2); }
      else roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.15);
      ctx.setLineDash([0.6, 0.4]); ctx.lineWidth = 0.12; ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
      return;
    }
    if (isSat) return drawSat(ctx, item);
    const shape = item.shape;
    switch (shape) {
      case 'module': {
        body(ctx, w, h, '#c4c8cf', 0.3);
        roundRectPath(ctx, -w / 2 + 0.4, -h / 2 + 0.4, w - 0.8, h - 0.8, 0.2); ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.12; ctx.stroke();
        sheen(ctx, w, h, 0.35); break;
      }
      case 'chip_antenna': {
        body(ctx, w, h, '#efe8d8', Math.min(w, h) * 0.2);
        const cap = Math.min(w, h) * 0.45;
        ctx.fillStyle = '#c7cbd2';
        if (w >= h) { ctx.fillRect(-w / 2, -h / 2, cap, h); ctx.fillRect(w / 2 - cap, -h / 2, cap, h); }
        else { ctx.fillRect(-w / 2, -h / 2, w, cap); ctx.fillRect(-w / 2, h / 2 - cap, w, cap); }
        sheen(ctx, w, h, 0.3); break;
      }
      case 'pcb_antenna': {
        ctx.strokeStyle = COPPER; ctx.lineWidth = Math.min(w, h) * 0.12; ctx.lineJoin = 'round';
        ctx.beginPath();
        const n = 5, step = w / n;
        ctx.moveTo(-w / 2, -h / 2 + 0.2);
        for (let i = 0; i < n; i++) { const x = -w / 2 + i * step; ctx.lineTo(x, h / 2 - 0.2); ctx.lineTo(x + step / 2, h / 2 - 0.2); ctx.lineTo(x + step / 2, -h / 2 + 0.6); ctx.lineTo(x + step, -h / 2 + 0.6); }
        ctx.stroke(); break;
      }
      case 'coin': {
        const r = Math.min(w, h) / 2;
        const g = ctx.createRadialGradient(-r * 0.3, r * 0.3, r * 0.1, 0, 0, r);
        g.addColorStop(0, '#f1f2f4'); g.addColorStop(0.7, '#c4c8ce'); g.addColorStop(1, '#9aa0a8');
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
        ctx.fillStyle = '#b5b9c0'; ctx.fillRect(-r * 0.25, -r * 1.0, r * 0.5, r * 0.35);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = r * 0.04;
        ctx.beginPath(); ctx.moveTo(-r * 0.15, r * 0.45); ctx.lineTo(r * 0.15, r * 0.45); ctx.moveTo(0, r * 0.3); ctx.lineTo(0, r * 0.6); ctx.stroke();
        break;
      }
      case 'pouch': body(ctx, w, h, '#b9c3d1', 0.6); sheen(ctx, w, h, 0.4); break;
      case 'usb_c': {
        body(ctx, w, h, '#b9bdc5', Math.min(w, h) * 0.35);
        const face = item.edge_face || 'S';
        ctx.fillStyle = '#4b5059';
        const sw = Math.min(w, h) * 0.22;
        if (face === 'S') ctx.fillRect(-w * 0.32, -h / 2, w * 0.64, sw);
        if (face === 'N') ctx.fillRect(-w * 0.32, h / 2 - sw, w * 0.64, sw);
        if (face === 'E') ctx.fillRect(w / 2 - sw, -h * 0.32, sw, h * 0.64);
        if (face === 'W') ctx.fillRect(-w / 2, -h * 0.32, sw, h * 0.64);
        sheen(ctx, w, h, 0.35); break;
      }
      case 'header': {
        body(ctx, w, h, '#222428', 0.2);
        ctx.fillStyle = '#d8b66a';
        const cols = Math.max(1, Math.round(w / 1.27)), rows = Math.max(1, Math.round(h / 1.27));
        for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
          const x = -w / 2 + (i + 0.5) * (w / cols), y = -h / 2 + (j + 0.5) * (h / rows);
          ctx.fillRect(x - 0.22, y - 0.22, 0.44, 0.44);
        }
        break;
      }
      case 'fpc': {
        body(ctx, w, h, '#e3d6b5', 0.2);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        for (let x = -w / 2 + 0.5; x < w / 2 - 0.3; x += 0.5) ctx.fillRect(x, -h / 2 + 0.2, 0.2, h * 0.5);
        break;
      }
      case 'inductor': {
        body(ctx, w, h, '#2a2c31', Math.min(w, h) * 0.25);
        ctx.beginPath(); ctx.arc(0, 0, Math.min(w, h) * 0.3, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = Math.min(w, h) * 0.06; ctx.stroke();
        sheen(ctx, w, h, 0.12); break;
      }
      case 'button': {
        body(ctx, w, h, '#3a3d43', 0.3);
        const r = Math.min(w, h) * 0.32;
        const g = ctx.createRadialGradient(-r * 0.3, r * 0.3, r * 0.1, 0, 0, r);
        g.addColorStop(0, '#c9ced6'); g.addColorStop(1, '#7c838d');
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
        break;
      }
      case 'led': {
        const c = item.color || '#f43f5e';
        ctx.save(); ctx.shadowColor = c; ctx.shadowBlur = 8;
        body(ctx, w, h, c + 'cc', Math.min(w, h) * 0.3); ctx.restore();
        sheen(ctx, w, h, 0.45); break;
      }
      case 'optical': {
        body(ctx, w, h, '#2b2e33');
        ctx.fillStyle = '#0b0c0e';
        roundRectPath(ctx, -w * 0.4, -h * 0.25, w * 0.32, h * 0.5, 0.15); ctx.fill();
        roundRectPath(ctx, w * 0.08, -h * 0.25, w * 0.32, h * 0.5, 0.15); ctx.fill();
        break;
      }
      case 'mic': body(ctx, w, h, '#b9bdc5', 0.3); icon(ctx, 'microphone', w, h); break;
      case 'soic': legs(ctx, w, h, ['E', 'W']); body(ctx, w, h, '#2f3237', 0.15); pin1(ctx, w, h); sheen(ctx, w, h, 0.1); break;
      case 'sot': legs(ctx, w, h, ['N', 'S']); body(ctx, w, h, '#2f3237', 0.15); pin1(ctx, w, h); break;
      case 'bga': {
        body(ctx, w, h, '#2b2e33');
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        for (let x = -w / 2 + 0.6; x < w / 2 - 0.3; x += 0.8) for (let y = -h / 2 + 0.6; y < h / 2 - 0.3; y += 0.8) { ctx.beginPath(); ctx.arc(x, y, 0.12, 0, Math.PI * 2); ctx.fill(); }
        pin1(ctx, w, h); sheen(ctx, w, h, 0.12); break;
      }
      case 'dfn': case 'uson': body(ctx, w, h, '#33363b'); edgePads(ctx, w, h, ['E', 'W']); pin1(ctx, w, h); icon(ctx, item.role, w, h); sheen(ctx, w, h, 0.1); break;
      case 'lga': body(ctx, w, h, '#30333a'); edgePads(ctx, w, h, ['N', 'E', 'S', 'W'], 'rgba(216,182,106,0.7)'); pin1(ctx, w, h); icon(ctx, item.role, w, h); sheen(ctx, w, h, 0.12); break;
      case 'qfn': default: body(ctx, w, h, '#33363b'); edgePads(ctx, w, h, ['N', 'E', 'S', 'W']); pin1(ctx, w, h); icon(ctx, item.role, w, h); sheen(ctx, w, h, 0.12); break;
    }
  }
  function drawSat(ctx, s) {
    const w = s.w, h = s.h;
    const shape = M.SAT_KINDS[s.kind].shape;
    const along = w >= h ? 'x' : 'y';
    const endFrac = 0.22;
    const ends = () => {
      ctx.fillStyle = '#d9dce1';
      if (along === 'x') { ctx.fillRect(-w / 2, -h / 2, w * endFrac, h); ctx.fillRect(w / 2 - w * endFrac, -h / 2, w * endFrac, h); }
      else { ctx.fillRect(-w / 2, -h / 2, w, h * endFrac); ctx.fillRect(-w / 2, h / 2 - h * endFrac, w, h * endFrac); }
    };
    if (shape === 'crystal') { body(ctx, w, h, '#c9cdd3', Math.min(w, h) * 0.25); sheen(ctx, w, h, 0.4); return; }
    if (shape === 'inductor') { body(ctx, w, h, '#2a2c31', Math.min(w, h) * 0.2); ends(); return; }
    if (shape === 'res') { body(ctx, w, h, '#25272b', 0.05); ends(); return; }
    if (shape === 'esd') { body(ctx, w, h, '#2b2e33', 0.05); ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(-w / 2 + w * 0.15, -h / 2, w * 0.08, h); return; }
    body(ctx, w, h, '#cbb68c', 0.05); ends();
  }

  // ---------- 绘制层 ----------
  class Renderer2D {
    constructor(app, canvas, overlay, opts) {
      this.app = app; this.canvas = canvas; this.overlay = overlay;
      this.opts = opts || {};
      this.ctx = canvas.getContext('2d');
      this.s = 20; this.ox = 0; this.oy = 0;
      this.anims = [];
      this.dirty = true; this.raf = 0;
      this.kind = '2d';
      this.resize();
    }
    get dpr() { return window.devicePixelRatio || 1; }
    resize() {
      const r = this.canvas.parentElement.getBoundingClientRect();
      this.W = Math.max(100, r.width); this.H = Math.max(100, r.height);
      this.canvas.width = Math.round(this.W * this.dpr); this.canvas.height = Math.round(this.H * this.dpr);
      this.canvas.style.width = this.W + 'px'; this.canvas.style.height = this.H + 'px';
      this.requestDraw();
    }
    bbox() { return G.outlineBBox(this.app.p.board.outline); }
    /** 把板子放进未被面板遮挡的区域。 */
    fit(animate) {
      const bb = this.bbox(), ins = this.opts.noInsets ? { left: 0, right: 0, top: 0, bottom: 0 } : this.app.insets();
      const aw = this.W - ins.left - ins.right - 80, ah = this.H - ins.top - ins.bottom - 70;
      const s = Math.max(4, Math.min(aw / (bb.x1 - bb.x0), ah / (bb.y1 - bb.y0)));
      const cx = ins.left + (this.W - ins.left - ins.right) / 2, cy = ins.top + (this.H - ins.top - ins.bottom) / 2;
      const target = { s, ox: cx - ((bb.x0 + bb.x1) / 2) * s, oy: cy + ((bb.y0 + bb.y1) / 2) * s };
      this.setView(target, animate);
    }
    setView(t, animate) {
      if (animate && !this.app.reducedMotion) {
        const from = { s: this.s, ox: this.ox, oy: this.oy };
        this.anims.push({ type: 'view', t0: performance.now(), dur: 320, from, to: t });
      } else { this.s = t.s; this.ox = t.ox; this.oy = t.oy; }
      this.requestDraw();
    }
    /** 平滑移到一组器件。 */
    focus(rect) {
      if (!rect) return;
      const ins = this.app.insets();
      const aw = this.W - ins.left - ins.right, ah = this.H - ins.top - ins.bottom;
      const s = Math.min(this.s * 1.0, Math.max(this.s, Math.min(aw / ((rect.x1 - rect.x0) + 16), ah / ((rect.y1 - rect.y0) + 16))));
      const c = G.center(rect);
      const bx = this.mirrorX(c.x);
      this.setView({ s, ox: ins.left + aw / 2 - bx * s, oy: ins.top + ah / 2 + c.y * s }, true);
    }
    mirrorX(x) { if (!this.app.flipped) return x; const bb = this.bbox(); return bb.x0 + bb.x1 - x; }
    boardToScreen(x, y) { return { x: this.ox + this.mirrorX(x) * this.s, y: this.oy - y * this.s }; }
    screenToBoard(sx, sy) { const bx = (sx - this.ox) / this.s; return { x: this.mirrorX(bx), y: (this.oy - sy) / this.s }; }
    zoomAt(sx, sy, factor) {
      const ns = Math.max(3, Math.min(160, this.s * factor));
      const f = ns / this.s;
      this.ox = sx - (sx - this.ox) * f; this.oy = sy - (sy - this.oy) * f; this.s = ns;
      this.requestDraw();
    }
    pan(dx, dy) { this.ox += dx; this.oy += dy; this.requestDraw(); }
    screenRect(r) {
      const a = this.boardToScreen(r.x0, r.y0), b = this.boardToScreen(r.x1, r.y1);
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    }
    viewSide() { return this.app.flipped ? 'bottom' : 'top'; }
    onSide(side) { return side === 'both' || side === this.viewSide(); }

    /** 拾取屏幕位置上最上层的对象。 */
    pick(sx, sy) {
      const app = this.app, p = app.p, pt = this.screenToBoard(sx, sy);
      const tol = 3 / this.s;
      const hit = (r) => pt.x >= r.x0 - tol && pt.x <= r.x1 + tol && pt.y >= r.y0 - tol && pt.y <= r.y1 + tol;
      if (app.layers.sats) {
        for (const s of p.satellites) if (s.placed && s._active && this.onSide(s.placed.side) && hit(M.satFootprint(s))) return { type: 'sat', ref: s.ref };
      }
      const parts = p.parts.filter((x) => x.placed).sort((a, b) => b.z - a.z);
      for (const x of parts) if (this.onSide(x.through ? 'both' : x.placed.side) && hit(M.footprint(x))) return { type: 'part', ref: x.ref };
      for (const x of parts) if (hit(M.footprint(x))) return { type: 'part', ref: x.ref, backside: true };
      return null;
    }
    /** 板框缩放手柄（仅矩形与圆形板框）。 */
    boardHandles() {
      const o = this.app.p.board.outline;
      if (o.type === 'rect') return [
        { id: 'e', ...this.boardToScreen(o.w, o.h / 2), cursor: 'ew-resize' },
        { id: 'n', ...this.boardToScreen(o.w / 2, o.h), cursor: 'ns-resize' },
        { id: 'ne', ...this.boardToScreen(o.w, o.h), cursor: 'nesw-resize' },
      ];
      if (o.type === 'circle') return [{ id: 'd', ...this.boardToScreen(o.d, o.d / 2), cursor: 'ew-resize' }];
      if (o.type === 'polygon') return o.points.map(([x, y], i) => ({ id: `v${i}`, ...this.boardToScreen(x, y), cursor: 'move' }));
      return [];
    }

    animate(type, data) {
      if (this.app.reducedMotion) return;
      this.anims.push({ type, t0: performance.now(), ...data });
      this.requestDraw();
    }
    requestDraw() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
    }

    // ---------- 主绘制 ----------
    draw() {
      const ctx = this.ctx, app = this.app, p = app.p;
      if (!p) return;
      const now = performance.now();
      // 视角动画
      for (const a of this.anims) if (a.type === 'view') {
        const t = Math.min(1, (now - a.t0) / a.dur), e = easeOut(t);
        this.s = a.from.s + (a.to.s - a.from.s) * e; this.ox = a.from.ox + (a.to.ox - a.from.ox) * e; this.oy = a.from.oy + (a.to.oy - a.from.oy) * e;
        if (t >= 1) a.done = true;
      }
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);
      const mask = MASK[p.board.mask] || MASK.green;
      const outline = G.outlinePolygon(p.board.outline);
      const boardPath = () => {
        ctx.beginPath();
        outline.forEach((q, i) => { const s = this.boardToScreen(q.x, q.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
        ctx.closePath();
      };
      // 板子：投影、基材侧面、阻焊顶面
      const depth = Math.max(3, Math.min(8, p.board.thickness * this.s * 0.22));
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.28)'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 14;
      ctx.translate(0, depth); boardPath(); ctx.fillStyle = SUBSTRATE; ctx.fill();
      ctx.restore();
      ctx.save(); ctx.translate(0, depth * 0.5); boardPath(); ctx.fillStyle = '#c6b584'; ctx.fill(); ctx.restore();
      boardPath();
      const bb = this.bbox();
      const g0 = this.boardToScreen(bb.x0, bb.y1), g1 = this.boardToScreen(bb.x1, bb.y0);
      const grad = ctx.createLinearGradient(g0.x, g0.y, g1.x, g1.y);
      grad.addColorStop(0, mask.top2); grad.addColorStop(1, mask.top);
      ctx.fillStyle = grad; ctx.fill();

      ctx.save(); boardPath(); ctx.clip();
      if (app.layers.grid) this.drawGrid(mask, bb);
      if (app.layers.congestion && app.ev) this.drawHeat(app.ev.metrics.congestion.grid);
      this.drawZones(boardPath);
      ctx.restore();

      // 固定孔
      for (const h of p.board.holes) {
        const c = this.boardToScreen(h.x, h.y), r = (h.d / 2) * this.s;
        ctx.beginPath(); ctx.arc(c.x, c.y, r + 0.45 * this.s, 0, Math.PI * 2); ctx.fillStyle = COPPER; ctx.fill();
        ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fillStyle = app.theme === 'dark' ? '#121315' : '#3a3833'; ctx.fill();
      }
      // 编辑板框时标出孔号，提示可以拖动
      if (app.boardEditing) p.board.holes.forEach((h, i) => {
        const c = this.boardToScreen(h.x, h.y), r = (h.d / 2 + 0.45) * this.s + 3;
        ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = ACCENT.sel; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = app.theme === 'dark' ? '#e8e6e1' : '#1f1e1b';
        ctx.fillText(`孔${i + 1}`, c.x, c.y - r - 2);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      });
      this.drawRulers(bb);

      const side = this.viewSide();
      const drag = this.opts.noInsets ? null : app.drag;
      // 背面（或正面，翻板时）器件：半透明轮廓
      for (const x of p.parts) {
        if (!x.placed || (drag && drag.ref === x.ref)) continue;
        if (this.onSide(x.through ? 'both' : x.placed.side)) continue;
        this.drawAt(x, M.footprint(x), x.placed, false, { ghost: true });
      }
      if (app.layers.sats) for (const s of p.satellites) if (s.placed && s._active && !this.onSide(s.placed.side)) this.drawAt(s, M.satFootprint(s), s.placed, true, { ghost: true });
      // 外晕
      if (app.layers.halo && app.ev) {
        for (const hl of app.ev.halos) {
          const part = M.partByRef(p, hl.ref);
          if (!part.placed || !this.onSide(part.placed.side) || (drag && drag.ref === hl.ref)) continue;
          const r = this.screenRect(hl.rect);
          roundRectPath(ctx, r.x, r.y, r.w, r.h, Math.min(10, 0.8 * this.s));
          ctx.fillStyle = app.theme === 'dark' ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.06)'; ctx.fill();
          ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
        }
      }
      // 卫星
      if (app.layers.sats) {
        for (const s of p.satellites) {
          if (!s.placed || !s._active || !this.onSide(s.placed.side)) continue;
          if (drag && drag.kind === 'part' && drag.visible && s.parent[0] === drag.ref && !s.pinned) continue;
          let sc = 1, alpha = 1, off = null;
          const pop = this.anims.find((a) => a.type === 'pop' && a.ref === s.ref);
          if (pop) {
            const t = Math.max(0, Math.min(1, (now - pop.t0 - pop.delay) / pop.dur));
            if (pop.orbit) {
              // 从轨道飞落：先保持悬浮，再沿弧线落到贴放位置
              const e = easeOut(t);
              sc = 1.15 - 0.15 * easeOutBack(t);
              off = { x: (pop.from.x - s.placed.x) * (1 - e), y: (pop.from.y - s.placed.y) * (1 - e) + Math.sin(Math.PI * t) * 0.8 };
            } else {
              sc = 0.3 + 0.7 * easeOutBack(t); alpha = t > 0 ? 1 : 0;
              if (pop.from) off = { x: (pop.from.x - s.placed.x) * (1 - easeOut(t)), y: (pop.from.y - s.placed.y) * (1 - easeOut(t)) };
            }
            if (t >= 1) pop.done = true;
          }
          const res = app.ev && app.ev.satResults[s.ref];
          this.drawAt(s, M.satFootprint(s), s.placed, true, { scale: sc, alpha, off, bad: res && !res.ok, pinned: s.pinned, selected: app.sel && app.sel.ref === s.ref });
        }
      }
      // 主器件（低的先画）
      const parts = p.parts.filter((x) => x.placed && this.onSide(x.through ? 'both' : x.placed.side) && !(drag && drag.ref === x.ref)).sort((a, b) => a.z - b.z);
      const related = this.relatedMap();
      const critical = this.criticalRefs();
      for (const x of parts) {
        const drop = this.anims.find((a) => a.type === 'drop' && a.ref === x.ref);
        let lift = 0, sc = 1;
        if (drop) {
          const t = Math.min(1, (now - drop.t0) / 180);
          sc = 1 + 0.06 * (1 - easeOutBack(t)); lift = (1 - t) * 1;
          if (t >= 1) drop.done = true;
        }
        this.drawAt(x, M.footprint(x), x.placed, false, { lift, scale: sc, selected: app.sel && app.sel.ref === x.ref, related: related.get(x.ref), critical: critical.has(x.ref), locked: x.locked, issue: this.issueLevel(x.ref) });
      }
      // 朝向建议（幽灵朝向）
      if (app.suggestion && !drag) {
        const part = M.partByRef(p, app.suggestion.ref);
        if (part && part.placed) {
          const pl = { ...part.placed, rot: app.suggestion.rot };
          ctx.save(); ctx.globalAlpha = 0.35;
          this.drawAt(part, M.footprint(part, pl), pl, false, {});
          ctx.restore();
          const r = this.screenRect(M.footprint(part, pl));
          roundRectPath(ctx, r.x, r.y, r.w, r.h, 4); ctx.setLineDash([5, 4]); ctx.strokeStyle = ACCENT.sel; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
        }
      }
      // 拖动中的器件、落点轮廓、对齐参考线
      if (drag && drag.pl && drag.visible) this.drawDrag(drag, now);
      // 波纹
      for (const a of this.anims) if (a.type === 'ripple') {
        const t = Math.min(1, (now - a.t0) / 420);
        const c = this.boardToScreen(a.x, a.y);
        ctx.beginPath(); ctx.arc(c.x, c.y, (a.r * this.s) * (0.6 + t * 1.2), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - t)})`; ctx.lineWidth = 2; ctx.stroke();
        if (t >= 1) a.done = true;
      }
      for (const a of this.anims) if (a.type === 'flash') {
        const t = Math.min(1, (now - a.t0) / 650);
        for (const ref of a.refs) {
          const part = M.partByRef(p, ref);
          if (!part || !part.placed) continue;
          const r = this.screenRect(M.footprint(part));
          roundRectPath(ctx, r.x - 3, r.y - 3, r.w + 6, r.h + 6, 6);
          ctx.strokeStyle = `rgba(167,243,208,${0.9 * Math.sin(Math.PI * t)})`; ctx.lineWidth = 3; ctx.stroke();
        }
        if (t >= 1) a.done = true;
      }
      this.drawLabels(parts);
      if (app.boardEditing && !drag) this.drawHandles();

      this.anims = this.anims.filter((a) => !a.done);
      const blinking = critical.size > 0 && !app.reducedMotion;
      const orbiting = drag && drag.visible && drag.kind === 'part' && !app.reducedMotion && orbitSats(p, drag.ref).length;
      if (this.anims.length || blinking || orbiting || (drag && drag.status === 'bad')) this.requestDraw();
      if (!this.opts.noInsets) app.emit('drawn');
    }

    relatedMap() {
      const app = this.app;
      const ref = (app.drag && app.drag.kind === 'part' && app.drag.ref) || (app.sel && app.sel.type === 'part' && app.sel.ref);
      const out = new Map();
      if (!ref) return out;
      for (const [r, classes] of M.connectedParts(app.p, ref)) {
        const cls = ['rf', 'switch_node', 'high_speed', 'power', 'clock', 'analog', 'bus', 'misc'].find((c) => classes.has(c));
        out.set(r, M.NET_CLASSES[cls].color);
      }
      return out;
    }
    criticalRefs() {
      const s = new Set();
      const ev = this.app.ev;
      if (!ev) return s;
      for (const it of ev.metrics.critical.items) if (it.kind === 'net' && !it.ok) it.refs.forEach((r) => s.add(r));
      return s;
    }
    issueLevel(ref) {
      const f = this.app.focusIssue;
      if (!f || !f.refs.includes(ref)) return null;
      return f.severity === 'P0' || f.severity === 'P1' ? 'bad' : 'warn';
    }

    /** 在器件的世界位置画它：先投影，再按旋转/镜像画本体，最后画选中与提示轮廓。 */
    drawAt(item, rect, pl, isSat, o) {
      const ctx = this.ctx;
      o = o || {};
      const c = this.boardToScreen(pl.x + (o.off ? o.off.x : 0), pl.y + (o.off ? o.off.y : 0));
      const flipped = this.app.flipped;
      ctx.save();
      if (o.alpha !== undefined) ctx.globalAlpha *= o.alpha;
      if (!o.ghost) {
        const lift = o.lift || 0;
        ctx.shadowColor = `rgba(0,0,0,${0.35 - lift * 0.12})`;
        ctx.shadowBlur = isSat ? 2 : 4 + lift * 12;
        ctx.shadowOffsetY = isSat ? 1 : 2 + lift * 7;
      }
      ctx.translate(c.x, c.y - (o.lift || 0) * 4);
      const k = this.s * (o.scale || 1);
      ctx.scale(flipped ? -k : k, -k);
      ctx.rotate(((pl.rot || 0) * Math.PI) / 180);
      if (pl.side === 'bottom') ctx.scale(-1, 1);
      drawItem(ctx, item, isSat, o);
      ctx.restore();

      const r = this.screenRect(rect);
      const outline = (color, width, dash, pad) => {
        roundRectPath(ctx, r.x - pad, r.y - pad, r.w + 2 * pad, r.h + 2 * pad, Math.min(6, 2 + pad));
        ctx.setLineDash(dash || []); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.setLineDash([]);
      };
      if (o.related) outline(o.related, 2, null, 3);
      if (o.critical) {
        const a = this.app.reducedMotion ? 0.9 : 0.45 + 0.45 * Math.sin(performance.now() / 380);
        outline(`rgba(245,158,11,${a})`, 2, null, 4);
      }
      if (o.issue) outline(o.issue === 'bad' ? ACCENT.bad : ACCENT.warn, 2.5, null, 5);
      if (o.bad && isSat) outline(ACCENT.bad, 1.5, null, 1.5);
      if (o.pinned) outline('rgba(255,255,255,0.7)', 1, [2, 2], 1.5);
      if (o.selected) { outline(ACCENT.sel, 2.5, null, 3); outline('rgba(56,189,248,0.25)', 6, null, 5); }
      if (o.locked && !isSat) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '10px ui-sans-serif, system-ui';
        ctx.fillText('🔒', r.x + r.w - 6, r.y + 11);
      }
    }

    drawDrag(drag, now) {
      const ctx = this.ctx, app = this.app, p = app.p;
      const item = M.itemByRef(p, drag.ref);
      const isSat = drag.kind === 'sat';
      const fp = isSat ? M.satFootprint(item, drag.pl) : M.footprint(item, drag.pl);
      const r = this.screenRect(fp);
      const col = drag.status === 'bad' ? ACCENT.bad : drag.status === 'warn' ? ACCENT.warn : ACCENT.ok;
      const shake = drag.status === 'bad' && !app.reducedMotion ? Math.sin(now / 28) * 2 : 0;
      roundRectPath(ctx, r.x + shake, r.y, r.w, r.h, 4);
      ctx.fillStyle = col + '22'; ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      for (const gl of drag.guides || []) {
        ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(56,189,248,0.8)'; ctx.lineWidth = 1;
        ctx.beginPath();
        if (gl.axis === 'x') { const s = this.boardToScreen(gl.v, 0); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, this.H); }
        else { const s = this.boardToScreen(0, gl.v); ctx.moveTo(0, s.y); ctx.lineTo(this.W, s.y); }
        ctx.stroke(); ctx.setLineDash([]);
      }
      // 器件本体跟随指针，抬起并放大
      const raw = drag.raw || drag.pl;
      const pl = { ...drag.pl, x: raw.x, y: raw.y };
      if (!isSat) this.drawOrbit(item, pl, now, 'below');
      this.drawAt(item, isSat ? M.satFootprint(item, pl) : M.footprint(item, pl), pl, isSat, { lift: 1, scale: 1.04 });
      if (!isSat) {
        // 悬浮中的器件也显示位号
        const sr = this.screenRect(M.footprint(item, pl));
        const m = Math.min(sr.w, sr.h);
        if (m >= 14) {
          ctx.save();
          ctx.font = `600 ${Math.max(9, Math.min(13, m * 0.28))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const light = ['chip_antenna', 'module', 'coin', 'usb_c', 'pouch', 'fpc', 'mic'].includes(item.shape);
          ctx.fillStyle = light ? 'rgba(30,32,36,0.85)' : 'rgba(255,255,255,0.92)';
          ctx.fillText(item.ref, sr.x + sr.w / 2, sr.y + sr.h / 2 - 4);
          ctx.restore();
        }
        this.drawOrbit(item, pl, now, 'above');
      }
    }

    /**
     * 卫星环绕：被拾取器件的自动卫星沿两条倾斜的椭圆轨道绕行（近侧压在器件上方、远侧被器件挡住），
     * 位置记入 this.orbitPos，落地时卫星从这里飞向自动贴放的位置。
     */
    drawOrbit(part, pl, now, layer) {
      const sats = orbitSats(this.app.p, part.ref);
      if (!sats.length) return;
      const pos = orbitPositions(part, pl, sats, this.app.reducedMotion ? 0 : now);
      if (layer === 'below') this.orbitPos = {};
      const ctx = this.ctx;
      // 轨道线
      if (layer === 'below') {
        for (const ring of [0, 1]) {
          const o = pos.rings[ring];
          if (!o) continue;
          const c = this.boardToScreen(pl.x, pl.y);
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(c.x, c.y - 4, o.rx * this.s, o.ry * this.s, 0, 0, Math.PI * 2);
          ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1; ctx.stroke();
          ctx.restore();
        }
      }
      for (const q of pos.items) {
        if ((layer === 'above') !== q.front) continue;
        this.orbitPos[q.sat.ref] = { x: q.x, y: q.y };
        const spl = { x: q.x, y: q.y, rot: q.rot, side: pl.side };
        this.drawAt(q.sat, M.satFootprint(q.sat, { ...spl, rot: 0 }), spl, true, { lift: 0.8 + q.depth * 0.4, scale: 1.05 + q.depth * 0.12, alpha: q.front ? 1 : 0.75 });
      }
    }

    drawGrid(mask, bb) {
      const ctx = this.ctx;
      const step = this.s < 6 ? 5 : 1;
      for (let x = Math.ceil(bb.x0 / step) * step; x <= bb.x1; x += step) {
        const a = this.boardToScreen(x, bb.y0), b = this.boardToScreen(x, bb.y1);
        ctx.strokeStyle = x % 5 === 0 ? mask.grid5 : mask.grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(a.x) + 0.5, a.y); ctx.lineTo(Math.round(b.x) + 0.5, b.y); ctx.stroke();
      }
      for (let y = Math.ceil(bb.y0 / step) * step; y <= bb.y1; y += step) {
        const a = this.boardToScreen(bb.x0, y), b = this.boardToScreen(bb.x1, y);
        ctx.strokeStyle = y % 5 === 0 ? mask.grid5 : mask.grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.x, Math.round(a.y) + 0.5); ctx.lineTo(b.x, Math.round(b.y) + 0.5); ctx.stroke();
      }
    }
    drawHeat(grid) {
      const ctx = this.ctx;
      for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
        const v = grid.ratio[j * grid.nx + i];
        if (v < 0.08) continue;
        const r = this.screenRect({ x0: grid.x0 + i * grid.cell, y0: grid.y0 + j * grid.cell, x1: grid.x0 + (i + 1) * grid.cell, y1: grid.y0 + (j + 1) * grid.cell });
        const t = Math.min(1, v / 1.2);
        const hue = 130 - 130 * t;
        ctx.fillStyle = `hsla(${hue}, 85%, 52%, ${0.12 + 0.38 * Math.min(1, v)})`;
        ctx.fillRect(r.x, r.y, r.w + 0.5, r.h + 0.5);
      }
    }
    zoneVisible(z) {
      const app = this.app;
      const L = app.layers;
      const byLayer = { antenna_keepout: L.keepout, keepout: true, edge_band: L.edge, heat: L.heat, magnetic: L.magnetic }[z.type];
      if (byLayer) return 1;
      // 拖动或选中相关器件时自动淡入
      const ref = (app.drag && app.drag.ref) || (app.sel && app.sel.ref);
      if (!ref) return 0;
      const item = M.itemByRef(app.p, ref);
      if (!item) return 0;
      const role = item.role || (item.kind === 'crystal' ? 'crystal' : item.kind);
      if (z.ref === ref) return 0.8;
      if (z.related === 'all') return 0.8;
      if (Array.isArray(z.related) && z.related.includes(role)) return 0.8;
      if (z.type === 'edge_band' && app.focusIssue && app.focusIssue.zone === 'edge_band') return 0.8;
      return 0;
    }
    drawZones(boardPath) {
      const ctx = this.ctx, app = this.app;
      if (!app.ev) return;
      for (const z of app.ev.zones) {
        const vis = this.zoneVisible(z) || (app.focusIssue && app.focusIssue.zone === z.type && app.focusIssue.refs.includes(z.ref) ? 1 : 0);
        if (!vis) continue;
        ctx.save(); ctx.globalAlpha = vis;
        if (z.type === 'antenna_keepout' || z.type === 'keepout') {
          const r = this.screenRect(z.rect);
          const cyan = z.type === 'antenna_keepout';
          ctx.fillStyle = cyan ? 'rgba(34,211,238,0.16)' : 'rgba(148,163,184,0.18)';
          ctx.fillRect(r.x, r.y, r.w, r.h);
          if (!cyan) {
            ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
            ctx.strokeStyle = 'rgba(203,213,225,0.35)'; ctx.lineWidth = 1;
            for (let d = -r.h; d < r.w; d += 8) { ctx.beginPath(); ctx.moveTo(r.x + d, r.y + r.h); ctx.lineTo(r.x + d + r.h, r.y); ctx.stroke(); }
            ctx.restore();
          }
          ctx.setLineDash([6, 4]); ctx.strokeStyle = cyan ? 'rgba(34,211,238,0.85)' : 'rgba(203,213,225,0.7)'; ctx.lineWidth = 1.5;
          ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1); ctx.setLineDash([]);
          if (r.w > 50 && r.h > 18) {
            ctx.fillStyle = cyan ? 'rgba(165,243,252,0.95)' : 'rgba(226,232,240,0.9)';
            ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
            ctx.fillText(cyan ? LP.t('ui.zone_antenna') : z.reason, r.x + 6, r.y + 14);
          }
        } else if (z.type === 'edge_band') {
          ctx.save(); boardPath(); ctx.lineWidth = 2 * z.width * this.s; ctx.strokeStyle = 'rgba(245,158,11,0.16)'; ctx.stroke(); ctx.restore();
        } else if (z.type === 'heat' || z.type === 'magnetic') {
          const c = this.boardToScreen(z.cx, z.cy), r = z.r * this.s;
          const col = z.type === 'heat' ? '249,115,22' : '168,85,247';
          const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
          g.addColorStop(0, `rgba(${col},0.28)`); g.addColorStop(1, `rgba(${col},0.04)`);
          ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
          ctx.setLineDash([5, 5]); ctx.strokeStyle = `rgba(${col},0.7)`; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.restore();
      }
    }
    drawRulers(bb) {
      const ctx = this.ctx;
      const dark = this.app.theme === 'dark';
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.lineWidth = 1;
      const gap = 14;
      const y0 = this.boardToScreen(0, bb.y0).y + gap + 6;
      const step = this.s < 6 ? 5 : 1;
      for (let x = Math.ceil(bb.x0); x <= bb.x1 + 1e-6; x += step) {
        const s = this.boardToScreen(x, bb.y0);
        const big = x % 5 === 0;
        ctx.beginPath(); ctx.moveTo(Math.round(s.x) + 0.5, y0); ctx.lineTo(Math.round(s.x) + 0.5, y0 + (big ? 7 : 3)); ctx.stroke();
        if (big) { ctx.textAlign = 'center'; ctx.fillText(String(x), s.x, y0 + 18); }
      }
      const xl = Math.min(this.boardToScreen(bb.x0, 0).x, this.boardToScreen(bb.x1, 0).x) - gap - 6;
      for (let y = Math.ceil(bb.y0); y <= bb.y1 + 1e-6; y += step) {
        const s = this.boardToScreen(bb.x0, y);
        const big = y % 5 === 0;
        ctx.beginPath(); ctx.moveTo(xl, Math.round(s.y) + 0.5); ctx.lineTo(xl - (big ? 7 : 3), Math.round(s.y) + 0.5); ctx.stroke();
        if (big) { ctx.textAlign = 'right'; ctx.fillText(String(y), xl - 10, s.y + 3); }
      }
      ctx.textAlign = 'right';
      ctx.fillText('mm', xl - 10, y0 + 18);
      ctx.textAlign = 'left';
    }
    drawLabels(parts) {
      const ctx = this.ctx, app = this.app;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const x of parts) {
        const r = this.screenRect(M.footprint(x));
        const m = Math.min(r.w, r.h);
        if (m < 14) continue;
        const fs = Math.max(9, Math.min(13, m * 0.28));
        ctx.font = `600 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        const light = ['chip_antenna', 'module', 'coin', 'usb_c', 'pouch', 'fpc', 'mic'].includes(x.shape);
        ctx.fillStyle = light ? 'rgba(30,32,36,0.85)' : 'rgba(255,255,255,0.92)';
        const cy = x.shape === 'button' ? r.y + r.h - fs * 0.7 : r.y + r.h / 2;
        ctx.fillText(x.ref, r.x + r.w / 2, cy);
      }
      if (app.layers.sats && this.s > 26) {
        ctx.font = `500 ${Math.min(10, this.s * 0.28)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        for (const s of app.p.satellites) {
          if (!s.placed || !s._active || !this.onSide(s.placed.side)) continue;
          const r = this.screenRect(M.satFootprint(s));
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillText(s.ref, r.x + r.w / 2, r.y - 6);
        }
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    drawHandles() {
      const ctx = this.ctx;
      for (const h of this.boardHandles()) {
        ctx.beginPath(); ctx.arc(h.x, h.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = ACCENT.sel; ctx.lineWidth = 2; ctx.stroke();
      }
    }
  }

  /** 跟随被拾取器件一起悬浮的卫星：该器件的全部未固定卫星（未摆放的器件也有）。 */
  function orbitSats(p, ref) { return p.satellites.filter((s) => s.parent[0] === ref && !s.pinned); }
  /**
   * 轨道位置（毫米，板面坐标）。两条轨道：内圈放小件，外圈放晶体、电感等较大的卫星；
   * 椭圆略扁，模拟俯视下倾斜的轨道；depth ∈ [-1, 1] 表示在轨道近侧(+)还是远侧(−)。
   */
  function orbitPositions(part, pl, sats, now) {
    const [w, h] = M.dims(part.w, part.h, pl.rot || 0);
    const base = Math.max(w, h) / 2;
    const big = (s) => Math.max(s.w, s.h) >= 1.6;
    const ringOf = sats.map((s) => (sats.length > 4 && big(s) ? 1 : 0));
    const counts = [ringOf.filter((r) => r === 0).length, ringOf.filter((r) => r === 1).length];
    const rings = [0, 1].map((k) => (counts[k] ? { rx: base + 1.4 + k * 1.8, ry: (base + 1.4 + k * 1.8) * 0.78 } : null));
    const idx = [0, 0];
    const t = now / 1000;
    const items = sats.map((s, i) => {
      const k = ringOf[i];
      const j = idx[k]++;
      const speed = k === 0 ? 1.15 : -0.8;
      const ang = (j / counts[k]) * Math.PI * 2 + t * speed + k * 0.6;
      const o = rings[k];
      const depth = -Math.sin(ang);   // 屏幕下方为近侧
      return { sat: s, x: pl.x + o.rx * Math.cos(ang), y: pl.y + o.ry * Math.sin(ang), rot: ((ang * 180) / Math.PI + 90) % 360, depth, front: depth > -0.15, ang, ring: k };
    });
    return { items, rings };
  }

  /** 托盘缩略图：把器件画进一个小画布。 */
  function drawThumb(canvas, item) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 64, H = canvas.clientHeight || 44;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const s = Math.min((W - 10) / item.w, (H - 10) / item.h, 9);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
    ctx.translate(W / 2, H / 2); ctx.scale(s, -s);
    drawItem(ctx, item, false, {});
    ctx.restore();
  }

  LP.Renderer2D = Renderer2D;
  LP.render2d = { drawItem, drawThumb, roundRectPath, MASK, ACCENT, orbitSats, orbitPositions };
})(globalThis.LP = globalThis.LP || {});
