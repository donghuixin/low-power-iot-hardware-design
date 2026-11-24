/*
 * view3d.js — 验证结果的 3D 展示（可选）。Three.js 以文本形式内联在页面中，第一次切到 3D 时才解析执行。
 * 只负责显示：所有计算结果与 2D 视图共用，坐标映射同布局规划器：板面 (x, y) → 场景 (X = x − cx, Z = −(y − cy))，Y 向上。
 *   电流：板子上层是去程，下方分开画出地平面上的回流，两层都有流动的光点
 *   受扰地图：受扰电平做成起伏的地形，干扰源向外扩散波纹，敏感对象脉动
 *   平面谐振：模态振型做成上下起伏的曲面，节线固定不动
 *   温度：温度做成高度，可左右对比加散热前后；热点上方有上升的热气
 */
(function (LP) {
  'use strict';
  const G = LP.geometry, PR = LP.render;
  const T_BOARD = 1.6;

  const loader = {
    T: null,
    supported() {
      try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); } catch (e) { return false; }
    },
    async load() {
      if (this.T) return this.T;
      const el = document.getElementById('three-src');
      const text = el ? el.textContent : '';
      let mod;
      if (text && text.trim()) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
        try { mod = await import(url); } finally { URL.revokeObjectURL(url); }
      } else mod = await import(el.getAttribute('data-src'));   // 开发模式（HTTP）
      this.T = mod;
      return mod;
    },
    async create(host) { const T = await this.load(); return new View3D(T, host); },
  };

  // sRGB → 线性（顶点颜色按线性空间解释）
  const LIN = new Float32Array(256);
  for (let k = 0; k < 256; k++) { const c = k / 255; LIN[k] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const lin = (v) => LIN[Math.max(0, Math.min(255, v | 0))];
  const pcol = (pal, t, out, o, k = 1) => { const c = PR.palette(pal, t); out[o] = lin(c[0]) * k; out[o + 1] = lin(c[1]) * k; out[o + 2] = lin(c[2]) * k; };

  class View3D {
    constructor(T, host) {
      this.T = T; this.host = host;
      this.r = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.r.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
      host.append(this.r.domElement);
      this.labelsEl = document.createElement('div'); this.labelsEl.className = 'l3d-host'; host.append(this.labelsEl);
      this.scene = new T.Scene();
      this.cam = new T.PerspectiveCamera(38, 1, 0.5, 2000);
      this.scene.add(new T.HemisphereLight(0xc8d4ff, 0x20242e, 1.6));
      const sun = new T.DirectionalLight(0xffffff, 1.6); sun.position.set(-30, 60, 40); this.scene.add(sun);
      this.az = -32; this.el = 34; this.dist = 80; this.target = new T.Vector3(0, 0, 0);
      this.boardGroup = new T.Group(); this.scene.add(this.boardGroup);
      this.dyn = new T.Group(); this.scene.add(this.dyn);
      this.anim = true; this.active = false; this.t = 0; this.updaters = []; this.labels = [];
      this.bindInput();
      this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
      this.resize();
    }

    // ---------- 视角 ----------
    bindInput() {
      const el = this.r.domElement;
      let drag = null;
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; el.setPointerCapture(e.pointerId); });
      el.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        if (drag.pan) {
          const k = this.dist / 600, a = (this.az * Math.PI) / 180;
          this.target.x += (-dx * Math.cos(a) - dy * Math.sin(a)) * k;
          this.target.z += (dx * Math.sin(a) - dy * Math.cos(a)) * k;
        } else { this.az -= dx * 0.35; this.el = Math.max(8, Math.min(88, this.el + dy * 0.3)); }
        this.kick();
      });
      el.addEventListener('pointerup', () => { drag = null; });
      el.addEventListener('wheel', (e) => { e.preventDefault(); this.dist = Math.max(this.size * 0.4, Math.min(this.size * 5, this.dist * Math.exp(e.deltaY * 0.001))); this.kick(); }, { passive: false });
      el.addEventListener('dblclick', () => { this.home(); this.kick(); });
    }
    home() { this.az = -32; this.el = 34; this.dist = this.size * 1.75; this.target.set(0, this.size * 0.02, 0); }
    setCamera(o) { Object.assign(this, o); this.kick(); }
    placeCamera() {
      const a = (this.az * Math.PI) / 180, e = (this.el * Math.PI) / 180;
      this.cam.position.set(this.target.x + this.dist * Math.cos(e) * Math.sin(a), this.target.y + this.dist * Math.sin(e), this.target.z + this.dist * Math.cos(e) * Math.cos(a));
      this.cam.lookAt(this.target);
    }
    resize() {
      const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
      this.W = w; this.H = h;
      this.r.setSize(w, h, false); this.r.domElement.style.width = w + 'px'; this.r.domElement.style.height = h + 'px';
      this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
      this.kick();
    }

    // ---------- 坐标 ----------
    X(x) { return x - this.cx; }
    Z(y) { return -(y - this.cy); }

    // ---------- 板与器件 ----------
    setBoard(sum) {
      const T = this.T;
      this.sum = sum;
      const b = sum.board;
      this.cx = b.x0 + b.w / 2; this.cy = b.y0 + b.h / 2; this.size = Math.max(b.w, b.h);
      this.poly = G.outlinePolygon(b.outline);
      this.clearGroup(this.boardGroup);
      const shape = new T.Shape(this.poly.map((p) => new T.Vector2(this.X(p.x), -this.Z(p.y))));
      for (const hl of b.holes || []) { const p = new T.Path(); p.absarc(this.X(hl.x), -this.Z(hl.y), hl.d / 2, 0, Math.PI * 2, true); shape.holes.push(p); }
      const geo = new T.ExtrudeGeometry(shape, { depth: T_BOARD, bevelEnabled: false, curveSegments: 24 });
      geo.rotateX(-Math.PI / 2); geo.translate(0, -T_BOARD, 0);
      this.boardMat = new T.MeshStandardMaterial({ color: 0x1d4a36, roughness: 0.75, metalness: 0.05, transparent: true, opacity: 1 });
      this.boardGroup.add(new T.Mesh(geo, this.boardMat));
      const edge = new T.LineSegments(new T.EdgesGeometry(geo, 30), new T.LineBasicMaterial({ color: 0x6aa58a, transparent: true, opacity: 0.6 }));
      this.boardGroup.add(edge);
      this.partMeshes = new Map();
      const partMat = new T.MeshStandardMaterial({ color: 0x2b303b, roughness: 0.55, metalness: 0.15, transparent: true, opacity: 0.92 });
      const satMat = new T.MeshStandardMaterial({ color: 0x8b7d62, roughness: 0.5, metalness: 0.2 });
      const antMat = new T.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 0.4 });
      for (const it of sum.items) {
        const r = it.rect, w = r.x1 - r.x0, d = r.y1 - r.y0;
        const ht = it.kind === 'sat' ? 0.5 : it.role === 'battery' ? 3.2 : it.role === 'connector' ? 2.6 : it.role === 'antenna' ? 0.4 : 1.0;
        const m = new T.Mesh(new T.BoxGeometry(w, ht, d), it.kind === 'sat' ? satMat : it.role === 'antenna' ? antMat : partMat);
        const top = it.side !== 'bottom';
        m.position.set(this.X((r.x0 + r.x1) / 2), top ? ht / 2 : -T_BOARD - ht / 2, this.Z((r.y0 + r.y1) / 2));
        this.boardGroup.add(m);
        this.partMeshes.set(it.ref, { mesh: m, ht, top, rect: r });
      }
      this.bottomDepth = Math.max(0, ...[...this.partMeshes.values()].filter((q) => !q.top).map((q) => q.ht));
      this.home();
      this.clearDyn();
    }

    clearGroup(gr) {
      for (const c of [...gr.children]) { gr.remove(c); c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && !o.material.shared) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
    }
    clearDyn() {
      this.clearGroup(this.dyn);
      this.updaters = []; this.labels = []; this.labelsEl.replaceChildren();
      if (this.size) this.target.y = this.size * 0.02;
      if (this.boardMat) { this.boardMat.opacity = 1; this.boardMat.depthWrite = true; }
      for (const q of (this.partMeshes || new Map()).values()) { q.mesh.visible = true; q.mesh.position.y = q.top ? q.ht / 2 : -T_BOARD - q.ht / 2; }
      for (const c of this.fins || []) this.boardGroup.remove(c);
      this.fins = [];
    }

    // ---------- 通用：场的曲面 ----------
    /**
     * 由网格场生成曲面。opts: {y0, height(v)→mm, color(v, out, o), step, valid(v), blend}
     * 返回 {mesh, idx(顶点 → 网格下标), update(fnH, fnC)}
     */
    surface(field, g, opts) {
      const T = this.T, step = opts.step || Math.max(1, Math.ceil(Math.max(g.nx, g.ny) / 120));
      const ni = Math.ceil(g.nx / step), nj = Math.ceil(g.ny / step);
      const pos = new Float32Array(ni * nj * 3), col = new Float32Array(ni * nj * 3), idx = new Int32Array(ni * nj), ok = new Uint8Array(ni * nj);
      for (let jj = 0; jj < nj; jj++) for (let ii = 0; ii < ni; ii++) {
        const i = Math.min(g.nx - 1, ii * step), j = Math.min(g.ny - 1, jj * step), c = j * g.nx + i, v = ii + jj * ni;
        const x = g.x0 + (i + 0.5) * g.cell, y = g.y0 + (j + 0.5) * g.cell, f = field[c];
        idx[v] = c;
        ok[v] = Number.isFinite(f) && (!opts.valid || opts.valid(f, c)) && G.pointInPolygon({ x, y }, this.poly) ? 1 : 0;
        pos[3 * v] = this.X(x); pos[3 * v + 2] = this.Z(y);
        pos[3 * v + 1] = (opts.y0 || 0) + (ok[v] ? opts.height(f, c) : 0);
        if (ok[v]) opts.color(f, col, 3 * v, c);
      }
      const ind = [];
      for (let jj = 0; jj < nj - 1; jj++) for (let ii = 0; ii < ni - 1; ii++) {
        const a = ii + jj * ni, b = a + 1, c = a + ni, d = c + 1;
        if (ok[a] && ok[b] && ok[d]) ind.push(a, d, b);
        if (ok[a] && ok[d] && ok[c]) ind.push(a, c, d);
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      geo.setAttribute('color', new T.BufferAttribute(col, 3));
      geo.setIndex(ind);
      geo.computeVertexNormals();
      const mat = opts.blend === 'add'
        ? new T.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide })
        : new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, side: T.DoubleSide, transparent: (opts.opacity ?? 1) < 1, opacity: opts.opacity ?? 1, emissive: 0xffffff, emissiveIntensity: 0, flatShading: false });
      if (opts.blend !== 'add') mat.onBeforeCompile = (sh) => {   // 颜色同时作为自发光，暗处也能看清色带
        sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.55;');
      };
      const mesh = new T.Mesh(geo, mat);
      mesh.renderOrder = opts.renderOrder || 0;
      this.dyn.add(mesh);
      return {
        mesh, idx, ok, ni, nj,
        update: (fnH, fnC) => {
          for (let v = 0; v < idx.length; v++) {
            if (!ok[v]) continue;
            if (fnH) pos[3 * v + 1] = (opts.y0 || 0) + fnH(idx[v], v);
            if (fnC) fnC(idx[v], col, 3 * v, v);
          }
          geo.attributes.position.needsUpdate = true;
          if (fnC) geo.attributes.color.needsUpdate = true;
          if (fnH) geo.computeVertexNormals();
        },
      };
    }

    sample(field, g, x, y) {
      const i = Math.floor((x - g.x0) / g.cell), j = Math.floor((y - g.y0) / g.cell);
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return NaN;
      return field[j * g.nx + i];
    }

    label(x, y, h, text, cls = '') {
      const el = document.createElement('div'); el.className = 'l3d ' + cls; el.textContent = text;
      this.labelsEl.append(el);
      this.labels.push({ el, v: new this.T.Vector3(this.X(x), h, this.Z(y)) });
    }
    line(pts, color, opacity = 1, dashed = false) {
      const T = this.T;
      const geo = new T.BufferGeometry().setFromPoints(pts.map((p) => new T.Vector3(p[0], p[1], p[2])));
      const mat = dashed ? new T.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.6, gapSize: 0.4 }) : new T.LineBasicMaterial({ color, transparent: true, opacity });
      const l = new T.Line(geo, mat); if (dashed) l.computeLineDistances();
      this.dyn.add(l);
      return l;
    }
    ball(x, y, h, color, r = 0.45) {
      const T = this.T, m = new T.Mesh(new T.SphereGeometry(r, 18, 12), new T.MeshBasicMaterial({ color }));
      m.position.set(this.X(x), h, this.Z(y)); this.dyn.add(m); return m;
    }
    sheet(y, color, opacity) {
      const T = this.T;
      const shape = new T.Shape(this.poly.map((p) => new T.Vector2(this.X(p.x), -this.Z(p.y))));
      const geo = new T.ShapeGeometry(shape); geo.rotateX(-Math.PI / 2); geo.translate(0, y, 0);
      const m = new T.Mesh(geo, new T.MeshBasicMaterial({ color, transparent: true, opacity, side: T.DoubleSide, depthWrite: false }));
      this.dyn.add(m);
      const e = new T.LineSegments(new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color: 0x5b7fa8, transparent: true, opacity: 0.7 }));
      this.dyn.add(e);
      return m;
    }

    // ---------- 流动光点（拖尾线段） ----------
    streaks(spec) {
      const T = this.T, n = spec.n, g = spec.g, N = g.nx * g.ny;
      const L0 = Math.log10(spec.lo), L1 = Math.log10(spec.hi);
      const tn = (m) => Math.max(0, Math.min(1, (Math.log10(m) - L0) / (L1 - L0 || 1)));
      const cdf = new Float64Array(N); let acc = 0;
      for (let c = 0; c < N; c++) { const m = spec.mag[c]; if (m > spec.lo) acc += Math.pow(tn(m), 1.4) + 0.03; cdf[c] = acc; }
      if (!(acc > 0)) return;
      const pick = () => { const r = Math.random() * acc; let lo = 0, hi = N - 1; while (lo < hi) { const md = (lo + hi) >> 1; if (cdf[md] < r) lo = md + 1; else hi = md; } return lo; };
      const px = new Float32Array(n), py = new Float32Array(n), age = new Float32Array(n), life = new Float32Array(n);
      const spawn = (k, init) => { const c = pick(); px[k] = g.x0 + ((c % g.nx) + Math.random()) * g.cell; py[k] = g.y0 + (((c / g.nx) | 0) + Math.random()) * g.cell; age[k] = init ? Math.random() * 2 : 0; life[k] = 1.2 + Math.random() * 1.6; };
      for (let k = 0; k < n; k++) spawn(k, true);
      const pos = new Float32Array(n * 6), col = new Float32Array(n * 6);
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      geo.setAttribute('color', new T.BufferAttribute(col, 3));
      const lines = new T.LineSegments(geo, new T.LineBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
      lines.frustumCulled = false; lines.renderOrder = 5;
      this.dyn.add(lines);
      const sp = (spec.speed || 1) * this.size / 2.5, y = spec.y;
      const upd = (dt) => {
        for (let k = 0; k < n; k++) {
          const i = Math.floor((px[k] - g.x0) / g.cell), j = Math.floor((py[k] - g.y0) / g.cell);
          const c = i >= 0 && j >= 0 && i < g.nx && j < g.ny ? j * g.nx + i : -1;
          const m = c >= 0 ? spec.mag[c] : 0;
          age[k] += dt;
          if (!(m > spec.lo) || age[k] > life[k]) { spawn(k, false); continue; }
          const t = tn(m), ux = spec.fx[c] / m, uy = spec.fy[c] / m, st = sp * (0.25 + 0.75 * t) * dt;
          px[k] += ux * st; py[k] += uy * st;
          const tail = this.size * 0.018 * (0.5 + t), o = 6 * k;
          pos[o] = this.X(px[k]); pos[o + 1] = y; pos[o + 2] = this.Z(py[k]);
          pos[o + 3] = this.X(px[k] - ux * tail); pos[o + 4] = y; pos[o + 5] = this.Z(py[k] - uy * tail);
          const fade = Math.min(1, age[k] / 0.25, (life[k] - age[k]) / 0.4) * (spec.alpha || 1);
          pcol(spec.pal, 0.45 + 0.55 * t, col, o, fade * 2.2);
          col[o + 3] = col[o + 4] = col[o + 5] = 0;
        }
        geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
      };
      upd(0.001);
      this.updaters.push(upd);
    }

    ripple(x, y, h, color, amp) {
      const T = this.T, rings = [];
      for (let k = 0; k < 3; k++) {
        const m = new T.Mesh(new T.RingGeometry(0.94, 1, 72), new T.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: T.DoubleSide, depthTest: false, depthWrite: false, blending: T.AdditiveBlending }));
        m.rotation.x = -Math.PI / 2; m.position.set(this.X(x), h, this.Z(y)); m.renderOrder = 8;
        this.dyn.add(m); rings.push(m);
      }
      const maxR = this.size * 0.85;
      this.updaters.push(() => {
        rings.forEach((m, k) => {
          const ph = ((this.t / 2.4 + k / 3) % 1 + 1) % 1, r = Math.max(0.05, ph * maxR);
          m.scale.set(r, r, 1);
          m.material.opacity = Math.min(0.85, amp * (1 / (1 + (r / 3) ** 2)) * (1 - ph) * 1.4 + (1 - ph) * 0.12);
        });
      });
    }

    // ---------- 各页的场景 ----------
    showCurrent(d) {
      this.clearDyn();
      const { r, g, lo, hi, sup, ret } = d;
      const gap = Math.max(this.size * 0.16, this.bottomDepth + 2.5);
      const yRet = -T_BOARD - gap;
      this.boardMat.opacity = 0.42; this.boardMat.depthWrite = false;
      const L0 = Math.log10(lo), L1 = Math.log10(hi);
      const tn = (v) => Math.max(0, Math.min(1, (Math.log10(v) - L0) / (L1 - L0 || 1)));
      const flat = (field, pal, y) => this.surface(field, g, { y0: y, height: () => 0, valid: (v) => v > lo, blend: 'add', renderOrder: 3, color: (v, out, o) => pcol(pal, tn(v), out, o, 0.75 * tn(v) ** 1.2) });
      if (sup) { flat(r.sup.mag, 'fire', 0.06); this.streaks({ ...r.sup, g, n: 2200, lo, hi, pal: 'fire', y: 0.1 }); }
      if (ret) {
        this.sheet(yRet - 0.02, 0x16233a, 0.55);
        flat(r.ret.mag, 'ice', yRet);
        this.streaks({ ...r.ret, g, n: 1300, lo, hi, pal: 'ice', y: yRet + 0.04, speed: 0.8, alpha: 0.8 });
        this.label(this.sum.board.x0 + 1, this.sum.board.y0 + 1, yRet, '地平面上的回流', 'layer');
        for (const p of [r.pins.loadGnd, r.pins.srcGnd]) if (p) this.line([[this.X(p.x), 0, this.Z(p.y)], [this.X(p.x), yRet, this.Z(p.y)]], 0x79c0ff, 0.8, true);
      }
      if (sup) this.label(this.sum.board.x0 + 1, this.sum.board.y0 + 1, 0.2, '板上的去程', 'layer warm');
      this.target.y = ret ? yRet * 0.45 : 0;
      const p = r.pins;
      this.ball(p.src.x, p.src.y, 0.6, 0x7ee787); this.label(p.src.x, p.src.y, 1.6, '电源起点', 'mark green');
      this.ball(p.load.x, p.load.y, 0.6, 0xffd166); this.label(p.load.x, p.load.y, 1.6, '负载', 'mark yellow');
      if (ret && p.loadGnd) this.ball(p.loadGnd.x, p.loadGnd.y, yRet, 0x79c0ff, 0.35);
      this.partLabels();
      this.kick();
    }

    showEmiMap(d) {
      this.clearDyn();
      const { map, g, emitters, victims } = d, H = this.size * 0.3;
      let vmin = Infinity, vmax = -Infinity;
      for (const v of map) if (Number.isFinite(v)) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
      const hgt = (v) => H * Math.max(0, (v - vmin) / (vmax - vmin || 1)) ** 1.8;   // 高度按板上的相对电平，颜色仍按绝对 dB
      this.target.y = H * 0.15;
      this.surface(map, g, { y0: 0.05, height: hgt, opacity: 0.93, color: (v, out, o) => pcol('plasma', (v + 60) / 60, out, o) });
      for (const it of this.partMeshes.values()) if (it.top) it.mesh.visible = false;
      for (const e of emitters) {
        const pts = e.pts.map((q) => (Array.isArray(q) ? { x: q[0], y: q[1] } : q));
        const centers = pts.length > 4 ? pts.filter((_, i) => i % Math.ceil(pts.length / 4) === 0) : pts;
        const amp = Math.pow(10, e.level / 20);
        for (const q of centers) { const h = hgt(this.sample(map, g, q.x, q.y)) || 0; this.ripple(q.x, q.y, h + 0.3, 0xff8cdc, amp); }
        for (const q of pts) this.ball(q.x, q.y, (hgt(this.sample(map, g, q.x, q.y)) || 0) + 0.35, 0xffc6f0, 0.22);
        const q = pts[Math.floor(pts.length / 2)];
        this.label(q.x, q.y, (hgt(this.sample(map, g, q.x, q.y)) || 0) + 2.2, e.label, 'mark pink');
      }
      const T = this.T;
      for (const v of victims) {
        const col = v.grade === 'high' ? 0xff5a5a : v.grade === 'mid' ? 0xffc85a : 0x8cdca0;
        const h = (hgt(this.sample(map, g, v.x, v.y)) || 0) + 0.25;
        const m = new T.Mesh(new T.TorusGeometry(1, 0.08, 8, 48), new T.MeshBasicMaterial({ color: col, transparent: true, depthTest: false }));
        m.rotation.x = -Math.PI / 2; m.position.set(this.X(v.x), h, this.Z(v.y)); m.renderOrder = 9; this.dyn.add(m);
        const w = v.grade === 'high' ? 8 : v.grade === 'mid' ? 4 : 1.5;
        this.updaters.push(() => { const p = 0.5 + 0.5 * Math.sin(this.t * w); m.scale.setScalar(1 + 0.45 * p); m.material.opacity = 0.35 + 0.6 * p * (v.grade === 'low' ? 0.3 : 1); });
        this.label(v.x, v.y, h + 1.6, `${v.label} ${Math.round(v.level)} dB`, 'mark ' + v.grade);
      }
      this.kick();
    }

    showModes(d) {
      this.clearDyn();
      const { phi, g, nodal, big, small } = d, A = this.size * 0.14, Y0 = A + 1.2;   // 曲面浮在板上方，正负起伏都看得见
      let s = 1;
      const surf = this.surface(phi, g, { y0: Y0, height: (v) => A * v, valid: (v, c) => !d.mask || d.mask[c], opacity: 0.95, color: (v, out, o) => pcol('div', 0.5 + 0.5 * v, out, o) });
      for (const it of this.partMeshes.values()) if (it.top) it.mesh.visible = false;
      const segs = [];
      for (const q of nodal) segs.push(this.X(q[0]), Y0 + 0.05, this.Z(q[1]), this.X(q[2]), Y0 + 0.05, this.Z(q[3]));
      const T = this.T, geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(segs, 3));
      const nl = new T.LineSegments(geo, new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false })); nl.renderOrder = 9; this.dyn.add(nl);
      let mx = 0, mc = 0; for (let c = 0; c < phi.length; c++) if (Math.abs(phi[c]) > mx && (!d.mask || d.mask[c])) { mx = Math.abs(phi[c]); mc = c; }
      const ax = g.x0 + ((mc % g.nx) + 0.5) * g.cell, ay = g.y0 + (((mc / g.nx) | 0) + 0.5) * g.cell;
      this.label(this.cx, this.cy + this.sum.board.h * 0.35, Y0 + A + 5, big, 'big');
      this.label(this.cx, this.cy + this.sum.board.h * 0.35, Y0 + A + 3, small, 'small');
      this.target.y = Y0 * 0.6;
      this.updaters.push(() => {
        const ns = Math.sin(this.t * 2.2);
        if (Math.abs(ns - s) < 1e-4) return;
        s = ns;
        surf.update((c) => A * phi[c] * s, (c, out, o) => pcol('div', 0.5 + 0.5 * phi[c] * s, out, o));
      });
      this.kick();
    }

    showThermal(d) {
      this.clearDyn();
      const { base, cfg, g, lo, hi, compare, split } = d, H = this.size * 0.32;
      const bx0 = this.sum.board.x0, bw = this.sum.board.w;
      const xs = bx0 + split * bw;
      const pick = (c) => (!compare || g.x0 + ((c % g.nx) + 0.5) * g.cell >= xs ? cfg.T : base.T);
      const hgt = (v) => H * Math.max(0, (v - lo) / (hi - lo || 1));
      const T = this.T;
      this.target.y = H * 0.35;
      this.surface(cfg.T, g, { y0: 0.05, height: (v, c) => hgt(pick(c)[c]), opacity: 0.94, valid: (v, c) => Number.isFinite(pick(c)[c]), color: (v, out, o, c) => pcol('heat', (pick(c)[c] - lo) / (hi - lo || 1), out, o) });
      for (const it of this.partMeshes.values()) if (it.top) it.mesh.visible = false;
      if (compare) {
        const pg = new T.PlaneGeometry(this.sum.board.h + 2, H * 1.25);
        const wall = new T.Mesh(pg, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, side: T.DoubleSide, depthWrite: false }));
        wall.rotation.y = Math.PI / 2; wall.position.set(this.X(xs), H * 0.62, 0); this.dyn.add(wall);
        this.line([[this.X(xs), 0.1, this.Z(this.sum.board.y0 - 1)], [this.X(xs), 0.1, this.Z(this.sum.board.y0 + this.sum.board.h + 1)]], 0xffffff, 0.9);
        this.label(bx0 + split * bw * 0.5, this.sum.board.y0 + this.sum.board.h, H * 1.15, '无散热', 'side');
        this.label(xs + (1 - split) * bw * 0.5, this.sum.board.y0 + this.sum.board.h, H * 1.15, '有散热', 'side');
      }
      // 散热片：装在被选了散热器的器件上（画在"有散热"一侧）
      for (const [ref, k] of Object.entries(d.heatsinks || {})) {
        const q = this.partMeshes.get(ref); if (!q) continue;
        const r = q.rect, w = r.x1 - r.x0 + 1.2, dd = r.y1 - r.y0 + 1.2, cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
        const top = hgt(this.sample(cfg.T, g, cx, cy)) || 0;
        const fins = Math.max(4, Math.round(w / 1.2)), fh = 1.5 + k * 14;
        const mat = new T.MeshStandardMaterial({ color: 0xb8c2cc, metalness: 0.7, roughness: 0.35, transparent: true, opacity: 0.9 });
        const grp = new T.Group();
        const plate = new T.Mesh(new T.BoxGeometry(w, 0.4, dd), mat); plate.position.y = 0.2; grp.add(plate);
        for (let f = 0; f < fins; f++) { const fm = new T.Mesh(new T.BoxGeometry(0.25, fh, dd), mat); fm.position.set(-w / 2 + (f + 0.5) * (w / fins), 0.4 + fh / 2, 0); grp.add(fm); }
        grp.position.set(this.X(cx), top + 0.1, this.Z(cy));
        this.dyn.add(grp);
      }
      if (d.callout) this.label(d.callout.x, d.callout.y, H * 1.0 + 2, d.callout.big, 'big');
      this.heatPlumes(d, pick, hgt, lo, hi);
      this.kick();
    }

    /** 热点上方上升的热气：生成率随温升平方，颜色随板温。 */
    heatPlumes(d, pick, hgt, lo, hi) {
      const T = this.T, g = d.g, N = g.nx * g.ny, n = 900;
      const cdf = new Float64Array(N); let acc = 0;
      for (let c = 0; c < N; c++) { const v = pick(c)[c]; if (Number.isFinite(v)) acc += Math.pow(Math.max(0, (v - lo) / (hi - lo || 1)), 3); cdf[c] = acc; }
      if (!(acc > 0)) return;
      const pickC = () => { const r = Math.random() * acc; let a = 0, b = N - 1; while (a < b) { const m = (a + b) >> 1; if (cdf[m] < r) a = m + 1; else b = m; } return a; };
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), base = new Float32Array(n * 3), age = new Float32Array(n), life = new Float32Array(n), cc = new Int32Array(n);
      const spawn = (k, init) => {
        const c = pickC(); cc[k] = c;
        const x = g.x0 + ((c % g.nx) + Math.random()) * g.cell, y = g.y0 + (((c / g.nx) | 0) + Math.random()) * g.cell;
        base[3 * k] = this.X(x); base[3 * k + 1] = hgt(pick(c)[c]) + 0.2; base[3 * k + 2] = this.Z(y);
        life[k] = 1.4 + Math.random() * 1.6; age[k] = init ? Math.random() * life[k] : 0;
      };
      for (let k = 0; k < n; k++) spawn(k, true);
      const cv = document.createElement('canvas'); cv.width = cv.height = 32;
      const cx = cv.getContext('2d'), gr = cx.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); cx.fillStyle = gr; cx.fillRect(0, 0, 32, 32);
      const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('color', new T.BufferAttribute(col, 3));
      const pts = new T.Points(geo, new T.PointsMaterial({ size: this.size * 0.022, map: new T.CanvasTexture(cv), vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
      pts.frustumCulled = false; pts.renderOrder = 6; this.dyn.add(pts);
      const rise = this.size * 0.09;
      const upd = (dt) => {
        for (let k = 0; k < n; k++) {
          age[k] += dt; if (age[k] > life[k]) spawn(k, false);
          const a = age[k] / life[k], o = 3 * k;
          pos[o] = base[o] + Math.sin(this.t * 2 + k) * 0.25 * a; pos[o + 1] = base[o + 1] + rise * a; pos[o + 2] = base[o + 2] + Math.cos(this.t * 1.7 + k) * 0.25 * a;
          const v = pick(cc[k])[cc[k]], t = (v - lo) / (hi - lo || 1);
          pcol('heat', 0.55 + 0.45 * t, col, o, Math.sin(Math.PI * a) * 0.55 * t);
        }
        geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
      };
      upd(0.001);
      this.updaters.push(upd);
    }

    partLabels() {
      for (const [ref, q] of this.partMeshes) {
        const it = this.sum.items.find((x) => x.ref === ref);
        if (!it || it.kind !== 'part') continue;
        this.label((q.rect.x0 + q.rect.x1) / 2, (q.rect.y0 + q.rect.y1) / 2, q.top ? q.ht + 0.4 : -T_BOARD - q.ht - 0.4, ref, 'ref');
      }
    }

    // ---------- 渲染循环 ----------
    setActive(on) { this.active = on; this.host.hidden = !on; if (on) { this.resize(); this.kick(); } else { cancelAnimationFrame(this.raf); this.raf = 0; } }
    setAnim(on) { this.anim = on; this.kick(); }
    kick() {
      if (!this.active || this.raf) return;
      let last = performance.now();
      const tick = (now) => {
        this.raf = 0;
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        if (this.anim) { this.t += dt; for (const u of this.updaters) u(dt); }
        this.draw();
        if (this.active && this.anim && !document.hidden) this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
    draw() {
      this.placeCamera();
      this.r.render(this.scene, this.cam);
      const v = new this.T.Vector3();
      for (const l of this.labels) {
        v.copy(l.v).project(this.cam);
        const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        l.el.style.display = vis ? '' : 'none';
        if (vis) l.el.style.transform = `translate(${((v.x + 1) / 2) * this.W}px, ${((1 - v.y) / 2) * this.H}px) translate(-50%, -100%)`;
      }
    }
    snapshot(cb) { this.draw(); this.r.domElement.toBlob(cb); }
  }

  LP.View3D = loader;
})(globalThis.LP = globalThis.LP || {});
