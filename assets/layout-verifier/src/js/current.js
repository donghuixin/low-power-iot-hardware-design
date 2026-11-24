// 电流与回流路径。阶段 P：没有布线，用候选路径集合或整层平面求解来估计；阶段 R 见 copper.js。
(function (LP) {
  'use strict';
  const C = LP.vconst, V = LP.vmodel, R = LP.routes, SV = LP.solver, F = LP.vrules;

  /** 走线的基础代价：板外、孔、禁布区、同面器件本体不可走；端点器件本体可走但代价高。 */
  function routingBase(st, side, ownRefs, isRf) {
    const { g } = st, N = g.nx * g.ny, base = new Float32Array(N);
    const own = new Set(ownRefs || []);
    const sd = side === 'bottom' ? 'bottom' : 'top';
    for (let c = 0; c < N; c++) {
      if (!g.inBoard[c] || st.holes[c] || st.keep[c]) continue;
      if (st.antKeep[c] && !isRf) continue;
      if (st.body[sd][c]) {
        const it = st.items[st.owner[sd][c]];
        if (!it || !own.has(it.ref)) continue;
        base[c] = 3;
        continue;
      }
      base[c] = 1;
    }
    return base;
  }

  function nearestIn(g, mask, x, y) {
    const c0 = g.at(x, y);
    if (mask[c0]) return c0;
    const i0 = c0 % g.nx, j0 = (c0 / g.nx) | 0;
    for (let r = 1; r < Math.max(g.nx, g.ny); r++) {
      let best = -1, bd = Infinity;
      for (let j = j0 - r; j <= j0 + r; j++) for (let i = i0 - r; i <= i0 + r; i++) {
        if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
        if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue;
        const c = j * g.nx + i;
        if (!mask[c]) continue;
        const d = (i - i0) ** 2 + (j - j0) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** 在整块平面上求解 a→b 的电流分布。返回 {fx, fy, mag(A/m), drop(V，按 Gsq), ca, cb}。 */
  function planeSolve(g, mask, a, b, I, Gsq) {
    const ca = nearestIn(g, mask, a.x, a.y), cb = nearestIn(g, mask, b.x, b.y);
    if (ca < 0 || cb < 0 || ca === cb) return null;
    const r = SV.solveGrid({ nx: g.nx, ny: g.ny, mask, coeff: null, src: [{ cell: ca, q: I }], fixed: [cb], tol: 1e-5 });
    const fl = SV.flux(g.nx, g.ny, r.field, null, g.cell / 1000);
    return { ...fl, drop: r.field[ca] / Gsq, ca, cb };
  }

  /** 沿电流最大的方向走的一条代表路径（mm 折线）。 */
  function maxCurrentPath(g, mask, mag, ca, cb) {
    let mx = 0; for (let c = 0; c < mag.length; c++) if (mask[c] && mag[c] > mx) mx = mag[c];
    const cost = new Float32Array(mag.length);
    for (let c = 0; c < mag.length; c++) cost[c] = mask[c] ? 1 / (mag[c] / (mx || 1) + 0.03) : 0;
    const path = R.astar(g.nx, g.ny, cost, ca, cb);
    return path ? R.toPolyline(g, path, 2) : [];
  }

  /** 走线概率 → 显示用电流密度场（A/mm²）。 */
  function routeField(g, ens, I, wMm, tMm, sign = 1) {
    const N = g.nx * g.ny, sig = Math.max(0.6, 0.35 / g.cell);
    const fb = SV.blur(g.nx, g.ny, ens.f, sig, null), dxb = SV.blur(g.nx, g.ny, ens.dx, sig, null), dyb = SV.blur(g.nx, g.ny, ens.dy, sig, null);
    let fmax = 0; for (let c = 0; c < N; c++) fmax = Math.max(fmax, fb[c]);
    const fx = new Float32Array(N), fy = new Float32Array(N), mag = new Float32Array(N);
    const J0 = I / (wMm * tMm);
    for (let c = 0; c < N; c++) {
      if (fb[c] < 1e-3 * fmax) continue;
      const m = J0 * (fb[c] / fmax), d = Math.hypot(dxb[c], dyb[c]) || 1;
      mag[c] = m; fx[c] = (sign * m * dxb[c]) / d; fy[c] = (sign * m * dyb[c]) / d;
    }
    return { fx, fy, mag };
  }

  /** 去程概率图卷积 1/(1+(d/h)²)，得到贴着去程的高频回流（A/mm²）。 */
  function imageField(g, ens, I, hMm, tMm, mask) {
    const N = g.nx * g.ny, r = Math.max(2, Math.ceil((4 * hMm) / g.cell));
    const ker = [];
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const d = Math.hypot(di, dj) * g.cell;
      ker.push([di, dj, (g.cell / (Math.PI * hMm)) / (1 + (d / hMm) ** 2)]);
    }
    const K = new Float32Array(N), dx = new Float32Array(N), dy = new Float32Array(N);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const c = j * g.nx + i, f = ens.f[c];
      if (!(f > 0)) continue;
      const dl = Math.hypot(ens.dx[c], ens.dy[c]) || 1, ux = ens.dx[c] / dl, uy = ens.dy[c] / dl;
      for (const [di, dj, w] of ker) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.ny) continue;
        const d = jj * g.nx + ii;
        if (!mask[d]) continue;
        K[d] += I * f * w; dx[d] -= ux * f * w; dy[d] -= uy * f * w;
      }
    }
    const fx = new Float32Array(N), fy = new Float32Array(N), mag = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      if (!K[c]) continue;
      const m = K[c] / tMm, d = Math.hypot(dx[c], dy[c]) || 1;
      mag[c] = m; fx[c] = (m * dx[c]) / d; fy[c] = (m * dy[c]) / d;
    }
    return { fx, fy, mag };
  }

  function toJ(fl, tMm, mask) {
    const N = fl.mag.length, fx = new Float32Array(N), fy = new Float32Array(N), mag = new Float32Array(N);
    for (let c = 0; c < N; c++) { if (mask && !mask[c]) continue; const k = 1 / 1000 / tMm; fx[c] = fl.fx[c] * k; fy[c] = fl.fy[c] * k; mag[c] = fl.mag[c] * k; }
    return { fx, fy, mag };
  }

  function sourceFor(st, load) {
    const s = st.v.sources.find((x) => x.net === load.net) || st.v.sources[0];
    return s || null;
  }

  /** 去程、回流的四个端点。 */
  function endpoints(st, load) {
    const { p } = st;
    const src = sourceFor(st, load);
    if (!src) return null;
    const a = V.pinPoint(p, src.part, src.pin), b = V.pinPoint(p, load.part, load.pin);
    const ag = V.pinPoint(p, src.part, src.gnd_pin ?? V.defaultGndPin(p, src.part, src.pin));
    const bg = V.pinPoint(p, load.part, load.gnd_pin ?? V.defaultGndPin(p, load.part, load.pin));
    if (!a || !b || !ag || !bg) return null;
    return { src, a, b, ag, bg };
  }

  /**
   * 阶段 P：选中一个负载，估计它的去程与回流。返回结果对象（含显示用的场和结论）。
   */
  function analyzeP(st, li, opts = {}) {
    const { g, v, p } = st, load = v.loads[li];
    const ep = endpoints(st, load);
    if (!ep) return { error: '找不到该负载的电源起点或引脚位置' };
    const I = (load.i_avg_ma || 0) / 1000, Ipk = (load.i_peak_ma || 0) / 1000;
    const stack = opts.stackup || v.stackup;
    const planeOf = (net) => { const q = stack.planes.find((x) => x.net === net); return q ? q.layer : -1; };
    const oz = (l) => stack.cu_oz[l] ?? 1;
    const h = stack.h_mm || 0.2;
    const side = ep.b.side === 'bottom' ? 'bottom' : 'top';
    const own = [ep.src.part, load.part];
    const base = routingBase(st, side, own, false);
    const wReq = Math.max(p.board.track || 0.15, C.ipcWidth(Math.max(I, Ipk / 2), oz(0)));
    const out = { ref: load.part, net: load.net, kind: load.kind, I, Ipk, stage: 'P', wReq, pins: { src: ep.a, load: ep.b, srcGnd: ep.ag, loadGnd: ep.bg }, findings: [] };
    const N = g.nx * g.ny;

    // ---------- 去程 ----------
    const pl = planeOf(load.net);
    let ens = null;
    if (pl >= 0) {
      const sol = planeSolve(g, st.planeMask, ep.a, ep.b, I || 1e-3, C.sheetG(oz(pl)));
      if (!sol) return { error: '电源平面上找不到起点或终点' };
      out.sup = toJ(sol, oz(pl) * 0.035, st.planeMask);
      out.supMode = 'plane';
      out.supPts = maxCurrentPath(g, st.planeMask, sol.mag, sol.ca, sol.cb);
      out.dropV = sol.drop;
      out.jitter = null;
    } else {
      ens = R.ensemble(g, base, ep.a, ep.b, { n: opts.n || 16, seed: 11 + li });
      if (!ens) return { error: '去程找不到可走的通道（被器件或禁布区完全挡住）' };
      out.sup = routeField(g, ens, I || 1e-3, wReq, oz(0) * 0.035, 1);
      out.supMode = 'route';
      out.supPts = R.toPolyline(g, ens.best, 2);
      out.spread = ens.spread;
      // 走廊宽度：最可能路径上到障碍物的距离 ×2（端点 1 mm 内不算）
      const free = new Uint8Array(N);
      for (let c = 0; c < N; c++) free[c] = base[c] > 0 ? 1 : 0;
      const dist = SV.distance(g.nx, g.ny, free);
      let cmin = Infinity, cAt = null;
      const skip = Math.ceil(1 / g.cell);
      for (let q = skip; q < ens.best.length - skip; q++) {
        const c = ens.best[q], w = 2 * dist[c] * g.cell;
        if (w < cmin) { cmin = w; cAt = c; }
      }
      out.corridor = Number.isFinite(cmin) ? cmin : null;
      const need = wReq + 2 * (p.board.space || 0.15);
      if (out.corridor !== null && out.corridor < need) {
        out.findings.push(F.finding(v, 'VF-01', { obj: load.part, value: +out.corridor.toFixed(2), where: { x: g.cx(cAt % g.nx), y: g.cy((cAt / g.nx) | 0) },
          title: `${load.net} 到 ${load.part} 的通道最窄处约 ${out.corridor.toFixed(2)} mm，按 ${(Math.max(I, Ipk / 2) * 1000).toFixed(0)} mA 需线宽 ${wReq.toFixed(2)} mm 加两侧间距`,
          advice: `挪开挡路的器件，或让这段走电源平面；线宽不小于 ${wReq.toFixed(2)} mm`, assume: 'IPC-2221 外层、温升 10 °C；通道宽度按器件外形估算' }));
      }
      // 不确定度：每格的抖动幅度（mm）
      const fb = SV.blur(g.nx, g.ny, ens.f, Math.max(1, 1 / g.cell), null);
      let fm = 0; for (let c = 0; c < N; c++) fm = Math.max(fm, fb[c]);
      out.jitter = new Float32Array(N);
      for (let c = 0; c < N; c++) out.jitter[c] = out.sup.mag[c] > 0 ? Math.max(0.15, ens.spread) * (1 - fb[c] / (fm || 1)) + 0.1 : 0;
    }
    out.supLen = R.polyLen(out.supPts);

    // ---------- 回流 ----------
    const gl = planeOf(st.gnd);
    const tG = gl >= 0 ? oz(gl) * 0.035 : oz(0) * 0.035;
    if (gl >= 0) {
      let gapFrac = 0;
      if (ens) {
        let s = 0, t = 0;
        for (let c = 0; c < N; c++) if (ens.f[c] > 0) { t += ens.f[c]; if (!st.planeMask[c]) s += ens.f[c]; }
        gapFrac = t ? s / t : 0;
      }
      if (load.kind !== 'dc' && !ens) {
        // 电源也是整层平面：高频回流在相邻地平面上镜像去程分布
        const m = out.sup, fx = new Float32Array(N), fy = new Float32Array(N), mag = new Float32Array(N);
        const k = (oz(pl) * 0.035) / tG;
        for (let c = 0; c < N; c++) { mag[c] = m.mag[c] * k; fx[c] = -m.fx[c] * k; fy[c] = -m.fy[c] * k; }
        out.ret = { fx, fy, mag };
        out.retMode = 'image';
        out.retPts = out.supPts.slice().reverse();
        out.retLen = out.supLen;
        out.loopArea = out.supLen * h;
      } else if (load.kind !== 'dc' && ens && gapFrac <= 0.05) {
        out.ret = imageField(g, ens, I || 1e-3, h, tG, st.planeMask);
        out.retMode = 'image';
        out.retPts = out.supPts;
        out.retLen = out.supLen;
        out.loopArea = out.supLen * h;
      } else {
        const sol = planeSolve(g, st.planeMask, ep.bg, ep.ag, I || 1e-3, C.sheetG(oz(gl)));
        if (!sol) return { ...out, error: '地平面上找不到回流端点' };
        out.ret = toJ(sol, tG, st.planeMask);
        out.retMode = load.kind !== 'dc' && ens ? 'detour' : (load.kind !== 'dc' ? 'image' : 'plane');
        out.retPts = maxCurrentPath(g, st.planeMask, sol.mag, sol.ca, sol.cb);
        out.retLen = R.polyLen(out.retPts);
        out.loopArea = R.loopArea(out.supPts, out.retPts) + out.supLen * h;
        out.gapFrac = gapFrac;
        if (out.retMode === 'detour') {
          const ratio = out.retLen / Math.max(out.supLen, 0.1);
          out.findings.push(F.finding(v, 'VF-05', { obj: load.part, value: +ratio.toFixed(2), where: gapWhere(g, ens, st.planeMask),
            title: `${load.part} 的高频回流被地平面缺口挡住：去程约 ${(gapFrac * 100).toFixed(0)}% 的路段下方没有地，回流被迫绕行，回路面积约 ${out.loopArea.toFixed(1)} mm²`,
            advice: '让去程避开天线净空区、固定孔和板边缺口，或在缺口两侧补地过孔、改走另一侧', assume: '地平面按整层估计，缺口来自天线净空、固定孔' }));
        }
      }
    } else {
      const gbase = routingBase(st, side, own, false);
      const gens = R.ensemble(g, gbase, ep.bg, ep.ag, { n: opts.n || 16, seed: 101 + li });
      if (!gens) return { ...out, error: '回流找不到可走的通道' };
      out.ret = routeField(g, gens, I || 1e-3, wReq, tG, 1);
      out.retMode = 'route';
      out.retPts = R.toPolyline(g, gens.best, 2);
      out.retLen = R.polyLen(out.retPts);
      out.loopArea = R.loopArea(out.supPts, out.retPts);
      out.noPlane = true;
    }
    const r4 = F.rule(v, 'VF-04');
    if (load.kind !== 'dc' && out.supMode === 'route' && out.loopArea > r4.max_mm2) {
      out.findings.push(F.finding(v, 'VF-04', { obj: load.part, value: +out.loopArea.toFixed(1), where: { x: ep.b.x, y: ep.b.y },
        title: `${load.part}（${load.kind === 'rf' ? '射频' : '开关'}负载）的供电回路面积约 ${out.loopArea.toFixed(0)} mm²，超过 ${r4.max_mm2} mm²`,
        advice: out.noPlane ? '没有整层地时回路面积取决于铺地方式：让地线紧贴电源线走，或改用 4 层板' : '把储能/去耦电容挪到电源脚旁，调整引脚朝向让去程更短', assume: out.noPlane ? '2 层板，回流按候选路径估计' : '回流贴着去程走（高频）' }));
    }

    // ---------- 去耦电容的小回路 ----------
    out.decaps = [];
    for (const s of p.satellites) {
      if (!s.placed || !s.parent || s.parent[0] !== load.part) continue;
      if (!['decoupling', 'bulk', 'dcdc_cap'].includes(s.kind)) continue;
      const pin = V.pinPoint(p, load.part, s.parent[1]);
      if (!pin) continue;
      const d = Math.hypot(s.placed.x - pin.x, s.placed.y - pin.y);
      out.decaps.push({ ref: s.ref, kind: s.kind, pin: s.parent[1], d: +d.toFixed(2), area: +(d * (gl >= 0 ? 2 * h + 0.6 : 1.0)).toFixed(2) });
    }

    // 有整层电源平面时，高频电流的回路主要由最近的去耦电容决定
    if (load.kind !== 'dc') {
      const near = out.decaps.filter((d) => d.kind === 'decoupling' && d.pin === load.pin).sort((a, b) => a.d - b.d)[0];
      if (!near || near.d > r4.max_decap_mm) {
        out.findings.push(F.finding(v, 'VF-04', { obj: load.part, value: near ? near.d : null, where: { x: ep.b.x, y: ep.b.y },
          title: near ? `${load.part} 最近的去耦电容 ${near.ref} 离电源脚约 ${near.d} mm，高频电流回路偏大（约 ${near.area} mm²）` : `${load.part} 的电源脚旁没有去耦电容，高频电流要从远处的电源取，回路面积大`,
          advice: `把去耦电容放到电源脚 ${r4.max_decap_mm} mm 以内，电容的地端就近打孔到地平面`, assume: '回路面积 ≈ 电容到引脚距离 × (2 × 介质厚度 + 0.6 mm)' }));
      }
      out.hfLoop = near ? near.area : null;
    }

    // ---------- 共用回流 ----------
    if (load.kind !== 'dc' || Ipk >= 0.1) {
      let mx = 0; for (let c = 0; c < N; c++) mx = Math.max(mx, out.ret.mag[c]);
      const r6 = F.rule(v, 'VF-06');
      for (const vic of v.victims) {
        if (!vic.part || vic.part === load.part || vic.part === ep.src.part) continue;
        const vs = LP.model.satByRef(p, vic.part);
        if (vs && vs.parent && vs.parent[0] === load.part) continue;   // 负载自己的卫星器件不算
        const b = V.bodyOf(p, vic.part);
        if (!b) continue;
        const cx = (b.rect.x0 + b.rect.x1) / 2, cy = (b.rect.y0 + b.rect.y1) / 2;
        let m = 0;
        V.fillRectFn(g, { x0: cx - 1.5, y0: cy - 1.5, x1: cx + 1.5, y1: cy + 1.5 }, (c) => { if (out.ret.mag[c] > m) m = out.ret.mag[c]; });
        const ov = mx ? m / mx : 0;
        if (ov > r6.max_overlap) {
          out.findings.push(F.finding(v, 'VF-06', { obj: vic.part, value: +ov.toFixed(2), where: { x: cx, y: cy },
            title: `${load.part} 的回流经过敏感器件 ${vic.part} 下方（重叠度 ${ov.toFixed(2)}）`,
            advice: `把 ${vic.part} 挪离 ${load.part} 的供电回路，或让两者的回流分边走`, assume: '重叠度 = 敏感器件附近的回流密度 ÷ 回流最大密度' }));
        }
      }
    }
    return out;
  }

  function gapWhere(g, ens, mask) {
    if (!ens) return null;
    let sx = 0, sy = 0, n = 0;
    for (let c = 0; c < ens.f.length; c++) if (ens.f[c] > 0.2 && !mask[c]) { sx += g.cx(c % g.nx); sy += g.cy((c / g.nx) | 0); n++; }
    return n ? { x: sx / n, y: sy / n } : null;
  }

  LP.current = { analyzeP, routingBase, planeSolve, nearestIn, maxCurrentPath, endpoints, sourceFor, toJ };
})(globalThis.LP = globalThis.LP || {});
