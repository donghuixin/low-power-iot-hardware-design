// 板图渲染：三层画布（底图 / 粒子 / 标注），视图变换，色带，热力底图，等值线。
(function (LP) {
  'use strict';
  const G = LP.geometry;

  const PAL = {
    fire: [[0, 12, 8, 30], [0.2, 70, 18, 100], [0.45, 170, 45, 90], [0.7, 240, 120, 30], [0.88, 252, 200, 70], [1, 255, 250, 200]],
    ice: [[0, 6, 14, 40], [0.35, 18, 70, 150], [0.7, 40, 180, 230], [1, 225, 252, 255]],
    plasma: [[0, 13, 8, 135], [0.3, 126, 3, 168], [0.55, 204, 71, 120], [0.8, 248, 149, 64], [1, 240, 249, 33]],
    heat: [[0, 20, 24, 80], [0.25, 40, 110, 190], [0.5, 60, 190, 160], [0.7, 240, 200, 60], [0.85, 245, 120, 40], [1, 255, 240, 220]],
    div: [[0, 60, 120, 255], [0.5, 18, 20, 26], [1, 255, 80, 60]],
  };
  function palette(name, t) {
    const st = PAL[name] || PAL.fire;
    t = Math.max(0, Math.min(1, t));
    for (let k = 1; k < st.length; k++) {
      if (t <= st[k][0]) {
        const a = st[k - 1], b = st[k], u = (t - a[0]) / (b[0] - a[0] || 1);
        return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
      }
    }
    const l = st[st.length - 1];
    return [l[1], l[2], l[3]];
  }
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  class Viewer {
    constructor(host) {
      this.host = host;
      this.base = mk(host, 'cv-base');
      this.fx = mk(host, 'cv-fx');
      this.top = mk(host, 'cv-top');
      this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
      this.view = { s: 10, ox: 0, oy: 0 };
      this.board = null; this.items = []; this.heat = null; this.overlay = null; this.highlight = new Set();
      this.copperImg = null; this.side = 'top';
      this.onView = null;
      new ResizeObserver(() => this.resize()).observe(host);
      this.bindPanZoom();
    }
    resize() {
      const r = this.host.getBoundingClientRect();
      this.W = Math.max(50, r.width); this.H = Math.max(50, r.height);
      for (const c of [this.base, this.fx, this.top]) { c.width = Math.round(this.W * this.dpr); c.height = Math.round(this.H * this.dpr); c.style.width = this.W + 'px'; c.style.height = this.H + 'px'; }
      if (this.board && !this.userView) this.fit();
      this.redraw();
      if (this.onView) this.onView();
    }
    setBoard(summary) {
      this.board = summary.board; this.items = summary.items; this.antRects = summary.antRects || [];
      this.poly = G.outlinePolygon(this.board.outline);
      this.userView = false;
      this.fit(); this.redraw();
    }
    fit() {
      const b = this.board, pad = 28;
      const s = Math.max(0.5, Math.min((this.W - 2 * pad) / b.w, (this.H - 2 * pad) / b.h));
      this.view = { s, ox: (this.W - b.w * s) / 2 - b.x0 * s, oy: (this.H + b.h * s) / 2 + b.y0 * s };
    }
    // 板坐标（mm，y 向上）↔ 屏幕坐标（CSS 像素）
    sx(x) { return this.view.ox + x * this.view.s; }
    sy(y) { return this.view.oy - y * this.view.s; }
    bx(px) { return (px - this.view.ox) / this.view.s; }
    by(py) { return (this.view.oy - py) / this.view.s; }
    ctx(c) { const x = c.getContext('2d'); x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); return x; }
    bindPanZoom() {
      let drag = null;
      this.top.addEventListener('wheel', (e) => {
        e.preventDefault();
        const k = Math.exp(-e.deltaY * 0.0015), r = this.top.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
        const x = this.bx(px), y = this.by(py);
        this.view.s = Math.max(2, Math.min(400, this.view.s * k));
        this.view.ox = px - x * this.view.s; this.view.oy = py + y * this.view.s;
        this.userView = true; this.redraw(); if (this.onView) this.onView();
      }, { passive: false });
      this.top.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        const r = this.top.getBoundingClientRect();
        if (this.onDragStart && this.onDragStart(e.clientX - r.left, e.clientY - r.top)) { drag = { custom: true }; this.top.setPointerCapture(e.pointerId); return; }
        drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: false }; this.top.setPointerCapture(e.pointerId);
      });
      this.top.addEventListener('pointermove', (e) => {
        if (drag && drag.custom) { const r = this.top.getBoundingClientRect(); this.onDragMove(e.clientX - r.left, e.clientY - r.top); return; }
        if (drag) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
          if (drag.moved) { this.view.ox = drag.ox + dx; this.view.oy = drag.oy + dy; this.userView = true; this.redraw(); if (this.onView) this.onView(); }
        }
        if (this.onHover) { const r = this.top.getBoundingClientRect(); this.onHover(this.bx(e.clientX - r.left), this.by(e.clientY - r.top), e.clientX - r.left, e.clientY - r.top); }
      });
      this.top.addEventListener('pointerup', (e) => {
        const d = drag; drag = null;
        if (d && d.custom) { if (this.onDragEnd) this.onDragEnd(); return; }
        if (d && !d.moved && this.onClick) { const r = this.top.getBoundingClientRect(); this.onClick(this.bx(e.clientX - r.left), this.by(e.clientY - r.top)); }
      });
      this.top.addEventListener('pointerleave', () => { if (this.onHover) this.onHover(null); });
      this.top.addEventListener('dblclick', () => { this.userView = false; this.fit(); this.redraw(); if (this.onView) this.onView(); });
    }
    boardPath(c) {
      c.beginPath();
      this.poly.forEach((q, k) => (k ? c.lineTo(this.sx(q.x), this.sy(q.y)) : c.moveTo(this.sx(q.x), this.sy(q.y))));
      c.closePath();
    }
    /**
     * 热力底图。h: {field, grid:{nx,ny,cell,x0,y0}, pal, min, max, log, alpha, map(值→0..1，可选)}
     */
    setHeat(h) { this.setHeats(h ? [h] : []); }
    /** 多张底图叠加。每张可带 clip: [左, 右]（画布宽度的比例），用于左右对比。 */
    setHeats(list) { this.heats = list.map((h) => ({ h, img: rasterize(h) })); this.redraw(); }
    updateHeat(k, h) { const e = this.heats && this.heats[k]; if (!e) return; e.h = h; e.img = rasterize(h, e.img); this.drawBase(); }
    setCopper(img) { this.copperImg = img; this.redraw(); }
    redraw() { if (!this.board) return; this.drawBase(); this.drawTop(); }
    drawBase() {
      const c = this.ctx(this.base);
      c.clearRect(0, 0, this.W, this.H);
      if (!this.board) return;
      c.save();
      this.boardPath(c);
      c.fillStyle = '#101218'; c.fill();
      c.clip();
      if (this.copperImg) this.blit(c, this.copperImg, 0.55);
      for (const e of this.heats || []) {
        c.save();
        if (e.h.clip) { c.beginPath(); c.rect(e.h.clip[0] * this.W, 0, (e.h.clip[1] - e.h.clip[0]) * this.W, this.H); c.clip(); }
        if (e.h.blend) c.globalCompositeOperation = e.h.blend;
        this.blit(c, e.img, e.h.alpha ?? 0.9);
        c.restore();
      }
      c.restore();
      // 天线净空区
      c.save();
      c.setLineDash([4, 3]); c.strokeStyle = 'rgba(120,200,255,0.35)'; c.lineWidth = 1;
      for (const a of this.antRects) { const r = a.rect; c.strokeRect(this.sx(r.x0), this.sy(r.y1), (r.x1 - r.x0) * this.view.s, (r.y1 - r.y0) * this.view.s); }
      c.restore();
      this.boardPath(c);
      c.strokeStyle = '#4a5160'; c.lineWidth = 1.5; c.stroke();
      c.fillStyle = '#000';
      for (const h of this.board.holes || []) { c.beginPath(); c.arc(this.sx(h.x), this.sy(h.y), (h.d / 2) * this.view.s, 0, Math.PI * 2); c.fill(); c.strokeStyle = '#6b6450'; c.lineWidth = Math.max(1, 0.4 * this.view.s); c.stroke(); }
    }
    blit(c, img, alpha) {
      const g = img.grid;
      c.save();
      c.globalAlpha = alpha;
      c.imageSmoothingEnabled = true;
      c.drawImage(img.canvas, this.sx(g.x0), this.sy(g.y0 + g.ny * g.cell), g.nx * g.cell * this.view.s, g.ny * g.cell * this.view.s);
      c.restore();
    }
    /** 标注层：器件外形、选中高亮、折线、标记、结论位置、等值线、对比分割线。 */
    setOverlay(o) { this.overlay = o; this.drawTop(); }
    drawTop(extra) {
      const c = this.ctx(this.top);
      c.clearRect(0, 0, this.W, this.H);
      if (!this.board) return;
      const o = this.overlay || {}, s = this.view.s;
      // 器件
      for (const it of this.items) {
        const r = it.rect, hl = this.highlight.has(it.ref), dim = this.highlight.size && !hl;
        const x = this.sx(r.x0), y = this.sy(r.y1), w = (r.x1 - r.x0) * s, h = (r.y1 - r.y0) * s;
        c.save();
        if (it.side === 'bottom') c.setLineDash([3, 3]);
        c.lineWidth = hl ? 1.8 : 1;
        c.strokeStyle = hl ? '#ffd166' : dim ? 'rgba(160,168,184,0.25)' : 'rgba(170,178,194,0.6)';
        c.fillStyle = hl ? 'rgba(255,209,102,0.08)' : 'rgba(20,22,28,0.25)';
        c.fillRect(x, y, w, h); c.strokeRect(x, y, w, h);
        c.restore();
        if (it.kind === 'part' && w > 18 && h > 10) {
          c.font = `${hl ? 600 : 500} ${Math.max(9, Math.min(13, h * 0.35))}px system-ui, sans-serif`;
          c.fillStyle = hl ? '#ffe3a1' : dim ? 'rgba(200,205,215,0.35)' : 'rgba(210,215,225,0.8)';
          c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(it.ref, x + w / 2, y + h / 2);
        }
      }
      // 等值线
      if (o.contours) {
        c.save(); c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,0.35)';
        for (const seg of o.contours) { c.beginPath(); c.moveTo(this.sx(seg[0]), this.sy(seg[1])); c.lineTo(this.sx(seg[2]), this.sy(seg[3])); c.stroke(); }
        c.restore();
      }
      if (o.nodal) {
        c.save(); c.lineWidth = 1.6; c.strokeStyle = 'rgba(255,255,255,0.85)';
        for (const seg of o.nodal) { c.beginPath(); c.moveTo(this.sx(seg[0]), this.sy(seg[1])); c.lineTo(this.sx(seg[2]), this.sy(seg[3])); c.stroke(); }
        c.restore();
      }
      // 折线（代表路径）
      for (const pl of o.lines || []) {
        if (!pl.pts || pl.pts.length < 2) continue;
        c.save(); c.setLineDash(pl.dash || [5, 4]); c.lineWidth = pl.w || 1.2; c.strokeStyle = pl.color || 'rgba(255,255,255,0.5)';
        c.beginPath(); pl.pts.forEach((q, k) => (k ? c.lineTo(this.sx(q[0]), this.sy(q[1])) : c.moveTo(this.sx(q[0]), this.sy(q[1])))); c.stroke(); c.restore();
      }
      // 标记
      for (const m of o.marks || []) {
        const x = this.sx(m.x), y = this.sy(m.y);
        c.save();
        c.beginPath(); c.arc(x, y, m.r || 5, 0, Math.PI * 2);
        c.fillStyle = m.fill || 'rgba(0,0,0,0.6)'; c.fill();
        c.lineWidth = 2; c.strokeStyle = m.color || '#fff'; c.stroke();
        if (m.label) { c.font = '600 11px system-ui, sans-serif'; c.fillStyle = m.color || '#fff'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(m.label, x + (m.r || 5) + 4, y); }
        c.restore();
      }
      // 结论位置
      (o.findings || []).forEach((f, k) => {
        if (!f.where) return;
        const x = this.sx(f.where.x), y = this.sy(f.where.y), col = f.sev === 'P0' ? '#ff4d4f' : f.sev === 'P1' ? '#ff9f43' : '#ffd166';
        c.save();
        c.beginPath(); c.arc(x, y, f.focus ? 14 : 9, 0, Math.PI * 2);
        c.strokeStyle = col; c.lineWidth = f.focus ? 3 : 2; c.stroke();
        c.fillStyle = col; c.font = '700 10px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(k + 1), x, y);
        c.restore();
      });
      // 大字标注
      if (o.callout) {
        const q = o.callout, x = this.sx(q.x), y = this.sy(q.y), tx = Math.min(this.W - 220, x + 60), ty = Math.max(40, y - 60);
        c.save();
        c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 1;
        c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.moveTo(x, y); c.lineTo(tx, ty); c.lineTo(tx + 190, ty); c.stroke();
        c.fillStyle = '#fff'; c.font = '300 26px system-ui, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'bottom';
        c.fillText(q.big, tx, ty - 4);
        c.font = '400 13px system-ui, sans-serif'; c.fillStyle = 'rgba(255,255,255,0.8)'; c.textBaseline = 'top';
        c.fillText(q.small || '', tx, ty + 6);
        c.restore();
      }
      if (o.split != null) {
        const x = o.split * this.W;
        c.save(); c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 2; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, this.H); c.stroke();
        c.fillStyle = 'rgba(255,255,255,0.9)'; c.beginPath(); c.arc(x, this.H / 2, 9, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#111'; c.font = '700 11px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('⇆', x, this.H / 2);
        c.font = '600 12px system-ui, sans-serif'; c.fillStyle = 'rgba(255,255,255,0.85)'; c.textBaseline = 'top';
        c.textAlign = 'right'; c.fillText(o.splitLabels ? o.splitLabels[0] : '', x - 12, 10);
        c.textAlign = 'left'; c.fillText(o.splitLabels ? o.splitLabels[1] : '', x + 12, 10);
        c.restore();
      }
      if (extra) extra(c);
    }
  }
  function mk(host, cls) { const c = document.createElement('canvas'); c.className = cls; host.appendChild(c); return c; }

  /** 把网格场画进一张 nx×ny 的离屏画布。 */
  function rasterize(h, prev) {
    const g = h.grid, { nx, ny } = g;
    const cv = prev && prev.canvas.width === nx && prev.canvas.height === ny ? prev.canvas : Object.assign(document.createElement('canvas'), { width: nx, height: ny });
    const c = cv.getContext('2d'), img = c.createImageData(nx, ny), d = img.data;
    const lo = h.min, hi = h.max, lg = !!h.log;
    const L0 = lg ? Math.log10(Math.max(lo, 1e-12)) : lo, L1 = lg ? Math.log10(Math.max(hi, 1e-12)) : hi;
    const scale = h.scale ?? 1;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = h.field[j * nx + i] * scale, o = ((ny - 1 - j) * nx + i) * 4;
      if (!Number.isFinite(v) || (h.zeroClear && v === 0) || (lg && !(v > 0))) { d[o + 3] = 0; continue; }
      let t = lg ? (Math.log10(Math.max(v, 1e-12)) - L0) / (L1 - L0 || 1) : (v - L0) / (L1 - L0 || 1);
      if (h.floor != null && t < h.floor) { d[o + 3] = 0; continue; }
      const col = palette(h.pal, t);
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2];
      d[o + 3] = h.fade ? Math.round(255 * Math.min(1, Math.max(0, t) * 1.6 + 0.15)) : 255;
    }
    c.putImageData(img, 0, 0);
    return { canvas: cv, grid: g };
  }

  /** 行进方块法：返回 level 处的等值线段 [x1,y1,x2,y2]（mm）。 */
  function contour(field, g, level) {
    const segs = [], { nx, ny, cell, x0, y0 } = g;
    const X = (i) => x0 + (i + 0.5) * cell, Y = (j) => y0 + (j + 0.5) * cell;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = field[j * nx + i], b = field[j * nx + i + 1], cc = field[(j + 1) * nx + i + 1], d = field[(j + 1) * nx + i];
      if (![a, b, cc, d].every(Number.isFinite)) continue;
      const pts = [];
      const edge = (va, vb, xa, ya, xb, yb) => { if ((va - level) * (vb - level) < 0) { const t = (level - va) / (vb - va); pts.push([xa + (xb - xa) * t, ya + (yb - ya) * t]); } };
      edge(a, b, X(i), Y(j), X(i + 1), Y(j));
      edge(b, cc, X(i + 1), Y(j), X(i + 1), Y(j + 1));
      edge(cc, d, X(i + 1), Y(j + 1), X(i), Y(j + 1));
      edge(d, a, X(i), Y(j + 1), X(i), Y(j));
      if (pts.length >= 2) segs.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
      if (pts.length === 4) segs.push([pts[2][0], pts[2][1], pts[3][0], pts[3][1]]);
    }
    return segs;
  }

  /** 色标：画进一个 canvas 元素。 */
  function legend(canvas, pal, w = 160, h = 8) {
    canvas.width = w; canvas.height = h;
    const c = canvas.getContext('2d');
    for (let x = 0; x < w; x++) { c.fillStyle = rgb(palette(pal, x / (w - 1))); c.fillRect(x, 0, 1, h); }
  }

  LP.render = { Viewer, palette, rgb, rasterize, contour, legend, PAL };
})(globalThis.LP = globalThis.LP || {});
