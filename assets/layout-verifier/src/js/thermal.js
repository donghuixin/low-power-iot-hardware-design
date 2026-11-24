// 温度：把板子当作会导热、两面向空气散热的薄片，解稳态温度；器件结温 = 板温 + 功耗 × 结到板热阻。
(function (LP) {
  'use strict';
  const C = LP.vconst, V = LP.vmodel, SV = LP.solver, F = LP.vrules;

  /**
   * 每格的铜覆盖率（每层一张）。阶段 P 用假设值；阶段 R 由 opts.coverage 传入真实覆盖率。
   */
  function assumedCoverage(st, stack) {
    const { g } = st, N = g.nx * g.ny, L = st.layers;
    const planeLayers = new Set(stack.planes.map((q) => q.layer));
    const cov = [];
    for (let l = 0; l < L; l++) {
      const a = new Float32Array(N);
      const isPlane = planeLayers.has(l), noPlanes = !stack.planes.length;
      for (let c = 0; c < N; c++) {
        if (!g.inBoard[c] || st.holes[c] || st.antKeep[c]) continue;
        a[c] = isPlane ? 0.9 : (noPlanes ? 0.4 : 0.3);
      }
      cov.push(a);
    }
    return cov;
  }

  /**
   * opts: {stackup, heatsinks:{ref: W/K}, copper:[{rect, cov}], ta, airflow, sealed_k_per_w, coverage(阶段 R), viaCount(阶段 R，每格过孔数)}
   */
  function analyze(st, opts = {}) {
    const { g, v, p } = st, N = g.nx * g.ny;
    const stack = opts.stackup || v.stackup;
    const env = { ...v.env, ...(opts.env || {}) };
    const a = g.cell / 1000;                                          // m
    const cov = opts.coverage || assumedCoverage(st, stack);
    for (const cb of opts.copper || []) for (const layer of cov) V.fillRectFn(g, cb.rect, (c) => { if (g.inBoard[c]) layer[c] = Math.max(layer[c], cb.cov ?? 0.9); });
    const thick = (p.board.thickness || 1.6) / 1000;
    const k = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      if (!g.inBoard[c]) continue;
      let s = C.FR4_K_INPLANE * thick;
      cov.forEach((layer, l) => { s += layer[c] * C.CU_K * ((stack.cu_oz[l] ?? 1) * C.OZ_UM * 1e-6); });
      k[c] = s;                                                        // W/K（方格片热导）
    }
    const hAir = C.H_NATURAL * (1 + 2.5 * Math.sqrt(Math.max(0, env.airflow_m_s || 0)));
    const hd = new Float64Array(N);
    for (let c = 0; c < N; c++) if (g.inBoard[c]) hd[c] = 2 * hAir * a * a;
    const sinks = opts.heatsinks || {};
    for (const [ref, hk] of Object.entries(sinks)) {
      const b = V.bodyOf(p, ref);
      if (!b || !(hk > 0)) continue;
      const cells = [];
      V.fillRectFn(g, b.rect, (c) => { if (g.inBoard[c]) cells.push(c); });
      for (const c of cells) hd[c] += hk / cells.length;
    }
    const src = [];
    let Ptot = 0;
    const partsOut = [];
    for (const t of v.thermal) {
      const b = V.bodyOf(p, t.part);
      if (!b || !(t.p_w > 0)) continue;
      const cells = [];
      V.fillRectFn(g, b.rect, (c) => { if (g.inBoard[c]) cells.push(c); });
      if (!cells.length) continue;
      for (const c of cells) src.push({ cell: c, q: t.p_w / cells.length });
      Ptot += t.p_w;
      partsOut.push({ ref: t.part, p: t.p_w, cells, theta: t.theta_jb, tjmax: t.tj_max, sink: sinks[t.part] || 0 });
    }
    const ta = (opts.ta ?? env.ta_c) + (env.sealed_k_per_w || 0) * Ptot;
    const mask = g.inBoard;
    const sol = SV.solveGrid({ nx: g.nx, ny: g.ny, mask, coeff: k, hdiag: hd, src, tol: 1e-6 });
    const T = new Float32Array(N).fill(NaN);
    let loss = 0, tmax = -Infinity, tmaxAt = -1;
    for (let c = 0; c < N; c++) {
      if (!mask[c]) continue;
      const th = sol.field[c];
      T[c] = ta + th;
      loss += hd[c] * th;
      if (T[c] > tmax) { tmax = T[c]; tmaxAt = c; }
    }
    const fl = SV.flux(g.nx, g.ny, sol.field, k, a);
    const lossMap = new Float32Array(N);
    for (let c = 0; c < N; c++) if (mask[c]) lossMap[c] = hd[c] * sol.field[c];
    const findings = [];
    const parts = partsOut.map((q) => {
      let s = 0, lo = Infinity, hi = -Infinity;
      for (const c of q.cells) { s += T[c]; lo = Math.min(lo, T[c]); hi = Math.max(hi, T[c]); }
      const tb = s / q.cells.length;
      const theta = q.sink ? q.theta * 0.6 : q.theta;
      const tj = tb + q.p * theta;
      return { ref: q.ref, p: q.p, tb: +tb.toFixed(1), tj: +tj.toFixed(1), tjmax: q.tjmax, grad: +(hi - lo).toFixed(1) };
    });
    const r11 = F.rule(v, 'VF-11');
    for (const q of parts) {
      const b = V.bodyOf(p, q.ref), c = b ? { x: (b.rect.x0 + b.rect.x1) / 2, y: (b.rect.y0 + b.rect.y1) / 2 } : null;
      if (q.tj > q.tjmax) findings.push(F.finding(v, 'VF-11', { sev: 'P0', obj: q.ref, value: q.tj, where: c, title: `${q.ref} 估算结温 ${q.tj} °C，超过上限 ${q.tjmax} °C`, advice: '加铜、加散热器或导热到外壳；把发热器件分散开', assume: `结到板热阻 ${partTheta(v, q.ref)} K/W，功耗 ${q.p} W` }));
      else if (q.tj > r11.warn_frac * q.tjmax) findings.push(F.finding(v, 'VF-11', { obj: q.ref, value: q.tj, where: c, title: `${q.ref} 估算结温 ${q.tj} °C，接近上限 ${q.tjmax} °C`, advice: '留出余量：加铜或加散热', assume: `结到板热阻 ${partTheta(v, q.ref)} K/W` }));
    }
    const r12 = F.rule(v, 'VF-12');
    const sens = new Set([...v.victims.filter((x) => x.part).map((x) => x.part), ...p.parts.filter((x) => x.placed && x.role === 'battery').map((x) => x.ref)]);
    for (const it of st.items) {
      if (!sens.has(it.ref)) continue;
      let s = 0, n = 0, lo = Infinity, hi = -Infinity;
      V.fillRectFn(g, it.rect, (c) => { if (mask[c]) { s += T[c]; n++; lo = Math.min(lo, T[c]); hi = Math.max(hi, T[c]); } });
      if (!n) continue;
      const rise = s / n - ta, grad = hi - lo;
      if (rise > r12.max_rise || grad > r12.max_grad) {
        findings.push(F.finding(v, 'VF-12', { obj: it.ref, value: +rise.toFixed(1), where: { x: (it.rect.x0 + it.rect.x1) / 2, y: (it.rect.y0 + it.rect.y1) / 2 },
          title: `怕热器件 ${it.ref} 处板温比环境高 ${rise.toFixed(1)} °C，器件两端温差 ${grad.toFixed(1)} °C`, advice: '挪离发热器件，或在两者之间开隔热槽、减少连通的铜', assume: '板温按稳态估计' }));
      }
    }
    if (env.contact_limit_c != null && tmax > env.contact_limit_c) {
      findings.push(F.finding(v, 'VF-13', { value: +tmax.toFixed(1), where: { x: g.cx(tmaxAt % g.nx), y: g.cy((tmaxAt / g.nx) | 0) },
        title: `板面最高约 ${tmax.toFixed(1)} °C，超过接触面限值 ${env.contact_limit_c} °C`, advice: '降功耗、加导热路径到外壳其他位置，或限制连续工作时间', assume: '以板面最高温度近似接触面温度' }));
    }
    return { T, ta, tmax, P: Ptot, loss, fx: fl.fx, fy: fl.fy, flux: fl.mag, lossMap, parts, findings, iters: sol.iters };
  }
  function partTheta(v, ref) { const t = v.thermal.find((x) => x.part === ref); return t ? t.theta_jb : '?'; }

  LP.thermal = { analyze, assumedCoverage };
})(globalThis.LP = globalThis.LP || {});
