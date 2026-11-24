// 验证器的数据模型：读布局规划器导出的项目 JSON，补全 verify 块的默认值，建立求解网格和各类 mask。
(function (LP) {
  'use strict';
  const G = LP.geometry, M = LP.model, C = LP.vconst;

  const ROLE_CURRENT_MA = { soc_rf: 6, mcu: 5, rf_module: 30, imu: 1, magnetometer: 0.5, temp_humidity: 0.3, barometer: 0.5, microphone: 0.6, optical: 2, flash: 4, led: 5, motor_driver: 200, other: 2 };
  const SOURCE_ROLES = ['battery', 'ldo', 'dcdc', 'charger', 'connector'];
  const PRIORITY_SOURCE = { ldo: 0, dcdc: 1, charger: 2, battery: 3, connector: 4 };

  const isGndName = (s) => /^(A|D|P|S)?GND\w*$|^VSS\w*$/i.test(s || '');

  /** 按网络类别分组：电源与地 / 模拟 / 数字 / 射频（与铜皮数据包一致）。 */
  function netGroup(cls, name) {
    if (isGndName(name) || cls === 'power' || cls === 'switch_node') return 'power';
    if (cls === 'rf') return 'rf';
    if (cls === 'analog') return 'analog';
    return 'digital';
  }

  /**
   * 补全 verify 块。返回 {v, defaults}，defaults 列出哪些字段用了默认值（界面上要显示）。
   */
  function fillVerify(p) {
    const raw = p.verify || {};
    const v = JSON.parse(JSON.stringify(raw));
    const defaults = [];
    v.gnd_net = v.gnd_net || 'GND';
    const powerNets = p.nets.filter((n) => n.class === 'power' && !isGndName(n.name));
    const partOf = (ref) => M.partByRef(p, ref);

    if (!Array.isArray(v.sources) || !v.sources.length) {
      v.sources = [];
      for (const n of powerNets) {
        const cands = n.pins.map(([ref, pin]) => ({ ref, pin, pt: partOf(ref) })).filter((c) => c.pt && SOURCE_ROLES.includes(c.pt.role));
        cands.sort((a, b) => (PRIORITY_SOURCE[a.pt.role] ?? 9) - (PRIORITY_SOURCE[b.pt.role] ?? 9));
        if (cands.length) v.sources.push({ net: n.name, part: cands[0].ref, pin: cands[0].pin, v: cands[0].pt.role === 'battery' ? 3.0 : 3.3, _default: true });
      }
      if (v.sources.length) defaults.push('sources');
    }
    if (!Array.isArray(v.loads) || !v.loads.length) {
      v.loads = [];
      const srcRefs = new Set(v.sources.map((s) => s.part + '/' + s.net));
      for (const n of powerNets) for (const [ref, pin] of n.pins) {
        const pt = partOf(ref);
        if (!pt || srcRefs.has(ref + '/' + n.name) || SOURCE_ROLES.includes(pt.role)) continue;
        const kind = ['soc_rf', 'rf_module'].includes(pt.role) ? 'rf' : (pt.role === 'dcdc' || pt.role === 'motor_driver' ? 'switching' : 'dc');
        const ia = ROLE_CURRENT_MA[pt.role] ?? 2;
        v.loads.push({ part: ref, pin, net: n.name, i_avg_ma: ia, i_peak_ma: ia * 3, kind, f_hz: kind === 'rf' ? 2.4e9 : (kind === 'switching' ? 2e6 : 0), _default: true });
      }
      if (v.loads.length) defaults.push('loads');
    }
    for (const l of v.loads) {
      l.i_peak_ma = l.i_peak_ma ?? (l.i_avg_ma || 0) * 3;
      l.kind = l.kind || 'dc';
      if (!l.net) { const n = powerNets.find((nn) => nn.pins.some(([r, q]) => r === l.part && q === l.pin)); l.net = n ? n.name : (powerNets[0] && powerNets[0].name); }
    }
    const srcV = (net) => { const s = v.sources.find((x) => x.net === net); return s ? s.v || 3.3 : 3.3; };

    if (!Array.isArray(v.thermal)) {
      v.thermal = [];
      for (const pt of p.parts) {
        if (!pt.placed) continue;
        let pw = (pt.heat_mw || 0) / 1000;
        if (!pw) for (const l of v.loads) if (l.part === pt.ref) pw += (srcV(l.net) * (l.i_avg_ma || 0)) / 1000;
        if (pw > 0) v.thermal.push({ part: pt.ref, p_w: +pw.toFixed(4), _default: true });
      }
      defaults.push('thermal');
    }
    for (const t of v.thermal) {
      const pt = partOf(t.part);
      t.theta_jb = t.theta_jb ?? C.THETA_JB[(pt && pt.shape) || 'default'] ?? C.THETA_JB.default;
      t.tj_max = t.tj_max ?? C.TJ_MAX;
    }

    if (!Array.isArray(v.emitters)) {
      v.emitters = [];
      for (const pt of p.parts) if (pt.placed && pt.role === 'antenna') v.emitters.push({ part: pt.ref, kind: 'antenna', f_hz: 2.4e9 });
      for (const n of p.nets) {
        if (n.class === 'rf') v.emitters.push({ net: n.name, kind: 'rf_trace', f_hz: 2.4e9 });
        else if (n.class === 'switch_node') v.emitters.push({ net: n.name, kind: 'switch_node', f_hz: 2e6 });
        else if (n.class === 'clock') v.emitters.push({ net: n.name, kind: 'clock', f_hz: n.f_hz || 32e6 });
      }
      for (const s of p.satellites) if (s.placed && s.kind === 'dcdc_inductor') v.emitters.push({ part: s.ref, kind: 'inductor', f_hz: 2e6 });
      for (const pt of p.parts) if (pt.placed && pt.role === 'dcdc') v.emitters.push({ part: pt.ref, kind: 'switch_node', f_hz: 2e6 });
      defaults.push('emitters');
    }
    const LEVEL = { antenna: 0, rf_trace: -10, hv_pulse: -10, switch_node: -15, inductor: -18, clock: -25 };
    for (const e of v.emitters) e.level = e.level ?? LEVEL[e.kind] ?? -25;

    if (!Array.isArray(v.victims)) {
      v.victims = [];
      for (const pt of p.parts) if (pt.placed && C.SENSITIVE_ROLES.includes(pt.role) && pt.role !== 'battery') v.victims.push({ part: pt.ref, kind: pt.role });
      for (const s of p.satellites) if (s.placed && C.SENSITIVE_SATS.includes(s.kind)) v.victims.push({ part: s.ref, kind: s.kind });
      for (const n of p.nets) if (n.class === 'analog') v.victims.push({ net: n.name, kind: 'analog' });
      defaults.push('victims');
    }

    const L = p.board.layers || 2;
    if (!v.stackup) {
      const mainPwr = (v.sources[0] && v.sources[0].net) || (powerNets[0] && powerNets[0].name);
      const planes = L >= 6 ? [{ layer: 1, net: v.gnd_net }, { layer: 2, net: mainPwr }, { layer: L - 2, net: v.gnd_net }]
        : L >= 4 ? [{ layer: 1, net: v.gnd_net }, { layer: 2, net: mainPwr }] : [];
      v.stackup = { planes: planes.filter((x) => x.net), cu_oz: Array.from({ length: L }, (_, i) => (i === 0 || i === L - 1 ? 1 : 0.5)), h_mm: L >= 4 ? 0.2 : p.board.thickness || 1.6, er: C.FR4_ER };
      defaults.push('stackup');
    }
    v.stackup.cu_oz = v.stackup.cu_oz || Array.from({ length: L }, () => 1);
    v.stackup.planes = v.stackup.planes || [];
    v.stackup.h_mm = v.stackup.h_mm ?? 0.2;
    v.stackup.er = v.stackup.er ?? C.FR4_ER;
    v.env = { ta_c: 25, sealed_k_per_w: 0, airflow_m_s: 0, contact_limit_c: null, ...(v.env || {}) };
    if (!raw.env) defaults.push('env');
    v.rules = v.rules || {};
    return { v, defaults };
  }

  /** 求解网格。maxCells：长边格数上限。 */
  function makeGrid(outline, maxCells, minCell = 0.1, fixed = null) {
    const bb = G.outlineBBox(outline);
    const W = bb.x1 - bb.x0, H = bb.y1 - bb.y0;
    // fixed：阶段 R 沿用铜皮数据包的网格（格子大小与原点），保证逐格对齐
    const cell = fixed ? fixed.cell : Math.max(minCell, Math.max(W, H) / maxCells);
    const ox = fixed && fixed.x0 != null ? fixed.x0 : bb.x0, oy = fixed && fixed.y0 != null ? fixed.y0 : bb.y0;
    const nx = fixed && fixed.nx ? fixed.nx : Math.max(4, Math.ceil(W / cell)), ny = fixed && fixed.ny ? fixed.ny : Math.max(4, Math.ceil(H / cell));
    const g = { nx, ny, cell, x0: ox, y0: oy, w: W, h: H };
    g.cx = (i) => g.x0 + (i + 0.5) * cell;
    g.cy = (j) => g.y0 + (j + 0.5) * cell;
    g.at = (x, y) => {
      const i = Math.min(nx - 1, Math.max(0, Math.floor((x - g.x0) / cell)));
      const j = Math.min(ny - 1, Math.max(0, Math.floor((y - g.y0) / cell)));
      return j * nx + i;
    };
    const poly = G.outlinePolygon(outline);
    g.inBoard = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) g.inBoard[j * nx + i] = G.pointInPolygon({ x: g.cx(i), y: g.cy(j) }, poly) ? 1 : 0;
    return g;
  }
  /** 把矩形（mm）画进 mask。 */
  function fillRect(g, mask, r, val = 1) {
    const i0 = Math.max(0, Math.floor((r.x0 - g.x0) / g.cell)), i1 = Math.min(g.nx - 1, Math.ceil((r.x1 - g.x0) / g.cell) - 1);
    const j0 = Math.max(0, Math.floor((r.y0 - g.y0) / g.cell)), j1 = Math.min(g.ny - 1, Math.ceil((r.y1 - g.y0) / g.cell) - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) mask[j * g.nx + i] = val;
  }
  function fillDisk(g, mask, x, y, r, val = 1) {
    fillRectFn(g, { x0: x - r, y0: y - r, x1: x + r, y1: y + r }, (c, cx, cy) => { if ((cx - x) ** 2 + (cy - y) ** 2 <= r * r) mask[c] = val; });
  }
  function fillRectFn(g, r, fn) {
    const i0 = Math.max(0, Math.floor((r.x0 - g.x0) / g.cell)), i1 = Math.min(g.nx - 1, Math.ceil((r.x1 - g.x0) / g.cell) - 1);
    const j0 = Math.max(0, Math.floor((r.y0 - g.y0) / g.cell)), j1 = Math.min(g.ny - 1, Math.ceil((r.y1 - g.y0) / g.cell) - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * g.nx + i, g.cx(i), g.cy(j));
  }

  /** 天线净空区（与布局规划器同一算法：馈点一侧不留，其余三边各 clearance mm）。 */
  function antennaKeepout(pt, clearance = 3) {
    const fp = M.footprint(pt);
    let local = pt.keepout;
    if (!local) {
      local = { N: clearance, E: clearance, S: clearance, W: clearance };
      const feed = pt.pins.find((q) => /feed/i.test(q.id)) || pt.pins[0];
      if (feed && feed.side !== 'C') local[feed.side] = 0;
    }
    const world = { N: 0, E: 0, S: 0, W: 0 };
    for (const s of ['N', 'E', 'S', 'W']) world[M.worldSide(s, pt.placed)] = local[s] || 0;
    return G.expandSides(fp, world);
  }

  /** 器件或卫星器件的世界坐标外形与所在面。 */
  function bodyOf(p, ref) {
    const pt = M.partByRef(p, ref);
    if (pt && pt.placed) return { rect: M.footprint(pt), side: pt.placed.side, part: pt };
    const s = M.satByRef(p, ref);
    if (s && s.placed) return { rect: M.satFootprint(s), side: s.placed.side || 'top', sat: s };
    return null;
  }

  /**
   * 引脚位置：pin 可以是规划器里的引脚组 id、'C'（中心焊盘）或 {side, pos}。
   * 卫星器件返回中心。返回 {x, y, nx, ny, side}。
   */
  function pinPoint(p, ref, pin) {
    const b = bodyOf(p, ref);
    if (!b) return null;
    if (b.sat) { const c = G.center(b.rect); return { x: c.x, y: c.y, nx: 0, ny: 0, side: b.side }; }
    const pt = b.part;
    if (typeof pin === 'string' && pin !== 'C') {
      const w = M.pinWorld(pt, pin);
      if (w) return { ...w, side: pt.placed.side };
    }
    const spec = pin && typeof pin === 'object' ? pin : { side: 'C', pos: 0.5 };
    if (spec.side === 'C') { const c = G.center(b.rect); return { x: c.x, y: c.y, nx: 0, ny: 0, side: pt.placed.side }; }
    const tmp = { ...pt, pins: [{ id: '__q', side: spec.side, pos: spec.pos ?? 0.5, count: 1 }] };
    const w = M.pinWorld(tmp, '__q');
    return { ...w, side: pt.placed.side };
  }
  /** 地脚的默认取法：有裸露焊盘的封装取中心，否则取供电脚对边的同一位置。 */
  function defaultGndPin(p, ref, supplyPin) {
    const pt = M.partByRef(p, ref);
    if (!pt) return 'C';
    if (C.PLANE_SHAPES.includes(pt.shape)) return 'C';
    const pin = pt.pins.find((q) => q.id === supplyPin);
    if (!pin || pin.side === 'C') return 'C';
    const opp = { N: 'S', S: 'N', E: 'W', W: 'E' }[pin.side];
    return { side: opp, pos: 1 - pin.pos };
  }

  /**
   * 读入项目（布局规划器导出的布局 JSON），建立验证器状态。
   * opts.maxCells：长边格数（阶段 P 默认 160）。
   */
  function prepare(raw, opts = {}) {
    const p = M.normalize(raw);
    for (const s of p.satellites) s._active = !!s.placed;
    const { v, defaults } = fillVerify(p);
    const g = makeGrid(p.board.outline, opts.maxCells || 160, 0.1, opts.grid || null);
    const N = g.nx * g.ny;
    const holes = new Uint8Array(N), antKeep = new Uint8Array(N), keep = new Uint8Array(N);
    for (const h of p.board.holes || []) fillDisk(g, holes, h.x, h.y, h.d / 2 + 0.3);
    const antRects = [];
    for (const pt of p.parts) if (pt.placed && pt.role === 'antenna') { const r = antennaKeepout(pt, 3); antRects.push({ ref: pt.ref, rect: r }); fillRect(g, antKeep, r); }
    for (const k of p.board.keepouts || []) fillRect(g, keep, { x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h });
    const body = { top: new Uint8Array(N), bottom: new Uint8Array(N) };
    const owner = { top: new Int16Array(N).fill(-1), bottom: new Int16Array(N).fill(-1) };
    const items = [];
    for (const pt of p.parts) if (pt.placed) items.push({ ref: pt.ref, rect: M.footprint(pt), side: pt.placed.side, kind: 'part', role: pt.role, shape: pt.shape });
    for (const s of p.satellites) if (s.placed) items.push({ ref: s.ref, rect: M.satFootprint(s), side: s.placed.side || 'top', kind: 'sat', satKind: s.kind, parent: s.parent });
    items.forEach((it, k) => { const sd = it.side === 'bottom' ? 'bottom' : 'top'; fillRectFn(g, it.rect, (c) => { body[sd][c] = 1; owner[sd][c] = k; }); });
    // 地平面上的开槽/分割（走线可以跨过，但下方没有参考平面）：verify.plane_cuts = [{x, y, w, h}]
    const cuts = new Uint8Array(N);
    for (const k of v.plane_cuts || []) fillRect(g, cuts, { x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h });
    const planeMask = new Uint8Array(N);
    for (let c = 0; c < N; c++) planeMask[c] = g.inBoard[c] && !holes[c] && !antKeep[c] && !cuts[c] ? 1 : 0;
    const L = p.board.layers || 2;
    const planeOf = (net) => { const q = v.stackup.planes.find((x) => x.net === net); return q ? q.layer : -1; };
    return { p, v, defaults, g, holes, antKeep, keep, cuts, antRects, body, owner, items, planeMask, layers: L, planeOf, gnd: v.gnd_net };
  }

  LP.vmodel = { fillVerify, makeGrid, fillRect, fillDisk, fillRectFn, antennaKeepout, bodyOf, pinPoint, defaultGndPin, prepare, netGroup, isGndName };
})(globalThis.LP = globalThis.LP || {});
