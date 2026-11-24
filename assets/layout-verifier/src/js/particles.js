// 流动的光粒子：沿矢量场前进，出生位置按强度加权，速度与亮度随强度变化，叠加混合让密的地方更亮。
// 一个渲染器服务三类验证；性能不足时自动降级：减粒子 → 去拖尾 → 静态流线。
(function (LP) {
  'use strict';
  const PR = LP.render;

  class Particles {
    constructor(viewer) {
      this.v = viewer; this.cv = viewer.fx;
      this.systems = []; this.running = false; this.level = 0; this.raf = 0; this.frames = []; this.enabled = true;
      this.budget = 2500;
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); else if (this.running) this.loop(); });
    }
    /**
     * specs: [{fx, fy, mag, grid, pal, share(0..1), jitter(Float32|null，mm), spawn(Float32|null), lo, hi, speed(倍率), alpha}]
     */
    set(specs) {
      this.systems = specs.filter(Boolean).map((s) => this.build(s));
      this.reset();
    }
    build(s) {
      const g = s.grid, N = g.nx * g.ny;
      let hi = s.hi, lo = s.lo;
      if (hi == null) { hi = 0; for (let c = 0; c < N; c++) if (s.mag[c] > hi) hi = s.mag[c]; }
      if (lo == null) lo = hi * 1e-3;
      const w = new Float64Array(N);
      let tot = 0;
      for (let c = 0; c < N; c++) {
        const m = s.spawn ? s.spawn[c] : s.mag[c];
        const v = m > (s.spawn ? 0 : lo) ? Math.pow(m, 0.6) : 0;
        tot += v; w[c] = tot;
      }
      return { ...s, hi, lo, cdf: w, tot, L0: Math.log10(Math.max(lo, 1e-12)), L1: Math.log10(Math.max(hi, 1e-12)) };
    }
    reset() {
      const n = this.level >= 1 ? this.budget >> this.level : this.budget;
      for (const s of this.systems) {
        s.n = Math.max(40, Math.round(n * (s.share ?? 1 / this.systems.length)));
        s.p = new Float32Array(s.n * 4);
        for (let k = 0; k < s.n; k++) this.spawn(s, k, true);
      }
      this.clear();
      this.static = false;
      if (!this.enabled || this.level >= 3) this.drawStatic();
    }
    clear() { const c = this.cv.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.cv.width, this.cv.height); }
    spawn(s, k, initial) {
      if (!(s.tot > 0)) { s.p[4 * k + 3] = -1; return; }
      const r = Math.random() * s.tot;
      let lo = 0, hi = s.cdf.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (s.cdf[m] < r) lo = m + 1; else hi = m; }
      const g = s.grid, i = lo % g.nx, j = (lo / g.nx) | 0;
      s.p[4 * k] = g.x0 + (i + Math.random()) * g.cell;
      s.p[4 * k + 1] = g.y0 + (j + Math.random()) * g.cell;
      s.p[4 * k + 2] = initial ? Math.random() * 60 : 0;
      s.p[4 * k + 3] = 40 + Math.random() * 60;
    }
    sample(s, x, y) {
      const g = s.grid, i = Math.floor((x - g.x0) / g.cell), j = Math.floor((y - g.y0) / g.cell);
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return -1;
      return j * g.nx + i;
    }
    start() { this.running = true; if (this.enabled && this.level < 3) this.loop(); }
    pause() { cancelAnimationFrame(this.raf); this.raf = 0; }
    stop() { this.running = false; this.pause(); this.clear(); }
    setEnabled(on) {
      this.enabled = on;
      this.pause();
      this.reset();
      if (on && this.running && this.level < 3) this.loop();
    }
    loop() {
      this.pause();
      let last = performance.now();
      const tick = (t) => {
        const dt = Math.min(0.05, (t - last) / 1000); last = t;
        const t0 = performance.now();
        this.step(dt);
        this.watch(performance.now() - t0, t);
        if (this.running && this.enabled && this.level < 3) this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
    /** 自适应降级：连续 30 帧平均绘制时间超过 12 ms 就降一级（留出浏览器自身的开销）。 */
    watch(ms, t) {
      this.frames.push(ms);
      if (this.frames.length < 30) return;
      const avg = this.frames.reduce((a, b) => a + b, 0) / this.frames.length;
      this.frames = [];
      this.lastAvg = avg;
      if (avg > 12 && this.level < 3) { this.level++; this.reset(); if (this.onDegrade) this.onDegrade(this.level); }
    }
    step(dt) {
      const v = this.v, c = this.cv.getContext('2d'), dpr = v.dpr;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.level < 2) {
        c.globalCompositeOperation = 'destination-out';
        c.fillStyle = 'rgba(0,0,0,0.12)';
        c.fillRect(0, 0, v.W, v.H);
      } else c.clearRect(0, 0, v.W, v.H);
      c.globalCompositeOperation = 'lighter';
      const size = Math.max(v.board.w, v.board.h);
      const BUCKETS = 8;
      for (const s of this.systems) {
        const paths = Array.from({ length: BUCKETS }, () => []);
        const sp = (s.speed ?? 1) * size / 2.5;
        for (let k = 0; k < s.n; k++) {
          const o = 4 * k;
          if (s.p[o + 3] < 0) continue;
          let x = s.p[o], y = s.p[o + 1];
          const cidx = this.sample(s, x, y);
          const m = cidx >= 0 ? s.mag[cidx] : 0;
          s.p[o + 2] += 1;
          if (!(m > s.lo) || s.p[o + 2] > s.p[o + 3]) { this.spawn(s, k, false); continue; }
          const tn = Math.max(0, Math.min(1, (Math.log10(m) - s.L0) / (s.L1 - s.L0 || 1)));
          const ux = s.fx[cidx] / m, uy = s.fy[cidx] / m;
          const step = sp * (0.25 + 0.75 * tn) * dt;
          let nx = x + ux * step, ny = y + uy * step;
          if (s.jitter && s.jitter[cidx] > 0) { const jv = (Math.random() - 0.5) * s.jitter[cidx] * 0.6; nx += -uy * jv; ny += ux * jv; }
          s.p[o] = nx; s.p[o + 1] = ny;
          const b = Math.min(BUCKETS - 1, Math.floor(tn * BUCKETS));
          paths[b].push(v.sx(x), v.sy(y), v.sx(nx), v.sy(ny));
        }
        for (let b = 0; b < BUCKETS; b++) {
          const arr = paths[b];
          if (!arr.length) continue;
          const t = (b + 0.5) / BUCKETS, col = PR.palette(s.pal, 0.35 + 0.65 * t);
          c.strokeStyle = PR.rgb(col, (s.alpha ?? 0.8) * (0.35 + 0.65 * t));
          c.lineWidth = 0.8 + 1.4 * t;
          c.lineCap = 'round';
          c.beginPath();
          for (let q = 0; q < arr.length; q += 4) { c.moveTo(arr[q], arr[q + 1]); c.lineTo(arr[q + 2], arr[q + 3]); }
          c.stroke();
          if (this.level < 1 && t > 0.6) {          // 头部亮点
            c.fillStyle = PR.rgb([255, 250, 230], 0.5 * t);
            for (let q = 0; q < arr.length; q += 4) c.fillRect(arr[q + 2] - 0.8, arr[q + 3] - 0.8, 1.6, 1.6);
          }
        }
      }
      c.globalCompositeOperation = 'source-over';
    }
    /** 静态流线：线的粗细与亮度随强度变化，带箭头。用于关闭动效或性能不足时。 */
    drawStatic() {
      this.pause();
      this.static = true;
      const v = this.v, c = this.cv.getContext('2d');
      c.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      c.clearRect(0, 0, v.W, v.H);
      c.globalCompositeOperation = 'lighter';
      for (const s of this.systems) {
        const seeds = Math.round(160 * (s.share ?? 1 / this.systems.length));
        const h = s.grid.cell * 0.8;
        for (let k = 0; k < seeds; k++) {
          this.spawn(s, 0, true);
          let x = s.p[0], y = s.p[1];
          const pts = [[x, y]];
          for (let it = 0; it < 220; it++) {
            const ci = this.sample(s, x, y), m = ci >= 0 ? s.mag[ci] : 0;
            if (!(m > s.lo)) break;
            x += (s.fx[ci] / m) * h; y += (s.fy[ci] / m) * h;
            pts.push([x, y]);
          }
          if (pts.length < 4) continue;
          const ci = this.sample(s, pts[0][0], pts[0][1]);
          const tn = ci >= 0 ? Math.max(0, Math.min(1, (Math.log10(Math.max(s.mag[ci], 1e-12)) - s.L0) / (s.L1 - s.L0 || 1))) : 0.3;
          c.strokeStyle = PR.rgb(PR.palette(s.pal, 0.35 + 0.65 * tn), 0.25 + 0.6 * tn);
          c.lineWidth = 0.6 + 2 * tn;
          c.beginPath(); pts.forEach((q, i) => (i ? c.lineTo(v.sx(q[0]), v.sy(q[1])) : c.moveTo(v.sx(q[0]), v.sy(q[1])))); c.stroke();
          const m = Math.floor(pts.length / 2), a = pts[m - 1], b = pts[m];
          const ang = Math.atan2(-(b[1] - a[1]), b[0] - a[0]), X = v.sx(b[0]), Y = v.sy(b[1]), L = 5 + 3 * tn;
          c.beginPath(); c.moveTo(X, Y); c.lineTo(X - L * Math.cos(ang - 0.5), Y - L * Math.sin(ang - 0.5)); c.moveTo(X, Y); c.lineTo(X - L * Math.cos(ang + 0.5), Y - L * Math.sin(ang + 0.5)); c.stroke();
        }
      }
      c.globalCompositeOperation = 'source-over';
    }
  }
  LP.Particles = Particles;
})(globalThis.LP = globalThis.LP || {});
