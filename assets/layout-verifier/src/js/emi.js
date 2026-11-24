// 电磁：干扰源对板上各处的影响（受扰地图）与电源/地平面腔体的谐振模态。
(function (LP) {
  'use strict';
  const C = LP.vconst, V = LP.vmodel, R = LP.routes, SV = LP.solver, F = LP.vrules, CU = LP.current;

  /** 网络的几何：阶段 R 用真实导线（opts.netGeom），阶段 P 用候选路径的最可能一条。 */
  function netPoints(st, net, opts) {
    if (opts.netGeom && opts.netGeom[net.name]) return opts.netGeom[net.name];
    const pts = [];
    const pins = net.pins.map(([ref, pin]) => V.pinPoint(st.p, ref, pin)).filter(Boolean);
    for (let k = 1; k < pins.length; k++) {
      const base = CU.routingBase(st, pins[0].side, net.pins.map((x) => x[0]), net.class === 'rf');
      const e = R.ensemble(st.g, base, pins[0], pins[k], { n: 1, seed: 3 });
      if (e) for (const q of R.toPolyline(st.g, e.best, 2)) pts.push({ x: q[0], y: q[1], side: pins[0].side });
      else pts.push({ x: pins[0].x, y: pins[0].y, side: pins[0].side }, { x: pins[k].x, y: pins[k].y, side: pins[k].side });
    }
    return pts;
  }

  /** 干扰源列表：每个源是若干点（mm）、所在面、总强度（dB，相对天线）。 */
  function emitters(st, opts = {}) {
    const { p, v } = st, out = [];
    v.emitters.forEach((e, k) => {
      let pts = [], label = e.part || e.net;
      if (e.part) {
        const b = V.bodyOf(p, e.part);
        if (!b) return;
        pts = [{ x: (b.rect.x0 + b.rect.x1) / 2, y: (b.rect.y0 + b.rect.y1) / 2, side: b.side }];
      } else if (e.net) {
        const net = p.nets.find((n) => n.name === e.net);
        if (!net) return;
        pts = netPoints(st, net, opts);
      }
      if (!pts.length) return;
      let len = 0; for (let q = 1; q < pts.length; q++) len += Math.hypot(pts[q].x - pts[q - 1].x, pts[q].y - pts[q - 1].y);
      const level = e.level + (pts.length > 1 ? 10 * Math.log10(Math.max(0.3, len / 10)) : 0);
      const step = Math.max(1, Math.ceil(pts.length / 40));
      const sp = pts.filter((_, q) => q % step === 0);
      let dir = null;
      if (e.kind === 'antenna') {
        const bb = st.g, cx = bb.x0 + bb.w / 2, cy = bb.y0 + bb.h / 2;
        const d = Math.hypot(sp[0].x - cx, sp[0].y - cy) || 1;
        dir = { x: (sp[0].x - cx) / d, y: (sp[0].y - cy) / d };
      }
      out.push({ id: k, label, kind: e.kind, f: e.f_hz || 0, level, pts: sp, len, dir, side: sp[0].side || 'top' });
    });
    return out;
  }

  /** 一个源对一个格子的线性功率贡献。 */
  function contrib(st, em, x, y, side, shielded, gndPlaneAt) {
    let s = 0;
    const per = Math.pow(10, em.level / 10) / em.pts.length;
    const lamAir = em.f > 0 ? (C.C0 / em.f) * 1000 : 1e9, rf = Math.max(2, lamAir / (2 * Math.PI)), r0 = 1;
    for (const q of em.pts) {
      const r = Math.hypot(x - q.x, y - q.y);
      let gk = r <= rf ? (r0 * r0) / (r0 * r0 + r * r) : ((r0 * r0) / (r0 * r0 + rf * rf)) * (rf / r);
      if (em.dir) { const dx = x - q.x, dy = y - q.y; if (dx * em.dir.x + dy * em.dir.y < 0) gk *= 0.25; }
      s += per * gk;
    }
    if ((em.side || 'top') !== side && gndPlaneAt) s *= 1e-3;      // 隔着完整地平面 −30 dB
    if (shielded) s *= 1e-2;                                        // 屏蔽罩 −20 dB
    return s;
  }

  /**
   * 受扰地图。opts: {side:'top'|'bottom', only: 源 id（只看一个源）, netGeom(阶段 R)}
   * 返回 {map(dB, NaN 板外), emitters, victims, findings}
   */
  function analyze(st, opts = {}) {
    const { g, v, p } = st, N = g.nx * g.ny;
    const ems = emitters(st, opts);
    const hasGnd = v.stackup.planes.some((q) => q.net === st.gnd);
    const shieldRects = p.parts.filter((x) => x.placed && x.shield).map((x) => LP.model.footprint(x));
    const inShield = (x, y) => shieldRects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    const step = Math.max(1, Math.round(0.4 / g.cell));             // 粗算后插值，控制计算量
    const maps = {};
    for (const side of ['top', 'bottom']) {
      const m = new Float32Array(N).fill(NaN);
      for (let j = 0; j < g.ny; j += step) for (let i = 0; i < g.nx; i += step) {
        const x = g.cx(i), y = g.cy(j), sh = inShield(x, y);
        let s = 0;
        for (const em of ems) if (opts.only == null || opts.only === em.id) s += contrib(st, em, x, y, side, sh, hasGnd && st.planeMask[j * g.nx + i]);
        const db = 10 * Math.log10(s + 1e-12);
        for (let jj = j; jj < Math.min(g.ny, j + step); jj++) for (let ii = i; ii < Math.min(g.nx, i + step); ii++) { const c = jj * g.nx + ii; if (g.inBoard[c]) m[c] = db; }
      }
      maps[side] = m;
    }
    const r7 = F.rule(v, 'VF-07');
    const victims = [], findings = [];
    v.victims.forEach((vic, k) => {
      let pts = [], label = vic.part || vic.net, side = 'top';
      if (vic.part) {
        const b = V.bodyOf(p, vic.part);
        if (!b) return;
        side = b.side;
        V.fillRectFn(g, b.rect, (c, x, y) => pts.push({ x, y, c }));
      } else if (vic.net) {
        const net = p.nets.find((n) => n.name === vic.net);
        if (!net) return;
        pts = netPoints(st, net, opts).map((q) => ({ ...q, c: g.at(q.x, q.y) }));
        side = (pts[0] && pts[0].side) || 'top';
      }
      if (!pts.length) return;
      const m = maps[side === 'bottom' ? 'bottom' : 'top'];
      let lv = -Infinity, at = pts[0], exposure = 0;
      for (let q = 0; q < pts.length; q++) {
        const val = m[pts[q].c];
        if (val > lv) { lv = val; at = pts[q]; }
        if (vic.net && q && val > r7.mid_db) exposure += Math.hypot(pts[q].x - pts[q - 1].x, pts[q].y - pts[q - 1].y);
      }
      if (vic.net) lv += 10 * Math.log10(1 + exposure / 5);
      const tops = ems.map((em) => ({ label: em.label, kind: em.kind, db: 10 * Math.log10(contrib(st, em, at.x, at.y, side, inShield(at.x, at.y), hasGnd && st.planeMask[at.c]) + 1e-12) }))
        .sort((a, b) => b.db - a.db).slice(0, 2);
      const grade = lv >= r7.high_db ? 'high' : lv >= r7.mid_db ? 'mid' : 'low';
      victims.push({ id: k, label, kind: vic.kind, level: +lv.toFixed(1), grade, x: at.x, y: at.y, top: tops.map((t) => ({ ...t, db: +t.db.toFixed(1) })) });
      if (grade === 'high') {
        findings.push(F.finding(v, 'VF-07', { obj: label, value: +lv.toFixed(1), where: { x: at.x, y: at.y },
          title: `${label} 受扰等级高（${lv.toFixed(0)} dB，相对天线），主要来自 ${tops.map((t) => t.label).join('、')}`,
          advice: '拉开与干扰源的距离、换到板的另一面（中间隔着完整地平面），或加屏蔽罩', assume: '近场按 1/(1+(r/1 mm)²) 衰减；隔整层地 −30 dB；屏蔽罩 −20 dB' }));
      }
    });
    return { maps, emitters: ems.map((e) => ({ id: e.id, label: e.label, kind: e.kind, level: +e.level.toFixed(1), f: e.f, side: e.side, pts: e.pts.map((q) => [q.x, q.y]), dir: e.dir })), victims, findings };
  }

  /**
   * 平面谐振：在平面形状上求最低几个模态。opts.mask(阶段 R 的实际平面形状，按 opts.grid)。
   * 返回 {grid, modes:[{f, phi}], findings} 或 {na: 原因}
   */
  function modes(st, opts = {}) {
    const { v, p } = st;
    if ((st.layers || 2) < 4 || !v.stackup.planes.length) return { na: '2 层板没有电源/地平面对，不适用' };
    const g = opts.grid || V.makeGrid(p.board.outline, 64);
    let mask = opts.mask;
    if (!mask) {
      mask = new Uint8Array(g.nx * g.ny);
      const holes = new Uint8Array(g.nx * g.ny), ant = new Uint8Array(g.nx * g.ny);
      for (const h of p.board.holes || []) V.fillDisk(g, holes, h.x, h.y, h.d / 2 + 0.3);
      for (const a of st.antRects) V.fillRect(g, ant, a.rect);
      for (const k of v.plane_cuts || []) V.fillRect(g, ant, { x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h });
      for (let c = 0; c < mask.length; c++) mask[c] = g.inBoard[c] && !holes[c] && !ant[c] ? 1 : 0;
    }
    const ms = SV.modes({ nx: g.nx, ny: g.ny, mask, nModes: 4, iters: 30 });
    const er = v.stackup.er || C.FR4_ER;
    const a = g.cell / 1000;
    const list = ms.map((m) => ({ f: (Math.sqrt(Math.max(0, m.lambda)) / a) * C.C0 / (2 * Math.PI * Math.sqrt(er)), phi: m.phi }));
    // 工作频率：射频与时钟（含前 5 次谐波）
    const ops = [];
    for (const e of v.emitters) {
      if (!(e.f_hz > 0)) continue;
      if (e.kind === 'clock') for (let h = 1; h <= 5; h++) ops.push({ f: e.f_hz * h, label: `${e.net || e.part} 第 ${h} 次谐波` });
      else if (e.kind === 'antenna' || e.kind === 'rf_trace') ops.push({ f: e.f_hz, label: `${e.net || e.part}` });
    }
    const r10 = F.rule(v, 'VF-10');
    const findings = [];
    const em = emitters(st, {});
    list.forEach((m, k) => {
      const near = ops.filter((o) => Math.abs(m.f - o.f) / o.f < r10.band);
      m.near = near.map((o) => o.label);
      if (!near.length) return;
      const hot = [];
      const at = (x, y) => { const c = g.at(x, y); return Math.abs(m.phi[c]) || 0; };
      for (const e of em) for (const q of e.pts) if (at(q.x, q.y) > r10.antinode) { hot.push(e.label); break; }
      for (const vic of v.victims) {
        const b = vic.part ? V.bodyOf(p, vic.part) : null;
        if (b && at((b.rect.x0 + b.rect.x1) / 2, (b.rect.y0 + b.rect.y1) / 2) > r10.antinode) hot.push(vic.part);
      }
      if (hot.length) {
        let mx = 0, mc = 0; for (let c = 0; c < m.phi.length; c++) if (Math.abs(m.phi[c]) > mx) { mx = Math.abs(m.phi[c]); mc = c; }
        findings.push(F.finding(v, 'VF-10', { value: +(m.f / 1e9).toFixed(3), where: { x: g.cx(mc % g.nx), y: g.cy((mc / g.nx) | 0) },
          title: `平面第 ${k + 1} 模态约 ${(m.f / 1e9).toFixed(2)} GHz，接近 ${near[0].label}；${[...new Set(hot)].join('、')} 位于波腹`,
          advice: '把干扰源或敏感器件挪到节线附近，或在波腹处加去耦电容、加地过孔', assume: `平面腔体按开路边界，εr ${er}` }));
      }
    });
    return { grid: { nx: g.nx, ny: g.ny, cell: g.cell, x0: g.x0, y0: g.y0 }, mask, modes: list.map((m) => ({ f: m.f, phi: m.phi, near: m.near })), findings };
  }

  LP.emi = { analyze, modes, emitters };
})(globalThis.LP = globalThis.LP || {});
