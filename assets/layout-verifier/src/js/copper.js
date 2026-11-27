// 布线后（阶段 R）：解码铜皮数据包（按需、按分组），在真实铜皮上求解电流，读取离线算好的几何检查。
(function (LP) {
  'use strict';
  const C = LP.vconst, SV = LP.solver, F = LP.vrules, R = LP.routes, V = LP.vmodel;

  const B64 = new Int16Array(128).fill(-1);
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((ch, i) => { B64[ch.charCodeAt(0)] = i; });
  /** base64 → 字节（不依赖 atob/Buffer，Worker、页面和 Node 都能用）。 */
  function b64(s) {
    const n = s.length, out = new Uint8Array(Math.floor((n * 3) / 4));
    let k = 0, acc = 0, bits = 0;
    for (let i = 0; i < n; i++) {
      const v = B64[s.charCodeAt(i) & 127];
      if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[k++] = (acc >> bits) & 255; }
    }
    return out.subarray(0, k);
  }
  /** 三字节一组的游程编码 → 0..1 覆盖率。 */
  function rleDecode(s, N) {
    const b = b64(s), out = new Float32Array(N);
    let k = 0;
    for (let i = 0; i + 2 < b.length; i += 3) {
      const n = b[i] | (b[i + 1] << 8), v = b[i + 2] / 255;
      if (v) out.fill(v, k, Math.min(N, k + n));
      k += n;
    }
    return out;
  }

  /** 读入数据包：只建索引，覆盖率在用到时才解码并缓存。 */
  function load(pack) {
    if (!pack || pack.kind !== 'copper-pack') throw new Error('不是铜皮数据包（kind 应为 copper-pack）');
    const N = pack.grid.nx * pack.grid.ny, cache = new Map();
    const nets = new Map(pack.nets.map((n) => [n.name, n]));
    return {
      ...pack, nets, N,
      netCov(name, l) {
        const k = 'n:' + name + ':' + l;
        if (!cache.has(k)) { const n = nets.get(name); const s = n && n.cov && n.cov[String(l)]; cache.set(k, s ? rleDecode(s, N) : null); }
        return cache.get(k);
      },
      groupCov(g, l) {
        const k = 'g:' + g + ':' + l;
        if (!cache.has(k)) { const s = pack.cov[g] && pack.cov[g][String(l)]; cache.set(k, s ? rleDecode(s, N) : null); }
        return cache.get(k);
      },
    };
  }

  /** 让项目的板框、器件位置与实际布板一致（以铜皮数据包为准）。 */
  function alignProject(raw, pack) {
    const p = JSON.parse(JSON.stringify(raw));
    p.board.outline = { type: 'polygon', points: pack.board.outline };
    const byRef = new Map(pack.parts.map((q) => [q.ref, q]));
    for (const list of [p.parts || [], p.satellites || []]) for (const it of list) {
      const q = byRef.get(it.ref);
      if (!q) continue;
      it.placed = { ...(it.placed || { rot: 0 }), x: q.x, y: q.y, side: q.side };
    }
    return p;
  }

  /** 某网络在某器件上的焊盘所在格子（按层）。找不到时退回到引脚估计位置附近的铜。 */
  function padCells(st, net, ref, fallbackPt) {
    const pk = st.pack, n = pk.nets.get(net), g = st.g, out = [];
    if (n) for (const [r, , l, x, y] of n.pads) if (r === ref) out.push({ l, c: g.at(x, y), x, y });
    if (!out.length && fallbackPt) {
      let best = null;
      for (let l = 0; l < pk.layers.length; l++) {
        const cov = pk.netCov(net, l);
        if (!cov) continue;
        const c = LP.current.nearestIn(g, cov.map((v) => (v > 0.05 ? 1 : 0)), fallbackPt.x, fallbackPt.y);
        if (c < 0) continue;
        const d = Math.hypot(g.cx(c % g.nx) - fallbackPt.x, g.cy((c / g.nx) | 0) - fallbackPt.y);
        if (!best || d < best.d) best = { l, c, d, x: g.cx(c % g.nx), y: g.cy((c / g.nx) | 0) };
      }
      if (best && best.d < 3) out.push(best);
    }
    return out;
  }

  /**
   * 在一个网络的多层铜皮上求解：src 处固定 0 V，sink 处抽出电流 I。
   * 返回每层的 {fx, fy, mag(A/mm²)} 合成（每格取电流最大的那层）、过孔电流、压降。
   */
  function solveNet(st, net, src, sink, I) {
    const pk = st.pack, g = st.g, nx = g.nx, ny = g.ny, N = nx * ny, L = pk.layers.length;
    const oz = (l) => (st.v.stackup.cu_oz[l] ?? (l === 0 || l === L - 1 ? 1 : 0.5));
    const covs = [], idx = [];
    let n = 0;
    const links = [], gl = [], coords = [];
    for (let l = 0; l < L; l++) {
      const cov = pk.netCov(net, l);
      covs.push(cov);
      const ix = new Int32Array(N).fill(-1);
      if (cov) {
        const mask = new Uint8Array(N), coeff = new Float32Array(N), Gs = C.sheetG(oz(l));
        for (let c = 0; c < N; c++) if (cov[c] > 0.02) { mask[c] = 1; coeff[c] = cov[c] * Gs; }
        const lk = SV.gridLinks(nx, ny, mask, coeff);
        for (let a = 0; a < lk.n; a++) { ix[lk.cells[a]] = n + a; coords.push(l, lk.cells[a] % nx, (lk.cells[a] / nx) | 0); }
        for (let k = 0; k < lk.g.length; k++) { links.push(lk.links[2 * k] + n, lk.links[2 * k + 1] + n); gl.push(lk.g[k]); }
        n += lk.n;
      }
      idx.push(ix);
    }
    if (!n) return null;
    // 过孔：连接相邻有铜的层；通孔焊盘同样处理
    const nn = pk.nets.get(net);
    const viaList = [];
    const tie = (x, y, gv) => {
      const c = g.at(x, y), ls = [];
      for (let l = 0; l < L; l++) if (idx[l][c] >= 0) ls.push(l);
      for (let q = 1; q < ls.length; q++) { links.push(idx[ls[q - 1]][c], idx[ls[q]][c]); gl.push(gv); viaList.push({ x, y, c, a: ls[q - 1], b: ls[q], k: gl.length - 1 }); }
    };
    if (nn) {
      for (const [x, y] of nn.vias) tie(x, y, 1 / C.VIA_R_OHM);
      for (const [, , l, x, y] of nn.pads) if (l === -1) tie(x, y, 4 / C.VIA_R_OHM);
    }
    const diag = new Float64Array(n);
    let gmax = 0; for (const w of gl) gmax = Math.max(gmax, w);
    const fixedNodes = [];
    for (const s of src) { const ls = s.l === -1 ? [...Array(L).keys()] : [s.l]; for (const l of ls) { const a = idx[l][s.c]; if (a >= 0) { diag[a] += gmax * 1e6; fixedNodes.push(a); } } }
    const b = new Float64Array(n);
    const sinkNodes = [];
    for (const s of sink) { const ls = s.l === -1 ? [...Array(L).keys()] : [s.l]; for (const l of ls) { const a = idx[l][s.c]; if (a >= 0) sinkNodes.push(a); } }
    if (!fixedNodes.length || !sinkNodes.length) return null;
    // 连通性：只保留与电源起点连通的负载焊盘；一个都不连通就报不连通
    const par = new Int32Array(n); for (let a = 0; a < n; a++) par[a] = a;
    const fd = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    for (let k = 0; k < links.length; k += 2) { const x = fd(links[k]), y = fd(links[k + 1]); if (x !== y) par[x] = y; }
    const roots = new Set(fixedNodes.map(fd));
    const live = sinkNodes.filter((a) => roots.has(fd(a)));
    if (!live.length) return { disconnected: true };
    sinkNodes.length = 0; sinkNodes.push(...live);
    for (let a = 0; a < n; a++) diag[a] += gmax * 1e-9;     // 让与起点不连通的铜块也有确定解（电位约为 0）
    for (const a of sinkNodes) b[a] -= I / sinkNodes.length;
    const A = SV.assemble(n, Int32Array.from(links), Float64Array.from(gl), diag);
    const levels = n > 1500 ? SV.amgSetup(A, Int32Array.from(coords)) : null;
    const r = SV.pcg(A, b, { tol: 1e-5, levels, maxIt: 3000 });
    // 每层的片电流（A/m）→ 体电流密度（A/mm²，按覆盖率还原到铜本身）
    const fx = new Float32Array(N), fy = new Float32Array(N), mag = new Float32Array(N), layerOf = new Int8Array(N).fill(-1);
    const K = [];
    for (let l = 0; l < L; l++) {
      if (!covs[l]) { K.push(null); continue; }
      const u = new Float32Array(N).fill(NaN), coeff = new Float32Array(N), Gs = C.sheetG(oz(l));
      for (let c = 0; c < N; c++) { const a = idx[l][c]; if (a >= 0) { u[c] = r.x[a]; coeff[c] = covs[l][c] * Gs; } }
      const fl = SV.flux(nx, ny, u, coeff, g.cell / 1000);
      K.push(fl);
      const t = oz(l) * C.OZ_UM / 1000;
      for (let c = 0; c < N; c++) {
        if (!(fl.mag[c] > 0)) continue;
        const j = fl.mag[c] / 1000 / t / Math.max(covs[l][c], 0.05);
        if (j > mag[c]) { mag[c] = j; const k = j / fl.mag[c]; fx[c] = fl.fx[c] * k; fy[c] = fl.fy[c] * k; layerOf[c] = l; }
      }
    }
    let vmin = 0; for (const a of sinkNodes) vmin = Math.min(vmin, r.x[a]);
    let vs = 0; for (const a of sinkNodes) vs += r.x[a];
    const vias = viaList.map((q) => ({ x: q.x, y: q.y, I: Math.abs(gl[q.k] * (r.x[idx[q.a][q.c]] - r.x[idx[q.b][q.c]])) }));
    return { fx, fy, mag, layerOf, K, covs, drop: -vs / sinkNodes.length, vias, iters: r.iters };
  }

  function maxPath(st, field, from, to) {
    const g = st.g, N = g.nx * g.ny, mask = new Uint8Array(N);
    let mx = 0; for (let c = 0; c < N; c++) if (field.mag[c] > 0) { mask[c] = 1; mx = Math.max(mx, field.mag[c]); }
    if (!mask[from] || !mask[to]) { mask[from] = 1; mask[to] = 1; }
    const cost = new Float32Array(N);
    for (let c = 0; c < N; c++) cost[c] = mask[c] ? 1 / (field.mag[c] / (mx || 1) + 0.02) : 0;
    const path = R.astar(g.nx, g.ny, cost, from, to);
    return path ? R.toPolyline(g, path, 2) : [];
  }

  /** 阶段 R 的电流分析：与阶段 P 返回相同结构，供界面直接使用。 */
  function analyzeCurrent(st, li, opts = {}) {
    const { v, p, g } = st, load = v.loads[li];
    const ep = LP.current.endpoints(st, load);
    if (!ep) return { error: '找不到该负载的电源起点' };
    const I = Math.max(1e-4, (load.i_avg_ma || 0) / 1000), Ipk = (load.i_peak_ma || 0) / 1000;
    const out = { ref: load.part, net: load.net, kind: load.kind, I, Ipk, stage: 'R', supMode: 'copper', retMode: 'copper', pins: { src: ep.a, load: ep.b, srcGnd: ep.ag, loadGnd: ep.bg }, findings: [] };
    const sSrc = padCells(st, load.net, ep.src.part, ep.a), sLoad = padCells(st, load.net, load.part, ep.b);
    const gSrc = padCells(st, st.gnd, ep.src.part, ep.ag), gLoad = padCells(st, st.gnd, load.part, ep.bg);
    if (!sSrc.length || !sLoad.length) return { error: `在铜皮数据里找不到 ${load.net} 在 ${ep.src.part} 或 ${load.part} 上的焊盘：检查网络名是否与原理图一致` };
    const sup = solveNet(st, load.net, sSrc, sLoad, I);
    if (!sup || sup.disconnected) return { error: `${load.net} 在铜皮上从 ${ep.src.part} 到 ${load.part} 不连通：检查是否漏线或少过孔` };
    out.sup = { fx: sup.fx, fy: sup.fy, mag: sup.mag };
    out.supPts = maxPath(st, sup, sSrc[0].c, sLoad[0].c);
    out.supLen = R.polyLen(out.supPts);
    let ret = null;
    if (gSrc.length && gLoad.length) ret = solveNet(st, st.gnd, gSrc, gLoad, I);
    if (ret && ret.disconnected) ret = null;
    if (ret) {
      // 回流方向：从负载地流回电源地
      for (let c = 0; c < ret.fx.length; c++) { ret.fx[c] = -ret.fx[c]; ret.fy[c] = -ret.fy[c]; }
      out.ret = { fx: ret.fx, fy: ret.fy, mag: ret.mag };
      out.retPts = maxPath(st, ret, gLoad[0].c, gSrc[0].c);
      out.retLen = R.polyLen(out.retPts);
    } else {
      out.ret = { fx: new Float32Array(sup.fx.length), fy: new Float32Array(sup.fx.length), mag: new Float32Array(sup.fx.length) };
      out.retPts = []; out.retLen = 0;
      out.findings.push(F.finding(v, 'VF-05', { obj: load.part, title: `${load.part} 的地与电源起点的地在铜皮上不连通`, advice: '检查地网络是否漏连、铺铜是否填充', assume: '按铜皮数据包的地网络' }));
    }
    const h = v.stackup.h_mm || 0.2;
    out.loopArea = out.retPts.length ? R.loopArea(out.supPts, out.retPts) + out.supLen * h : null;
    out.dropV = sup.drop + (ret ? ret.drop : 0);
    out.vias = sup.vias.concat(ret ? ret.vias : []).sort((a, b) => b.I - a.I).slice(0, 12);
    out.wReq = Math.max(p.board.track || 0.15, C.ipcWidth(Math.max(I, Ipk / 2)));
    // VF-01：逐段导线按实际流过的电流核对线宽
    const n = st.pack.nets.get(load.net);
    let worst = null;
    for (const s of (n && n.segs) || []) {
      const [l, x1, y1, x2, y2, w] = s, Kl = sup.K[l];
      if (!Kl) continue;
      const c = g.at((x1 + x2) / 2, (y1 + y2) / 2);
      const Iseg = Kl.mag[c] * (g.cell / 1000);
      const need = C.ipcWidth(Iseg, st.v.stackup.cu_oz[l] ?? 1, l > 0 && l < st.pack.layers.length - 1);
      if (need > w && (!worst || need / w > worst.ratio)) worst = { ratio: need / w, w, need, Iseg, x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    }
    if (worst) out.findings.push(F.finding(v, 'VF-01', { obj: load.part, value: +worst.w.toFixed(2), where: { x: worst.x, y: worst.y },
      title: `${load.net} 有一段 ${worst.w.toFixed(2)} mm 的导线流过约 ${(worst.Iseg * 1000).toFixed(0)} mA，按 IPC-2221 需 ${worst.need.toFixed(2)} mm`,
      advice: `把这段加宽到 ${worst.need.toFixed(2)} mm 以上，或并联铺铜`, assume: 'IPC-2221，温升 10 °C；导线电流取求解结果' }));
    const r2 = F.rule(v, 'VF-02');
    const src = LP.current.sourceFor(st, load), Vs = (src && src.v) || 3.3;
    out.dropPct = (out.dropV / Vs) * 100;
    if (out.dropPct > r2.max_pct) out.findings.push(F.finding(v, 'VF-02', { obj: load.part, value: +out.dropPct.toFixed(2), where: { x: ep.b.x, y: ep.b.y },
      title: `${load.part} 的供电压降约 ${(out.dropV * 1000).toFixed(0)} mV（${out.dropPct.toFixed(1)}%，去程加回流）`, advice: '加宽电源和地的走线、增加过孔，或缩短路径', assume: `按平均电流 ${(I * 1000).toFixed(0)} mA、铜厚按叠层` }));
    const r3 = F.rule(v, 'VF-03');
    const hot = out.vias.find((q) => q.I > r3.max_a);
    if (hot) out.findings.push(F.finding(v, 'VF-03', { obj: load.part, value: +hot.I.toFixed(2), where: { x: hot.x, y: hot.y }, title: `一个过孔流过约 ${hot.I.toFixed(2)} A`, advice: '在旁边并联 2 个以上过孔', assume: `单孔上限 ${r3.max_a} A` }));
    // 高频负载：去程铜皮下方相邻层有没有地
    if (load.kind !== 'dc') {
      const L = st.pack.layers.length;
      let tot = 0, miss = 0, mx = 0, my = 0;
      for (let c = 0; c < sup.mag.length; c++) {
        const l = sup.layerOf[c];
        if (l < 0 || !(sup.mag[c] > 0)) continue;
        tot++;
        const adj = [l - 1, l + 1].filter((q) => q >= 0 && q < L);
        if (!adj.some((q) => { const gc = st.pack.netCov(st.gnd, q); return gc && gc[c] > 0.5; })) { miss++; mx += g.cx(c % g.nx); my += g.cy((c / g.nx) | 0); }
      }
      out.gapFrac = tot ? miss / tot : 0;
      if (out.gapFrac > 0.05) out.findings.push(F.finding(v, 'VF-05', { obj: load.part, value: +out.gapFrac.toFixed(2), where: { x: mx / miss, y: my / miss },
        title: `${load.part}（${load.kind === 'rf' ? '射频' : '开关'}负载）的供电铜皮约 ${(out.gapFrac * 100).toFixed(0)}% 下方相邻层没有地，高频回流要绕行`, advice: '在这些位置补地铜或调整走线层', assume: '相邻层地覆盖率 > 50% 才算有参考' }));
    }
    out.decaps = [];
    return out;
  }

  function thermalInputs(st) {
    const pk = st.pack, cov = [];
    for (let l = 0; l < pk.layers.length; l++) {
      const a = new Float32Array(pk.N);
      for (const g of Object.keys(pk.cov || {})) { const c = pk.groupCov(g, l); if (c) for (let i = 0; i < a.length; i++) a[i] = Math.min(1, a[i] + c[i]); }
      cov.push(a);
    }
    return { coverage: cov };
  }

  /** 网络几何（供电磁分析）：导线逐段采样。 */
  function netGeom(st) {
    const out = {}, L = st.pack.layers.length;
    for (const [name, n] of st.pack.nets) {
      if (!n.segs || !n.segs.length) continue;
      const pts = [];
      for (const [l, x1, y1, x2, y2] of n.segs) {
        const len = Math.hypot(x2 - x1, y2 - y1), k = Math.max(1, Math.ceil(len / 0.5));
        for (let q = 0; q <= k; q++) pts.push({ x: x1 + ((x2 - x1) * q) / k, y: y1 + ((y2 - y1) * q) / k, side: l === L - 1 ? 'bottom' : 'top' });
      }
      out[name] = pts;
    }
    return out;
  }

  function emiChecks(st) {
    const { v } = st, ck = st.pack.checks || {}, out = [];
    const r8 = F.rule(v, 'VF-08');
    for (const q of ck.rf || []) {
      const em = v.emitters.find((e) => e.net === q.net);
      const f = (em && em.f_hz) || 2.4e9, lim = C.lambdaMm(f, v.stackup.er) * r8.fence_frac;
      if (q.ref_ok < r8.min_ref) out.push(F.finding(v, 'VF-08', { obj: q.net, value: q.ref_ok, where: q.gaps[0] ? { x: q.gaps[0][0], y: q.gaps[0][1] } : null,
        title: `射频线 ${q.net} 只有 ${(q.ref_ok * 100).toFixed(0)}% 的长度下方有完整地平面`, advice: '补齐射频线下方相邻层的地，不要让槽、分割或孔从下面穿过', assume: '相邻层是地网络才算参考平面' }));
      if (q.fence_mm != null && q.fence_mm > lim) out.push(F.finding(v, 'VF-08', { obj: q.net, value: q.fence_mm, sev: 'P2',
        title: `射频线 ${q.net} 两侧地孔间距约 ${q.fence_mm} mm，大于 λ/20（${lim.toFixed(1)} mm）`, advice: `沿射频线两侧每 ${lim.toFixed(1)} mm 内打一个地孔`, assume: `频率 ${(f / 1e9).toFixed(2)} GHz，按微带有效介电常数估算波长` }));
    }
    const r9 = F.rule(v, 'VF-09');
    for (const q of ck.coupling || []) if (q.ratio > r9.max_ratio) out.push(F.finding(v, 'VF-09', { obj: q.a, value: q.ratio, where: q.at ? { x: q.at[0], y: q.at[1] } : null,
      title: `模拟线 ${q.a} 与 ${q.b} 在 L${q.layer + 1} 并行 ${q.len} mm、间距 ${q.gap} mm（比值 ${q.ratio}）`, advice: '拉开间距到 3 倍线宽以上、换层，或在中间加地线', assume: `并行长度 ÷ 间距 > ${r9.max_ratio}` }));
    const r15 = F.rule(v, 'VF-15');
    for (const q of ck.detours || []) {
      if (!(q.routed > r15.max_ratio * q.direct + r15.slack_mm)) continue;
      const n = st.pack.nets.get(q.net), cls = n ? n.class : 'misc';
      out.push(F.finding(v, 'VF-15', { obj: q.net, value: q.ratio, where: q.at ? { x: q.at[0], y: q.at[1] } : null,
        sev: ['rf', 'clock', 'analog', 'switch_node'].includes(cls) ? 'P2' : undefined,
        title: `${q.net} 走线共 ${q.routed} mm，是焊盘间最短连线（${q.direct} mm）的 ${q.ratio} 倍`,
        advice: '看是否被摆放挡住：调换器件朝向或位置、换一层直走，或先让出通道再布；射频、时钟、模拟网络优先处理',
        assume: `阈值：走线总长 > ${r15.max_ratio} × 焊盘最小生成树长度 + ${r15.slack_mm} mm（参考 CADET 的绕行判据）` }));
    }
    for (const q of ck.islands || []) out.push(F.finding(v, 'VF-14', { value: q.area, where: { x: q.x, y: q.y },
      title: `L${q.layer + 1} 有一块 ${q.area} mm² 的地铜没有连到主地`, advice: '打过孔连到地平面，或删除这块铜', assume: '按地网络的连通性' }));
    return out.concat(routingFindings(v, ck.routing));
  }

  const RT_ADVICE = {
    'RTG-01': '改成 0/45/90° 折线：python scripts/route_fix.py 板子.kicad_pcb 可自动重建',
    'RTG-02': '锐角会积酸、蚀刻过度，信号上也是阻抗突变：改成两个 45° 拐弯', 'RTG-03': '分支改成 90° T 接或两个 45°',
    'RTG-05': '合并到相邻线段，或整段按八方向重走', 'RTG-06': '拉直：去掉小于 2 倍线宽的错位和来回拐弯',
    'RTG-07': '先沿焊盘长轴直出到焊盘外，再拐弯', 'RTG-09': '线宽只在焊盘颈缩或分支处变化',
    'RTG-10': '圆弧只用在射频、柔性弯折区或高压区，并在约束里声明豁免区', 'RTG-12': '删除悬空线头',
    'RTV-01': '少打过孔：晶振、射频、时钟线同层直连', 'RTV-02': '换层过孔 2 mm 内打一个地过孔给回流',
    'RTV-05': '过孔移出焊盘；必须盘中孔时向板厂要求树脂塞孔电镀盖帽', 'RTV-07': '差分线过孔成对、对称放置',
    'RTL-03': '晶振靠近芯片放置，走线 ≤ 5 mm', 'RTL-06': '射频线不分叉；匹配元件串在线上', 'RTL-07': '在长的一根上加蛇形补偿到 ≤ 0.5 mm',
    'RTL-11': '2 层板底层留给地：信号跳线 ≤ 10 mm，换层两端就近打地孔', 'RTY-02': '按层主方向走线，逆向走线换到另一层',
    'RTY-04': '内层地平面上不走线', 'RTY-05': '底层地被走线切碎：缩短或挪走底层跳线，补地孔缝合', 'RTS-03': '成束的线保持等间距平行',
    'RTW-01': '加宽到网络类要求的线宽', 'RTW-09': '线宽低于板厂下限，必须加宽',
  };
  /** 布线几何检查结果 → 结论。同一规则、网络、层的多处合并成一条，标第一处的位置。 */
  function routingFindings(v, rt) {
    if (!rt) return [];
    const out = [], groups = new Map();
    for (const x of rt.violations || []) {
      if (x.rule === 'RTL-01' || x.rule === 'RTL-02') continue;     // 绕行已由 VF-15 报告
      const id = x.metric && F.RULES[x.metric] ? x.metric : 'VF-26';
      const k = `${x.rule}|${x.net || ''}|${x.layer ?? ''}`;
      if (!groups.has(k)) groups.set(k, { id, x, n: 0 });
      groups.get(k).n++;
    }
    for (const { id, x, n } of groups.values()) {
      out.push(F.finding(v, id, { obj: x.net || null, value: x.value ?? n, sev: x.sev, where: x.at ? { x: x.at[0], y: x.at[1] } : null,
        title: `${x.rule}${x.layer != null ? ' L' + (x.layer + 1) : ''}${x.net ? ' ' + x.net : ''}：${x.msg}${n > 1 ? `（共 ${n} 处）` : ''}`,
        advice: RT_ADVICE[x.rule] || '', assume: '规则与阈值见 references/16-routing-constraints.md' }));
    }
    const r27 = F.rule(v, 'VF-27');
    if (rt.score != null && rt.score < r27.min_score) {
      const worst = Object.entries(rt.metrics || {}).filter(([, e]) => e.deduct > 0).sort((a, b) => b[1].deduct - a[1].deduct).slice(0, 3);
      out.push(F.finding(v, 'VF-27', { value: rt.score, sev: rt.score < 60 ? 'P2' : 'P3',
        title: `布线质量 ${rt.score} / 100（${rt.grade}）`, advice: '主要扣分：' + worst.map(([k, e]) => `${k} ${F.RULES[k] ? F.RULES[k].name : ''} −${e.deduct}`).join('，'),
        assume: '11 项加权扣分，任一 P0 即不通过' }));
    }
    return out;
  }

  /** 平面谐振用的实际地平面形状（降采样到长边约 64 格）。 */
  function planeShape(st) {
    const pk = st.pack, gl = (st.v.stackup.planes.find((q) => q.net === st.gnd) || {}).layer;
    let best = -1, bestSum = 0;
    for (let l = 0; l < pk.layers.length; l++) { const c = pk.netCov(st.gnd, l); if (!c) continue; let s = 0; for (const v of c) s += v; if (l === gl) s *= 1.5; if (s > bestSum) { bestSum = s; best = l; } }
    if (best < 0) return {};
    const cov = pk.netCov(st.gnd, best), g = st.g;
    const f = Math.max(1, Math.ceil(Math.max(g.nx, g.ny) / 64));
    const cg = V.makeGrid(st.p.board.outline, 64, 0.1, { cell: g.cell * f, x0: g.x0, y0: g.y0, nx: Math.ceil(g.nx / f), ny: Math.ceil(g.ny / f) });
    const mask = new Uint8Array(cg.nx * cg.ny);
    for (let j = 0; j < cg.ny; j++) for (let i = 0; i < cg.nx; i++) {
      let s = 0, n = 0;
      for (let jj = j * f; jj < Math.min(g.ny, (j + 1) * f); jj++) for (let ii = i * f; ii < Math.min(g.nx, (i + 1) * f); ii++) { s += cov[jj * g.nx + ii]; n++; }
      mask[j * cg.nx + i] = n && s / n > 0.5 ? 1 : 0;
    }
    return { grid: cg, mask };
  }

  /** 界面显示用的铜皮图（所有分组叠加，取最大覆盖率）。 */
  function layerImage(st, group, layer) {
    const pk = st.pack, a = new Float32Array(pk.N);
    const ls = layer === 'all' || layer == null ? [...Array(pk.layers.length).keys()] : [layer];
    for (const l of ls) for (const g of Object.keys(pk.cov || {})) {
      if (group !== 'all' && group !== g) continue;
      const c = pk.groupCov(g, l);
      if (c) for (let i = 0; i < a.length; i++) a[i] = Math.max(a[i], c[i]);
    }
    return { cov: a, grid: { nx: st.g.nx, ny: st.g.ny, cell: st.g.cell, x0: st.g.x0, y0: st.g.y0 } };
  }

  LP.copper = { load, alignProject, rleDecode, analyzeCurrent, thermalInputs, netGeom, emiChecks, planeShape, layerImage, padCells, solveNet };
})(globalThis.LP = globalThis.LP || {});
