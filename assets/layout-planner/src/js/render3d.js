/*
 * render3d.js — 可选的 3D 视图。Three.js 以文本形式内联在页面中，第一次切到 3D 时才解析执行。
 * 与 2D 绘制层提供同一组接口，交互、规则与指标完全共用；所有计算仍在二维毫米坐标中进行。
 * 坐标映射：板面 (x, y) → 场景 (X = x − cx, Z = −(y − cy))，Y 向上；器件高度按 1.5 倍夸张显示。
 */
(function (LP) {
  'use strict';
  const G = LP.geometry, M = LP.model;
  const HZ = 1.5;            // 高度夸张
  const LIFT = 3.0;          // 拾取时抬起的高度（mm）

  const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

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
      } else {
        mod = await import(el.getAttribute('data-src'));   // 开发模式（HTTP）
      }
      this.T = mod;
      return mod;
    },
    async create(app, host, overlay) {
      const T = await this.load();
      return new Renderer3D(T, app, host, overlay);
    },
  };

  function roundedRectShape(T, w, h, r) {
    const s = new T.Shape();
    r = Math.max(0.001, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3));
    s.moveTo(-w / 2 + r, -h / 2);
    s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    s.lineTo(-w / 2 + r, h / 2); s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    return s;
  }

  class Renderer3D {
    constructor(T, app, host, overlay) {
      this.T = T; this.app = app; this.host = host; this.overlay = overlay;
      this.kind = '3d';
      this.az = -38; this.el = 38; this.s = 20; this.target = new T.Vector3();
      this.anims = []; this.raf = 0;
      this.meshes = []; this.partGroups = new Map(); this.satMeshes = new Map();
      this.flipAngle = 0;
      this.geoCache = new Map(); this.matCache = new Map();

      const r = new T.WebGLRenderer({ antialias: true, alpha: true });
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.shadowMap.enabled = true; r.shadowMap.type = T.PCFSoftShadowMap;
      r.outputColorSpace = T.SRGBColorSpace;
      host.innerHTML = '';
      host.append(r.domElement);
      r.domElement.style.display = 'block';
      this.renderer = r;
      this.scene = new T.Scene();
      this.camera = new T.OrthographicCamera(-10, 10, 10, -10, -500, 500);
      this.ray = new T.Raycaster();

      const hemi = new T.HemisphereLight(0xfffaf0, 0x8a8f99, 1.35);
      const sun = new T.DirectionalLight(0xffffff, 1.6);
      sun.position.set(-30, 60, 35); sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
      this.sun = sun;
      this.scene.add(hemi, sun, sun.target);

      this.board = new T.Group();           // 翻板时整体绕板面 y 轴旋转
      this.scene.add(this.board);
      this.dyn = new T.Group();             // 拖动、轨道、落点轮廓等动态对象
      this.board.add(this.dyn);
      this.labels = document.createElement('div');
      this.labels.className = 'labels3d';
      overlay.prepend(this.labels);

      app.on('change', () => { if (app.renderer === this) this.rebuild(); });
      app.on('load', () => { if (app.renderer === this) { this.rebuild(); this.fit(false); } });
      app.on('select', () => { if (app.renderer === this) this.updateHighlights(); });
      this.resize();
    }

    // ---------- 坐标 ----------
    get cx() { const bb = G.outlineBBox(this.app.p.board.outline); return (bb.x0 + bb.x1) / 2; }
    get cy() { const bb = G.outlineBBox(this.app.p.board.outline); return (bb.y0 + bb.y1) / 2; }
    get thick() { return this.app.p.board.thickness * 1.2; }
    local(x, y, h) { return new this.T.Vector3(x - this.cx, h, -(y - this.cy)); }
    surfaceY(side) { return side === 'bottom' ? 0 : this.thick; }
    viewSide() { return this.app.flipped ? 'bottom' : 'top'; }
    onSide(side) { return side === 'both' || side === this.viewSide(); }
    resize() {
      const r = this.host.getBoundingClientRect();
      this.W = Math.max(100, r.width || this.host.parentElement.clientWidth);
      this.H = Math.max(100, r.height || this.host.parentElement.clientHeight);
      this.renderer.setSize(this.W, this.H, false);
      this.renderer.domElement.style.width = this.W + 'px'; this.renderer.domElement.style.height = this.H + 'px';
      this.requestDraw();
    }
    updateCamera() {
      const T = this.T, cam = this.camera;
      const hw = this.W / 2 / this.s, hh = this.H / 2 / this.s;
      cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
      const a = (this.az * Math.PI) / 180, e = (this.el * Math.PI) / 180;
      const dir = new T.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
      cam.position.copy(this.target).addScaledVector(dir, 200);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.target);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
    }
    ndc(sx, sy) { return new this.T.Vector2((sx / this.W) * 2 - 1, -(sy / this.H) * 2 + 1); }
    /** 屏幕点 → 当前视面的板面坐标（射线与板面求交）。 */
    screenToBoard(sx, sy, h) {
      const T = this.T;
      this.updateCamera();
      this.board.updateMatrixWorld();
      this.ray.setFromCamera(this.ndc(sx, sy), this.camera);
      const inv = new T.Matrix4().copy(this.board.matrixWorld).invert();
      const o = this.ray.ray.origin.clone().applyMatrix4(inv);
      const d = this.ray.ray.direction.clone().transformDirection(inv);
      const y0 = (h !== undefined ? h : 0) + this.surfaceY(this.viewSide());
      if (Math.abs(d.y) < 1e-6) return null;
      const t = (y0 - o.y) / d.y;
      const p = o.addScaledVector(d, t);
      return { x: p.x + this.cx, y: -p.z + this.cy };
    }
    boardToScreen(x, y, h) {
      this.updateCamera();
      this.board.updateWorldMatrix(true, false);
      return this.projectBoardPoint(x,y,h);
    }
    projectBoardPoint(x, y, h) {
      const side = this.viewSide();
      const v = this.local(x, y, this.surfaceY(side) + (side === 'bottom' ? -(h || 0) : (h || 0)));
      v.applyMatrix4(this.board.matrixWorld).project(this.camera);
      return { x: (v.x + 1) / 2 * this.W, y: (1 - v.y) / 2 * this.H };
    }
    screenRect(r, h, currentMatrices = false) {
      if (!currentMatrices) { this.updateCamera(); this.board.updateWorldMatrix(true, false); }
      const pts = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]].map(([x, y]) => this.projectBoardPoint(x, y, h || 0));
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    pick(sx, sy) {
      this.updateCamera();
      this.ray.setFromCamera(this.ndc(sx, sy), this.camera);
      const hits = this.ray.intersectObjects(this.meshes, true);
      for (const hit of hits) {
        let o = hit.object;
        while (o && !o.userData.ref) o = o.parent;
        if (!o) continue;
        if (!o.visible || (o.userData.type === 'sat' && !this.app.layers.sats)) continue;
        return { type: o.userData.type, ref: o.userData.ref, backside: !this.onSide(o.userData.side) };
      }
      return null;
    }
    boardHandles() { return []; }

    // ---------- 视角 ----------
    zoomAt(sx, sy, f) {
      const before = this.screenToBoard(sx, sy);
      this.s = Math.max(3, Math.min(160, this.s * f));
      const after = this.screenToBoard(sx, sy);
      if (before && after) this.shiftTarget(before.x - after.x, before.y - after.y);
      this.requestDraw();
    }
    shiftTarget(dx, dy) {
      const T = this.T;
      const v = new T.Vector3(dx, 0, -dy).applyQuaternion(this.board.quaternion);
      this.target.add(v);
    }
    pan(dx, dy) {
      const T = this.T;
      this.updateCamera();
      const right = new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      this.target.addScaledVector(right, -dx / this.s).addScaledVector(up, dy / this.s);
      this.requestDraw();
    }
    orbit(dx, dy) {
      this.az -= dx * 0.35;
      this.el = Math.max(14, Math.min(89, this.el + dy * 0.3));
      this.requestDraw();
    }
    fit(animate) {
      const bb = G.outlineBBox(this.app.p.board.outline), ins = this.app.insets();
      const aw = this.W - ins.left - ins.right - 60, ah = this.H - ins.top - ins.bottom - 40;
      const diag = Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0);
      const s = Math.max(4, Math.min(aw / (diag * 1.02), ah / (diag * 0.78)));
      const to = { s, target: new this.T.Vector3(0, this.thick / 2, 0) };
      this.setView(to, animate, () => this.pan((ins.left - ins.right) / 2, (ins.top - ins.bottom) / 2));
    }
    focus(rect) {
      const c = G.center(rect);
      const v = this.local(c.x, c.y, this.surfaceY(this.viewSide()));
      this.board.updateMatrixWorld();
      v.applyMatrix4(this.board.matrixWorld);
      const ins = this.app.insets();
      this.setView({ s: this.s, target: v }, true, () => this.pan((ins.left - ins.right) / 2, (ins.top - ins.bottom) / 2));
    }
    setView(to, animate, after) {
      if (animate && !this.app.reducedMotion) {
        this.anims.push({ type: 'view', t0: performance.now(), dur: 320, from: { s: this.s, target: this.target.clone() }, to, after });
      } else { this.s = to.s; this.target.copy(to.target); if (after) after(); }
      this.requestDraw();
    }
    syncFrom(r2) {
      this.s = r2.s * 0.92;
      this.fit(false);
    }
    onFlip() {
      const to = this.app.flipped ? Math.PI : 0;
      if (this.app.reducedMotion) { this.flipAngle = to; this.board.rotation.z = to; this.rebuild(); return; }
      this.anims.push({ type: 'flip', t0: performance.now(), dur: 520, from: this.board.rotation.z, to });
      this.rebuild();
    }
    animate(type, data) {
      if (this.app.reducedMotion) return;
      if (type === 'ripple' || type === 'flash') { LP.motion.pulse(type, data); return; }
      this.anims.push({ type, t0: performance.now(), ...data });
      this.requestDraw();
    }
    requestDraw() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
    }

    // ---------- 材质与几何 ----------
    mat(key, make) {
      if (!this.matCache.has(key)) this.matCache.set(key, make());
      return this.matCache.get(key);
    }
    std(color, opts) { return this.mat(`std:${color}:${JSON.stringify(opts || {})}`, () => new this.T.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.0, ...(opts || {}) })); }
    box(w, d, h) {
      const key = `box:${w.toFixed(3)}:${d.toFixed(3)}:${h.toFixed(3)}`;
      if (!this.geoCache.has(key)) { const g = new this.T.BoxGeometry(w, h, d); g.translate(0, h / 2, 0); this.geoCache.set(key, g); }
      return this.geoCache.get(key);
    }
    rbox(w, d, h, r) {
      const key = `rbox:${w.toFixed(3)}:${d.toFixed(3)}:${h.toFixed(3)}:${r.toFixed(3)}`;
      if (!this.geoCache.has(key)) {
        const T = this.T;
        const bev = Math.min(r * 0.5, h * 0.25, 0.25);
        const g = new T.ExtrudeGeometry(roundedRectShape(T, w - 2 * bev, d - 2 * bev, Math.max(0.01, r - bev)), { depth: Math.max(0.01, h - 2 * bev), bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2, curveSegments: 4 });
        g.rotateX(-Math.PI / 2); g.translate(0, bev, 0);
        this.geoCache.set(key, g);
      }
      return this.geoCache.get(key);
    }
    cyl(r, h, seg) {
      const key = `cyl:${r.toFixed(3)}:${h.toFixed(3)}:${seg || 32}`;
      if (!this.geoCache.has(key)) { const g = new this.T.CylinderGeometry(r, r, h, seg || 32); g.translate(0, h / 2, 0); this.geoCache.set(key, g); }
      return this.geoCache.get(key);
    }
    meshOf(geo, mat, x, y, z) { const m = new this.T.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0); m.castShadow = true; m.receiveShadow = true; return m; }

    passiveModel(pkg, floating) {
      const group = new this.T.Group();
      const b = pkg.body, height = pkg.height * HZ;
      const pads = floating ? [] : pkg.pads;
      const landHeight = pads.length ? 0.025 : 0;
      const landMat = this.std(0xaba28c, {metalness: 0.4, roughness: 0.55});
      for (const pad of pads) {
        const mesh = this.meshOf(this.box(pad.w, pad.h, landHeight), landMat, pad.x, 0, -pad.y);
        mesh.name = 'pad:' + pad.n;
        mesh.rotation.y = (pad.angle || 0) * Math.PI / 180;
        group.add(mesh);
      }
      const end = pkg.terminals[0];
      const alongX = end && end.x !== pkg.terminals[1].x;
      const centerW = end && alongX ? b.w - end.w * 2 : b.w;
      const centerH = end && !alongX ? b.h - end.h * 2 : b.h;
      const body = this.meshOf(this.box(centerW, centerH, height), this.std(LP.render2d.CHIP_COLORS[pkg.kind]), b.x, landHeight, -b.y);
      body.name = 'body';
      group.add(body);
      const silver = this.std(0xd6dae0, {metalness: 0.45, roughness: 0.36});
      for (const t of pkg.terminals) {
        const mesh = this.meshOf(this.box(t.w, t.h, height), silver, t.x, landHeight, -t.y);
        mesh.name = 'terminal:' + t.n;
        group.add(mesh);
      }
      return group;
    }

    /** 主器件模型（局部坐标：中心为原点、底面在 y=0、板面 x 向右、板面 y 向 −z）。 */
    partModel(part, floating = false) {
      const pkg = M.passiveGeometry(part);
      if (pkg) return this.passiveModel(pkg, floating);
      const T = this.T, g = new T.Group();
      const w = part.w, d = part.h, H = Math.max(0.5, part.z * HZ);
      const gold = this.std(0xd8b66a, { metalness: 0.3, roughness: 0.45 });
      const dark = this.std(0x33363b), silver = this.std(0xc4c8cf, { metalness: 0.35, roughness: 0.4 });
      const pads = (sides) => {
        for (const s of sides) {
          const along = s === 'N' || s === 'S';
          const m = this.meshOf(this.box(along ? w * 0.82 : 0.22, along ? 0.22 : d * 0.82, 0.12), gold);
          if (s === 'N') m.position.z = -d / 2; if (s === 'S') m.position.z = d / 2;
          if (s === 'E') m.position.x = w / 2; if (s === 'W') m.position.x = -w / 2;
          g.add(m);
        }
      };
      const pin1 = () => { const m = this.meshOf(this.cyl(Math.min(0.28, Math.min(w, d) * 0.08), 0.04, 16), this.std(0xdedede)); m.position.set(-w / 2 + 0.6, H, -d / 2 + 0.6); g.add(m); };
      const index = M.bgaMark(part);
      switch (index ? 'bga' : part.shape) {
        case 'coin': { const r = Math.min(w, d) / 2; g.add(this.meshOf(this.cyl(r, H, 48), silver)); const tab = this.meshOf(this.box(r * 0.5, r * 0.35, H * 0.6), silver); tab.position.z = -r; g.add(tab); break; }
        case 'module': g.add(this.meshOf(this.rbox(w, d, H, 0.3), silver)); break;
        case 'chip_antenna': {
          g.add(this.meshOf(this.rbox(w, d, H, Math.min(w, d) * 0.2), this.std(0xefe8d8)));
          const cap = Math.min(w, d) * 0.45;
          for (const sg of [-1, 1]) { const m = this.meshOf(w >= d ? this.box(cap, d * 1.02, H * 1.02) : this.box(w * 1.02, cap, H * 1.02), silver); if (w >= d) m.position.x = sg * (w / 2 - cap / 2); else m.position.z = sg * (d / 2 - cap / 2); g.add(m); }
          break;
        }
        case 'pcb_antenna': { const m = this.meshOf(this.box(w, d, 0.05), gold); g.add(m); break; }
        case 'usb_c': {
          g.add(this.meshOf(this.rbox(w, d, H, Math.min(w, d) * 0.3), silver));
          const face = part.edge_face || 'S';
          const along = face === 'N' || face === 'S';
          const slot = this.meshOf(this.box(along ? w * 0.64 : 0.3, along ? 0.3 : d * 0.64, H * 0.5), this.std(0x3b4048));
          slot.position.y = H * 0.25;
          if (face === 'S') slot.position.z = d / 2; if (face === 'N') slot.position.z = -d / 2; if (face === 'E') slot.position.x = w / 2; if (face === 'W') slot.position.x = -w / 2;
          g.add(slot); break;
        }
        case 'header': {
          g.add(this.meshOf(this.box(w, d, H * 0.45), this.std(0x222428)));
          const cols = Math.max(1, Math.round(w / 1.27)), rows = Math.max(1, Math.round(d / 1.27));
          for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) { const m = this.meshOf(this.box(0.4, 0.4, H), gold); m.position.set(-w / 2 + (i + 0.5) * (w / cols), 0, -d / 2 + (j + 0.5) * (d / rows)); g.add(m); }
          break;
        }
        case 'button': { g.add(this.meshOf(this.rbox(w, d, H * 0.55, 0.3), this.std(0x3a3d43))); const c = this.meshOf(this.cyl(Math.min(w, d) * 0.32, H * 0.45, 24), this.std(0x9aa0a8)); c.position.y = H * 0.55; g.add(c); break; }
        case 'led': g.add(this.meshOf(this.rbox(w, d, H, Math.min(w, d) * 0.3), new T.MeshStandardMaterial({ color: part.color || '#f43f5e', emissive: part.color || '#f43f5e', emissiveIntensity: 0.6, transparent: true, opacity: 0.85, roughness: 0.3 }))); break;
        case 'inductor': g.add(this.meshOf(this.rbox(w, d, H, Math.min(w, d) * 0.25), this.std(0x2a2c31))); break;
        case 'mic': g.add(this.meshOf(this.rbox(w, d, H, 0.3), silver)); break;
        case 'optical': g.add(this.meshOf(this.rbox(w, d, H, 0.2), this.std(0x2b2e33))); break;
        case 'pouch': g.add(this.meshOf(this.rbox(w, d, H, 0.6), this.std(0xb9c3d1))); break;
        case 'soic': case 'sot': {
          g.add(this.meshOf(this.rbox(w, d, H, 0.15), this.std(0x2f3237)));
          const sides = part.shape === 'soic' ? ['E', 'W'] : ['N', 'S'];
          for (const s of sides) { const along = s === 'N' || s === 'S'; const m = this.meshOf(this.box(along ? w * 0.8 : 0.6, along ? 0.6 : d * 0.8, 0.15), this.std(0xc9ccd2, { metalness: 0.4 })); if (s === 'E') m.position.x = w / 2 + 0.2; if (s === 'W') m.position.x = -w / 2 - 0.2; if (s === 'N') m.position.z = -d / 2 - 0.2; if (s === 'S') m.position.z = d / 2 + 0.2; g.add(m); }
          pin1(); break;
        }
        case 'dfn': case 'uson': g.add(this.meshOf(this.rbox(w, d, H, Math.min(w, d) * 0.12), dark)); pads(['E', 'W']); pin1(); break;
        case 'bga': {
          g.add(this.meshOf(this.rbox(w, d, H, Math.min(w, d) * 0.08), this.std(0x2b2e33)));
          const dot = this.meshOf(this.cyl(index.r, 0.025, 16), this.std(0xdddddd), index.x, H, -index.y);
          dot.name = 'A1'; g.add(dot);
          break;
        }
        case 'lga': g.add(this.meshOf(this.rbox(w, d, H, Math.min(w, d) * 0.12), this.std(0x30333a))); pads(['N', 'E', 'S', 'W']); pin1(); break;
        case 'qfn': default: g.add(this.meshOf(this.rbox(w, d, H, Math.min(w, d) * 0.12), dark)); pads(['N', 'E', 'S', 'W']); pin1(); break;
      }
      if (part.role === 'imu') {
        // 顶面坐标轴记号
        const ax = (x, z, c) => { const m = this.meshOf(this.box(Math.abs(x) || 0.12, Math.abs(z) || 0.12, 0.05), this.std(c)); m.position.set(x / 2 + w * 0.15, H, z / 2 + d * 0.15); g.add(m); };
        ax(Math.min(w, d) * 0.3, 0, 0xf87171); ax(0, -Math.min(w, d) * 0.3, 0x4ade80);
      }
      return g;
    }
    satModel(s, floating = false) {
      const pkg = M.passiveGeometry(s);
      if (pkg) return this.passiveModel(pkg, floating);
      const T = this.T, g = new T.Group();
      const w = s.w, d = s.h, H = Math.max(0.35, Math.min(w, d) * 0.7) * HZ;
      const shape = M.SAT_KINDS[s.kind].shape;
      const silver = this.std(0xd9dce1, { metalness: 0.4, roughness: 0.35 });
      if (shape === 'crystal') { g.add(this.meshOf(this.rbox(w, d, H, Math.min(w, d) * 0.25), silver)); return g; }
      const bodyColor = shape === 'cap' ? 0xcbb68c : shape === 'inductor' ? 0x2a2c31 : 0x25272b;
      const ends = shape !== 'esd';
      const along = w >= d;
      const e = (along ? w : d) * 0.22;
      g.add(this.meshOf(along ? this.box(w - 2 * e, d * 0.96, H * 0.96) : this.box(w * 0.96, d - 2 * e, H * 0.96), this.std(bodyColor)));
      if (ends) for (const sg of [-1, 1]) { const m = this.meshOf(along ? this.box(e, d, H) : this.box(w, e, H), silver); if (along) m.position.x = sg * (w / 2 - e / 2); else m.position.z = sg * (d / 2 - e / 2); g.add(m); }
      return g;
    }
    /** 把模型放到板上：位置、旋转、正反面。 */
    pose(obj, pl, lift) {
      const side = pl.side || 'top';
      const base = this.local(pl.x, pl.y, side === 'bottom' ? -(lift || 0) : this.thick + (lift || 0));
      obj.position.copy(base);
      obj.rotation.set(0, ((pl.rot || 0) * Math.PI) / 180, 0);
      obj.scale.set(side === 'bottom' ? -1 : 1, side === 'bottom' ? -1 : 1, 1);
    }

    // ---------- 场景重建 ----------
    disposeGroup(grp) {
      for (let i = grp.children.length - 1; i >= 0; i--) {
        const c = grp.children[i];
        if (c === this.dyn) continue;
        grp.remove(c);
        c.traverse((o) => { if (o.geometry && o.userData.own) o.geometry.dispose(); if (o.material && o.userData.ownMat) o.material.dispose(); });
      }
    }
    gridTexture(mask) {
      const key = `grid:${mask}`;
      if (this.geoCache.has(key)) return this.geoCache.get(key);
      const T = this.T, N = 250, cv = document.createElement('canvas');
      cv.width = cv.height = N;
      const c = cv.getContext('2d');
      const M2 = LP.render2d.MASK[mask] || LP.render2d.MASK.green;
      c.fillStyle = M2.top; c.fillRect(0, 0, N, N);
      for (let i = 0; i <= 5; i++) {
        c.strokeStyle = i === 0 ? M2.grid5 : M2.grid; c.lineWidth = i === 0 ? 2 : 1;
        const v = (i * N) / 5;
        c.beginPath(); c.moveTo(v, 0); c.lineTo(v, N); c.stroke();
        c.beginPath(); c.moveTo(0, v); c.lineTo(N, v); c.stroke();
      }
      const tex = new T.CanvasTexture(cv);
      tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.repeat.set(1 / 5, 1 / 5); tex.colorSpace = T.SRGBColorSpace;
      tex.anisotropy = 4;
      this.geoCache.set(key, tex);
      return tex;
    }
    rebuild() {
      const T = this.T, app = this.app, p = app.p;
      if (!p) return;
      if (!this.anims.some((a) => a.type === 'flip')) this.board.rotation.z = app.flipped ? Math.PI : 0;
      this.disposeGroup(this.board);
      this.meshes = []; this.partGroups.clear(); this.satMeshes.clear();
      const b = p.board, cx = this.cx, cy = this.cy, th = this.thick;
      // 板子
      const shape = new T.Shape(G.outlinePolygon(b.outline).map((q) => new T.Vector2(q.x - cx, q.y - cy)));
      for (const h of b.holes) { const hp = new T.Path(); hp.absarc(h.x - cx, h.y - cy, h.d / 2, 0, Math.PI * 2, true); shape.holes.push(hp); }
      const bg = new T.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false, curveSegments: 24 });
      bg.rotateX(-Math.PI / 2);
      const mask = b.mask || 'green';
      const top = this.mat(`top:${mask}`, () => new T.MeshStandardMaterial({ map: this.gridTexture(mask), roughness: 0.85 }));
      const side = this.std(0xd7c79a, { roughness: 0.9 });
      const boardMesh = new T.Mesh(bg, [top, side]);
      boardMesh.receiveShadow = true; boardMesh.castShadow = true;
      boardMesh.userData.own = true; boardMesh.userData.ownMat = false;
      this.board.add(boardMesh);
      // 板子 ExtrudeGeometry 的顶/底面 UV 为形状坐标；平移到板框原点使网格对齐毫米刻度
      const off = this.gridTexture(mask); off.offset.set(-(G.outlineBBox(b.outline).x0 - cx) / 5, -(G.outlineBBox(b.outline).y0 - cy) / 5);
      for (const h of b.holes) {
        for (const yy of [th + 0.01, -0.01]) {
          const ring = new T.Mesh(new T.RingGeometry(h.d / 2, h.d / 2 + 0.45, 32), this.std(0xc9a35a, { metalness: 0.4, roughness: 0.4, side: T.DoubleSide }));
          ring.rotation.x = -Math.PI / 2; ring.position.set(h.x - cx, yy, -(h.y - cy)); ring.userData.own = true;
          this.board.add(ring);
        }
      }
      // 接触阴影：一张柔和的径向渐变，不随翻板旋转
      if (!this.shadowPlane) {
        const cv = document.createElement('canvas'); cv.width = cv.height = 128;
        const c = cv.getContext('2d'); const gr = c.createRadialGradient(64, 64, 4, 64, 64, 64);
        gr.addColorStop(0, 'rgba(0,0,0,0.32)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = gr; c.fillRect(0, 0, 128, 128);
        this.shadowPlane = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: new T.CanvasTexture(cv), transparent: true, depthWrite: false }));
        this.shadowPlane.rotation.x = -Math.PI / 2;
        this.scene.add(this.shadowPlane);
      }
      const bb = G.outlineBBox(b.outline);
      this.shadowPlane.scale.set((bb.x1 - bb.x0) * 1.6, (bb.y1 - bb.y0) * 1.6, 1);
      this.shadowPlane.position.set(0, -8, 4);
      const ext = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
      Object.assign(this.sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 200 });
      this.sun.shadow.camera.updateProjectionMatrix();

      // 主器件
      const drag = app.drag;
      for (const x of p.parts) {
        if (!x.placed) continue;
        const grp = this.partModel(x);
        grp.userData = { type: 'part', ref: x.ref, side: x.placed.side, satellite:!!M.placementOwner(x) };
        this.pose(grp, x.placed, 0);
        if (drag && drag.ref === x.ref && drag.visible) grp.visible = false;
        this.board.add(grp);
        this.meshes.push(grp);
        this.partGroups.set(x.ref, grp);
      }
      // 卫星
      if (app.layers.sats) for (const s of p.satellites) {
        if (!s.placed || !s._active) continue;
        const grp = this.satModel(s);
        grp.userData = { type: 'sat', ref: s.ref, side: s.placed.side };
        this.pose(grp, s.placed, 0);
        this.board.add(grp);
        this.meshes.push(grp);
        this.satMeshes.set(s.ref, grp);
      }
      // 区域
      if (app.ev) for (const z of app.ev.zones) {
        const show = { antenna_keepout: app.layers.keepout, keepout: true, heat: app.layers.heat, magnetic: app.layers.magnetic }[z.type];
        if (!show) continue;
        if (z.rect) {
          const w = z.rect.x1 - z.rect.x0, d = z.rect.y1 - z.rect.y0, c = G.center(z.rect);
          const color = z.type === 'antenna_keepout' ? 0x22d3ee : 0x94a3b8;
          for (const sd of ['top', 'bottom']) {
            const m = new T.Mesh(this.box(w, d, 0.5), new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false }));
            m.userData.ownMat = true;
            m.position.copy(this.local(c.x, c.y, sd === 'top' ? th : -0.5));
            const edges = new T.LineSegments(new T.EdgesGeometry(this.box(w, d, 0.5)), new T.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
            edges.userData.own = true; edges.userData.ownMat = true;
            m.add(edges);
            this.board.add(m);
          }
        } else if (z.type === 'heat' || z.type === 'magnetic') {
          const m = new T.Mesh(new T.CylinderGeometry(z.r, z.r, 0.2, 48), new T.MeshBasicMaterial({ color: z.type === 'heat' ? 0xf97316 : 0xa855f7, transparent: true, opacity: 0.14, depthWrite: false }));
          m.userData.own = true; m.userData.ownMat = true;
          m.position.copy(this.local(z.cx, z.cy, th + 0.1));
          this.board.add(m);
        }
      }
      // 拥挤热力图：柱高表示拥挤程度
      if (app.layers.congestion && app.ev) {
        const grid = app.ev.metrics.congestion.grid;
        const cells = [];
        for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) { const v = grid.ratio[j * grid.nx + i]; if (v >= 0.08) cells.push([i, j, v]); }
        if (cells.length) {
          const inst = new T.InstancedMesh(new T.BoxGeometry(grid.cell * 0.92, 1, grid.cell * 0.92), new T.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }), cells.length);
          inst.userData.own = true; inst.userData.ownMat = true;
          const m4 = new T.Matrix4(), col = new T.Color();
          cells.forEach(([i, j, v], k) => {
            const hgt = 0.2 + Math.min(1.5, v) * 1.6;
            const pos = this.local(grid.x0 + (i + 0.5) * grid.cell, grid.y0 + (j + 0.5) * grid.cell, th + hgt / 2);
            m4.makeScale(1, hgt, 1).setPosition(pos);
            inst.setMatrixAt(k, m4);
            col.setHSL((130 - 130 * Math.min(1, v / 1.2)) / 360, 0.85, 0.52);
            inst.setColorAt(k, col);
          });
          this.board.add(inst);
        }
      }
      this.buildLabels();
      this.updateHighlights();
      this.requestDraw();
    }
    buildLabels() {
      this.labels.innerHTML = '';
      this.labelEls = new Map();
      for (const x of [...this.app.p.parts, ...this.app.p.satellites]) {
        const el = document.createElement('span');
        el.className = 'label3d';
        el.textContent = M.faceName(x);
        el.dataset.ref = x.ref;
        this.labels.append(el);
        this.labelEls.set(x, el);
      }
    }
    /** 选中、关联、问题、关键网络超长的轮廓：在器件四周画一圈发光的线框。 */
    updateHighlights() {
      const T = this.T, app = this.app;
      if (this.hlGroup) { this.board.remove(this.hlGroup); this.hlGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
      this.hlGroup = new T.Group();
      const outline = (ref, color, pad, opacity) => {
        const it = M.itemByRef(app.p, ref);
        if (!it || !it.placed) return;
        const isSat = !!M.SAT_KINDS[it.kind];
        const r = isSat ? M.satFootprint(it) : M.footprint(it);
        const c = G.center(r), w = r.x1 - r.x0 + 2 * pad, d = r.y1 - r.y0 + 2 * pad;
        const side = it.placed.side;
        const geo = new T.EdgesGeometry(new T.PlaneGeometry(w, d));
        const line = new T.LineSegments(geo, new T.LineBasicMaterial({ color, transparent: true, opacity: opacity ?? 1 }));
        line.rotation.x = -Math.PI / 2;
        line.position.copy(this.local(c.x, c.y, side === 'bottom' ? -0.03 : this.thick + 0.03));
        this.hlGroup.add(line);
      };
      const ref = (app.drag && app.drag.kind === 'part' && app.drag.ref) || (app.sel && app.sel.type === 'part' && app.sel.ref);
      if (ref) for (const [r, classes] of M.connectedParts(app.p, ref)) {
        const cls = ['rf', 'switch_node', 'high_speed', 'power', 'clock', 'analog', 'bus', 'misc'].find((c) => classes.has(c));
        outline(r, M.NET_CLASSES[cls].color, 0.35);
      }
      if (app.ev) for (const it of app.ev.metrics.critical.items) if (it.kind === 'net' && !it.ok) it.refs.forEach((r) => outline(r, '#f59e0b', 0.5));
      if (app.focusIssue) app.focusIssue.refs.forEach((r) => outline(r, ['P0', 'P1'].includes(app.focusIssue.severity) ? '#ef4444' : '#f59e0b', 0.6));
      if (app.sel && !app.drag) { outline(app.sel.ref, '#38bdf8', 0.25); outline(app.sel.ref, '#38bdf8', 0.45, 0.4); }
      this.board.add(this.hlGroup);
      this.requestDraw();
    }

    // ---------- 每帧 ----------
    draw() {
      const T = this.T, app = this.app, p = app.p;
      if (!p) return;
      const now = performance.now();
      for (const a of this.anims) {
        if (a.type === 'view') {
          const t = Math.min(1, (now - a.t0) / a.dur), e = easeOut(t);
          this.s = a.from.s + (a.to.s - a.from.s) * e;
          this.target.lerpVectors(a.from.target, a.to.target, e);
          if (t >= 1) { a.done = true; if (a.after) a.after(); }
        } else if (a.type === 'flip') {
          const t = Math.min(1, (now - a.t0) / a.dur);
          this.board.rotation.z = a.from + (a.to - a.from) * easeOut(t);
          if (t >= 1) a.done = true;
        }
      }
      this.updateCamera();
      this.updateDynamic(now);
      // 落地回弹与卫星飞落
      for (const a of this.anims) {
        if (a.type === 'drop') {
          const g = this.partGroups.get(a.ref), part = M.partByRef(p, a.ref);
          const t = Math.min(1, (now - a.t0) / 220);
          if (g && part && part.placed) this.pose(g, part.placed, (1 - easeOutBack(t)) * LIFT * 0.4);
          if (t >= 1) a.done = true;
        } else if (a.type === 'pop') {
          const g = this.satMeshes.get(a.ref) || this.partGroups.get(a.ref), s = M.itemByRef(p, a.ref);
          const t = Math.max(0, Math.min(1, (now - a.t0 - (a.delay || 0)) / (a.dur || 300)));
          if (g && s && s.placed) {
            for (const child of g.children) if (child.name.startsWith('pad:')) child.visible = t>=1;
            if (a.from) {
              const e = easeOut(t);
              const pl = { ...s.placed, x:a.from.x+(s.placed.x-a.from.x)*e, y:a.from.y+(s.placed.y-a.from.y)*e,
                rot:LP.render2d.landingRotation(a.from.rot,s.placed.rot,e) };
              const height = (a.orbit ? (a.from.lift ?? LIFT * 0.8) : 1) * (1 - e) + Math.sin(Math.PI * t) * 0.6;
              this.pose(g, pl, height);
              this.movingFaces.set(s.ref, {...pl, lift:height});
            } else { const k = 0.3 + 0.7 * easeOutBack(t); g.scale.set(k * Math.sign(g.scale.x || 1), k * Math.sign(g.scale.y || 1), k); }
            if (t >= 1) { this.pose(g, s.placed, 0); a.done = true; }
          } else if (t >= 1) a.done = true;
        }
      }
      this.renderer.render(this.scene, this.camera);
      this.placeLabels();
      this.anims = this.anims.filter((a) => !a.done);
      const orbiting = app.drag && app.drag.visible && app.drag.kind === 'part' && !app.reducedMotion;
      if (this.anims.length || orbiting) this.requestDraw();
      app.emit('drawn');
    }
    /** 拖动中的器件、它的环绕卫星和落点轮廓。 */
    updateDynamic(now) {
      const T = this.T, app = this.app, p = app.p, d = app.drag;
      this.dyn.clear();
      this.movingFaces = new Map();
      this.orbitPos = null;
      const sats = d?.visible && d.kind === 'part' && app.layers.sats ? LP.render2d.orbitSats(p,d.ref) : [];
      const carried = new Set(sats.map(s => s.ref));
      for (const [ref, g] of this.partGroups) {
        g.visible = !(d?.visible && d.ref === ref) && !carried.has(ref) && (app.layers.sats || !g.userData.satellite);
      }
      for (const [ref, g] of this.satMeshes) g.visible = app.layers.sats && !carried.has(ref) && !(d?.visible && d.ref === ref);
      if (!d || !d.visible || !d.pl) { this.dragModels = null; return; }
      if (!this.dragModels || this.dragModels.drag !== d) this.dragModels = {drag:d, models:new Map()};
      const floatingModel = item => {
        const cache = this.dragModels.models;
        if (!cache.has(item.ref)) cache.set(item.ref,item.kind ? this.satModel(item,true) : this.partModel(item,true));
        return cache.get(item.ref);
      };
      const item = M.itemByRef(p, d.ref);
      const isSat = d.kind === 'sat';
      const raw = { ...d.pl, x: (d.raw || d.pl).x, y: (d.raw || d.pl).y };
      // 落点轮廓
      const fp = isSat ? M.satFootprint(item, d.pl) : M.footprint(item, d.pl);
      const color = d.status === 'bad' ? 0xef4444 : d.status === 'warn' ? 0xf59e0b : 0x14b8a6;
      const c = G.center(fp);
      const width = fp.x1-fp.x0, depth = fp.y1-fp.y0;
      if (!this.dragPlane) {
        this.dragPlane = new T.PlaneGeometry(1,1);
        this.dragEdges = new T.EdgesGeometry(this.dragPlane);
        this.orbitRing = new T.BufferGeometry().setFromPoints(
          new T.EllipseCurve(0,0,1,1,0,Math.PI*2).getPoints(64).map(q=>new T.Vector3(q.x,0,-q.y)));
      }
      const fill = new T.Mesh(this.dragPlane, this.mat('drop:'+color, () => new T.MeshBasicMaterial({color,transparent:true,opacity:0.25,depthWrite:false,side:T.DoubleSide})));
      fill.rotation.x = -Math.PI / 2;
      fill.scale.set(width,depth,1);
      fill.position.copy(this.local(c.x,c.y,d.pl.side==='bottom' ? -0.05 : this.thick+0.05));
      const edge = new T.LineSegments(this.dragEdges, this.mat('drop-edge:'+color,()=>new T.LineBasicMaterial({color})));
      edge.rotation.copy(fill.rotation); edge.position.copy(fill.position); edge.scale.copy(fill.scale);
      this.dyn.add(fill,edge);
      const model = floatingModel(item);
      const bob = app.reducedMotion ? 0 : Math.sin(now / 260) * 0.25;
      this.pose(model, raw, LIFT + bob);
      model.scale.multiplyScalar(1.04);
      this.dyn.add(model);
      this.movingFaces.set(item.ref,{...raw,lift:LIFT+bob});
      // 卫星环绕
      this.orbitPos = {};
      if (sats.length) {
          const pos = LP.render2d.orbitPositions(item, raw, sats, app.reducedMotion ? 0 : now);
          for (const ring of pos.rings) {
            if (!ring) continue;
            const line = new T.LineLoop(this.orbitRing,this.mat('orbit-guide',()=>new T.LineBasicMaterial({color:0xffffff,transparent:true,opacity:0.28})));
            line.scale.set(ring.rx,1,ring.ry);
            line.position.copy(this.local(raw.x, raw.y, raw.side === 'bottom' ? -(LIFT + 0.6) : this.thick + LIFT + 0.6));
            this.dyn.add(line);
          }
          for (const q of pos.items) {
            const m = floatingModel(q.sat);
            const h = LIFT + 0.6 + q.depth * 0.6 + bob;
            const pose = { x:q.x, y:q.y, rot:q.rot, side:raw.side, lift:h };
            this.orbitPos[q.sat.ref] = pose;
            this.movingFaces.set(q.sat.ref, pose);
            this.pose(m, pose, h);
            m.rotation.x = 0.25 * Math.cos(q.ang);
            this.dyn.add(m);
          }
      }
    }
    placeLabels() {
      if (!this.labelEls) return;
      const app = this.app;
      for (const [part, el] of this.labelEls) {
        const ref = part.ref;
        const moving = this.movingFaces?.get(ref);
        const pose = moving || part.placed;
        const hidden = !pose || (!moving && part.kind && !part._active) ||
          (!app.layers.sats && (part.kind || M.placementOwner(part))) || !this.onSide(part.through ? 'both' : pose.side);
        if (hidden) { el.style.display = 'none'; continue; }
        const pkg = M.passiveGeometry(part);
        const r = this.screenRect(M.faceRect(part,pose), (moving?.lift || 0) + (pkg?.height || part.z || 0.6) * HZ + (pkg?.pads.length ? 0.025 : 0), true);
        if (Math.min(r.w, r.h) < 16) { el.style.display = 'none'; continue; }
        el.style.display = '';
        el.style.maxWidth = Math.max(0, r.w - 3) + 'px';
        el.style.transform = `translate(${Math.round(r.x + r.w / 2)}px, ${Math.round(r.y + r.h / 2)}px) translate(-50%, -50%)`;
      }
    }
  }

  LP.three = loader;
  LP.Renderer3D = Renderer3D;
})(globalThis.LP = globalThis.LP || {});
