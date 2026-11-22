/*
 * metrics.js — 布线复杂度的启发式估计。
 * 只用于比较两种摆法，不是布线器。所有函数都是纯函数：输入项目数据，输出数值和明细。
 */
(function (LP) {
  'use strict';
  const G = LP.geometry, M = LP.model;

  /** 状态阈值。修改时同步更新 references/12-layout-planner.md。 */
  const CONFIG = {
    cell: 1.0,                                   // 拥挤度网格（mm）
    lengthNorm: { good: 0.6, warn: 1.0 },        // 总线长 ÷ (总线数 × √板面积)
    crossDensity: { good: 1.0, warn: 2.5 },      // 交叉数 / cm²
    congestion: { good: 0.7, warn: 1.0 },        // 拥挤峰值（需求 ÷ 容量）
    exit: { good: 0.6, warn: 1.0 },              // 出线压力（需穿出线数 ÷ 可用通道）
    exitMinPins: 8,                              // 引脚总数达到此值才计算出线压力
    exitStrip: 3.0,                              // 出线通道带宽度（mm）
    criticalWarnFactor: 1.5,                     // 关键网络超限在 1.5 倍以内为"留意"
    rfDefaultMaxLen: 10,                         // 射频网络未给 max_len 时的默认上限（mm）
    layerCrossDensity: 2.5,                      // 交叉密度超过此值建议 4 层
    orientMinCross: 2,                           // 朝向建议：至少少 2 个交叉
    orientMinLenPct: 0.10,                       // 或线长短 10%
    innerLayers: { 1: 0, 2: 0, 4: 0.5, 6: 1.5, 8: 2.5 },
  };

  /** 机械件本体下方的外层仍可部分走线（只有触点和焊盘处不行），容量按一半计。 */
  const BIG_BODY = new Set(['coin', 'pouch', 'module']);

  function status(v, th) { return v <= th.good ? 'good' : v <= th.warn ? 'warn' : 'bad'; }

  // ---------- 网络的生成树 ----------
  function netNodes(p, net) {
    const out = [];
    for (const [ref, pin] of net.pins) {
      const part = M.partByRef(p, ref);
      if (!part || !part.placed) continue;
      const w = M.pinWorld(part, pin);
      if (w) out.push({ ref, pin, x: w.x, y: w.y });
    }
    return out;
  }
  /** Prim 最小生成树，边长用曼哈顿距离（走线以横竖为主）。 */
  function mst(nodes) {
    const n = nodes.length;
    if (n < 2) return [];
    const inTree = new Array(n).fill(false);
    const best = new Array(n).fill(Infinity);
    const from = new Array(n).fill(-1);
    best[0] = 0;
    const edges = [];
    for (let k = 0; k < n; k++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
      inTree[u] = true;
      if (from[u] >= 0) edges.push({ a: nodes[from[u]], b: nodes[u], len: G.manhattan(nodes[from[u]], nodes[u]) });
      for (let i = 0; i < n; i++) {
        if (inTree[i]) continue;
        const d = G.manhattan(nodes[u], nodes[i]);
        if (d < best[i]) { best[i] = d; from[i] = u; }
      }
    }
    return edges;
  }
  function netEdges(p) {
    const out = [];
    for (const net of p.nets) {
      for (const e of mst(netNodes(p, net))) out.push({ net: net.name, cls: net.class, width: net.width || 1, ...e });
    }
    return out;
  }

  // ---------- 指标 ----------
  function lengthMetric(p, edges) {
    const per = new Map();
    for (const e of edges) {
      const o = per.get(e.net) || { net: e.net, len: 0, width: e.width, total: 0 };
      o.len += e.len; o.total += e.len * e.width;
      per.set(e.net, o);
    }
    const perNet = [...per.values()];
    const value = perNet.reduce((s, x) => s + x.total, 0);
    const widths = perNet.reduce((s, x) => s + x.width, 0);
    const norm = widths ? value / (widths * Math.sqrt(G.outlineArea(p.board.outline))) : 0;
    return { value, perNet, norm, status: widths ? status(norm, CONFIG.lengthNorm) : 'good' };
  }

  function crossingMetric(p, edges) {
    const pairs = new Map();
    let value = 0;
    for (let i = 0; i < edges.length; i++) {
      const e1 = edges[i];
      for (let j = i + 1; j < edges.length; j++) {
        const e2 = edges[j];
        if (e1.net === e2.net) continue;
        if (!G.segIntersect(e1.a, e1.b, e2.a, e2.b)) continue;
        const n = Math.min(e1.width, e2.width);
        value += n;
        const [a, b] = e1.net < e2.net ? [e1.net, e2.net] : [e2.net, e1.net];
        const key = a + '|' + b;
        const o = pairs.get(key) || { a, b, n: 0, points: [], refs: new Set() };
        o.n += n;
        const pt = G.segIntersectionPoint(e1.a, e1.b, e2.a, e2.b);
        if (pt) o.points.push(pt);
        [e1.a.ref, e1.b.ref, e2.a.ref, e2.b.ref].forEach((r) => o.refs.add(r));
        pairs.set(key, o);
      }
    }
    const list = [...pairs.values()].sort((x, y) => y.n - x.n).map((o) => ({ ...o, refs: [...o.refs] }));
    const density = value / Math.max(G.outlineArea(p.board.outline) / 100, 0.01);
    return { value, pairs: list, density, status: status(density, CONFIG.crossDensity) };
  }

  /**
   * 遮挡物：{rect, side:'top'|'bottom'|'both', ref, kind}。
   * 卫星器件规划合格（在距离上限内）时不计入：贴放算法已避开出线通道，小件之间和其他层仍可走线；
   * 只有超距、放不下或被手动放坏的卫星才扣容量。没有贴放结果时卫星全部不计。
   */
  function obstacles(p, satResults) {
    const out = [];
    for (const pt of p.parts) {
      if (!pt.placed) continue;
      out.push({ rect: M.footprint(pt), side: pt.through ? 'both' : pt.placed.side, ref: pt.ref, kind: 'part', shape: pt.shape });
    }
    for (const s of p.satellites) {
      if (!s.placed || !s._active) continue;
      const r = satResults && satResults[s.ref];
      if (!r || r.ok) continue;
      out.push({ rect: M.satFootprint(s), side: s.placed.side, ref: s.ref, kind: 'sat', parent: s.parent[0] });
    }
    return out;
  }

  function congestionMetric(p, edges, zones, satResults) {
    const b = p.board, cell = CONFIG.cell;
    const bb = G.outlineBBox(b.outline);
    const nx = Math.max(1, Math.ceil((bb.x1 - bb.x0) / cell)), ny = Math.max(1, Math.ceil((bb.y1 - bb.y0) / cell));
    const N = nx * ny;
    const covTop = new Float32Array(N), covBot = new Float32Array(N);
    const inBoard = new Uint8Array(N), blocked = new Uint8Array(N);
    const demand = new Float32Array(N);
    const cellRect = (i, j) => ({ x0: bb.x0 + i * cell, y0: bb.y0 + j * cell, x1: bb.x0 + (i + 1) * cell, y1: bb.y0 + (j + 1) * cell });
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const r = cellRect(i, j);
      inBoard[j * nx + i] = G.pointInBoard(b.outline, G.center(r)) ? 1 : 0;
    }
    const cover = (rect, arr, f) => {
      const i0 = Math.max(0, Math.floor((rect.x0 - bb.x0) / cell)), i1 = Math.min(nx - 1, Math.floor((rect.x1 - bb.x0 - 1e-9) / cell));
      const j0 = Math.max(0, Math.floor((rect.y0 - bb.y0) / cell)), j1 = Math.min(ny - 1, Math.floor((rect.y1 - bb.y0 - 1e-9) / cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        const a = G.overlapArea(rect, cellRect(i, j)) / (cell * cell);
        if (arr) arr[k] = Math.min(1, arr[k] + a * (f ?? 1));
        else if (a > 0.25) blocked[k] = 1;
      }
    };
    for (const o of obstacles(p, satResults)) {
      const f = o.kind === 'part' && BIG_BODY.has(o.shape) ? 0.5 : 1;
      const r = o.rect;
      if (o.side === 'top' || o.side === 'both') cover(r, covTop, f);
      if (o.side === 'bottom' || o.side === 'both') cover(r, covBot, f);
    }
    for (const z of zones || []) if (z.blocksRouting) cover(z.rect, null);

    const ci = (x) => Math.floor((x - bb.x0) / cell), cj = (y) => Math.floor((y - bb.y0) / cell);
    for (const e of edges) {
      const half = 0.5 * e.width;
      const ia = ci(e.a.x), ja = cj(e.a.y), ib = ci(e.b.x), jb = cj(e.b.y);
      // 端点所在格子是引脚本身；L 形估算路径穿过两端器件本体的部分也不计——
      // 实际走线从引脚向外出线，不会穿过自己的芯片（否则峰值总落在主控本体下方）
      const own = [e.a.ref, e.b.ref].map((r) => M.partByRef(p, r)).filter((x) => x && x.placed).map((x) => M.footprint(x));
      const add = (i, j, v) => {
        if ((i === ia && j === ja) || (i === ib && j === jb)) return;
        if (i < 0 || j < 0 || i >= nx || j >= ny) return;
        const cx = bb.x0 + (i + 0.5) * cell, cy = bb.y0 + (j + 0.5) * cell;
        for (const r of own) if (cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1) return;
        demand[j * nx + i] += v;
      };
      const sx = ib >= ia ? 1 : -1, sy = jb >= ja ? 1 : -1;
      // 先横后竖
      for (let i = ia; i !== ib + sx; i += sx) add(i, ja, half);
      for (let j = ja + sy; j !== jb + sy; j += sy) add(ib, j, half);
      // 先竖后横
      for (let j = ja; j !== jb + sy; j += sy) add(ia, j, half);
      for (let i = ia + sx; i !== ib + sx; i += sx) add(i, jb, half);
    }
    const pitch = b.track + b.space;
    const perLayer = cell / pitch;
    const capOf = (k, layers) => {
      if (!inBoard[k] || blocked[k]) return 0;
      const top = 1 - covTop[k];
      const bot = layers >= 2 ? 1 - covBot[k] : 0;
      return perLayer * (top + bot + (CONFIG.innerLayers[layers] ?? Math.max(0, (layers - 2) / 2)));
    };
    const ratio = new Float32Array(N);
    let peak = 0, peakK = -1, peak2 = 0, withDemand = 0, over = 0;
    for (let k = 0; k < N; k++) {
      if (demand[k] <= 0) continue;
      const cap = capOf(k, b.layers), cap2 = capOf(k, 2);
      if (cap > 0.05) {
        const r = demand[k] / cap;
        ratio[k] = r;
        withDemand++;
        if (r > 1) over++;
        if (r > peak) { peak = r; peakK = k; }
      }
      if (cap2 > 0.05) peak2 = Math.max(peak2, demand[k] / cap2);
    }
    const peakPoint = peakK >= 0 ? G.center(cellRect(peakK % nx, Math.floor(peakK / nx))) : null;
    return {
      grid: { x0: bb.x0, y0: bb.y0, nx, ny, cell, ratio },
      peak, peak2, peakPoint, overFrac: withDemand ? over / withDemand : 0,
      status: status(peak, CONFIG.congestion),
    };
  }

  /** 关键网络长度：按 45° 走线估计（射频线等实际走斜线，曼哈顿距离会高估 30%～40%）。 */
  function criticalLengths(edges) {
    const perNet = new Map();
    for (const e of edges) perNet.set(e.net, (perNet.get(e.net) || 0) + G.octilinear(e.a, e.b));
    return perNet;
  }
  function criticalMetric(p, edges, satResults) {
    const items = [];
    const perNet = criticalLengths(edges);
    for (const net of p.nets) {
      const limit = net.max_len || (net.class === 'rf' ? CONFIG.rfDefaultMaxLen : null);
      if (!limit || !perNet.has(net.name)) continue;
      const value = perNet.get(net.name);
      items.push({ kind: 'net', name: net.name, value, limit, ok: value <= limit, refs: net.pins.map((q) => q[0]) });
    }
    for (const [ref, r] of Object.entries(satResults || {})) {
      if (!r.considered) continue;
      items.push({ kind: 'sat', name: `${ref} → ${r.parentRef}`, ref, value: r.dist, limit: r.limit, ok: r.ok, refs: [ref, r.parentRef].concat(r.blocker ? [r.blocker] : []), unplaced: !r.placed, rf: r.rf });
    }
    const bad = items.filter((x) => !x.ok);
    let st = 'good';
    if (bad.length) st = bad.every((x) => !x.unplaced && x.value <= x.limit * CONFIG.criticalWarnFactor) ? 'warn' : 'bad';
    return { items, violations: bad.length, status: st };
  }

  function exitMetric(p, satResults) {
    const b = p.board, pitch = b.track + b.space;
    const obs = obstacles(p, satResults);
    const keep = (b.keepouts || []).map((k) => ({ x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h }));
    const list = [];
    for (const pt of p.parts) {
      if (!pt.placed) continue;
      const total = pt.pins.reduce((s, q) => s + (q.side === 'C' ? 0 : q.count), 0);
      if (total < CONFIG.exitMinPins) continue;
      const fp = M.footprint(pt);
      const need = { N: 0, E: 0, S: 0, W: 0 };
      for (const q of pt.pins) if (q.side !== 'C') need[M.worldSide(q.side, pt.placed)] += q.count;
      for (const side of ['N', 'E', 'S', 'W']) {
        if (!need[side]) continue;
        const d = CONFIG.exitStrip;
        const strip = side === 'N' ? { x0: fp.x0, y0: fp.y1, x1: fp.x1, y1: fp.y1 + d }
          : side === 'S' ? { x0: fp.x0, y0: fp.y0 - d, x1: fp.x1, y1: fp.y0 }
          : side === 'E' ? { x0: fp.x1, y0: fp.y0, x1: fp.x1 + d, y1: fp.y1 } : { x0: fp.x0 - d, y0: fp.y0, x1: fp.x0, y1: fp.y1 };
        const step = 0.25;
        let tot = 0, freeW = 0;
        const blockers = new Map();
        for (let y = strip.y0 + step / 2; y < strip.y1; y += step) for (let x = strip.x0 + step / 2; x < strip.x1; x += step) {
          tot++;
          const q = { x, y };
          if (!G.pointInBoard(b.outline, q) || keep.some((k) => G.containsPoint(k, q))) continue;
          let w = 1;
          for (const o of obs) {
            if (o.ref === pt.ref) continue;
            if (!(o.side === 'both' || o.side === pt.placed.side)) continue;
            if (!G.containsPoint(o.rect, q)) continue;
            const own = o.kind === 'sat' && o.parent === pt.ref;
            w = Math.min(w, own ? 0.5 : 0);
            if (!own) blockers.set(o.ref, (blockers.get(o.ref) || 0) + 1);
          }
          freeW += w;
        }
        const edgeLen = side === 'N' || side === 'S' ? G.width(fp) : G.height(fp);
        let channels = (tot ? freeW / tot : 0) * edgeLen / pitch;
        if (b.layers >= 4) channels *= 1.5;
        const ratio = need[side] / Math.max(channels, 0.1);
        const blocker = [...blockers.entries()].sort((x, y) => y[1] - x[1])[0];
        list.push({ ref: pt.ref, side, need: need[side], channels, ratio, blocker: blocker ? blocker[0] : null });
      }
    }
    list.sort((x, y) => y.ratio - x.ratio);
    const max = list.length ? list[0].ratio : 0;
    return { max, list, worst: list[0] || null, status: status(max, CONFIG.exit) };
  }

  function layerMetric(p, cross, cong) {
    const reasons = [];
    const hasRf = p.nets.some((n) => n.class === 'rf');
    let layers = 2;
    if (hasRf) { layers = 4; reasons.push('有射频网络：50 Ω 走线和天线需要完整的参考地平面'); }
    if (cong.peak2 > 1.0) { layers = 4; reasons.push(`按 2 层板估算的拥挤峰值为 ${Math.round(cong.peak2 * 100)}%，超过容量`); }
    if (cross.density > CONFIG.layerCrossDensity) { layers = 4; reasons.push(`交叉密度 ${cross.density.toFixed(1)} 个/cm²，2 层板需要大量过孔`); }
    if (layers === 2) {
      reasons.push(`交叉 ${cross.value} 个，可在 2 层板上用过孔处理`);
      reasons.push('前提：底层大面积铺地并保持连续；2 层板上"完整地平面"的假设要靠布线维持');
    }
    const cur = p.board.layers;
    return { layers, reasons, status: layers <= cur ? 'good' : 'warn', current: cur };
  }

  /** 计算全部指标。satResults 来自 LP.satellites.placeAll，zones 来自 LP.rules.zones。 */
  function evaluate(p, satResults, zones) {
    const edges = netEdges(p);
    const length = lengthMetric(p, edges);
    const crossings = crossingMetric(p, edges);
    const congestion = congestionMetric(p, edges, zones, satResults);
    const critical = criticalMetric(p, edges, satResults);
    const exit = exitMetric(p, satResults);
    const layers = layerMetric(p, crossings, congestion);
    return { edges, length, crossings, congestion, critical, exit, layers };
  }
  /** 只算线长和交叉，用于朝向试算。 */
  function quick(p) {
    const edges = netEdges(p);
    return { length: lengthMetric(p, edges).value, crossings: crossingMetric(p, edges).value };
  }

  // ---------- 移动差值 ----------
  const SIDE_CN = { N: '上', S: '下', E: '右', W: '左' };
  function nearestPart(p, pt) {
    let best = null, bd = Infinity;
    for (const x of p.parts) {
      if (!x.placed) continue;
      const d = G.pointRectDist(pt, M.footprint(x));
      if (d < bd) { bd = d; best = x; }
    }
    if (!best) return null;
    const c = best.placed, dx = pt.x - c.x, dy = pt.y - c.y;
    const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'N' : 'S');
    return { ref: best.ref, side };
  }
  const fmt = (v) => (Math.abs(v) < 0.05 ? '0' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1));
  const fmtInt = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
  /** 比较操作前后的指标，生成带原因的说明。 */
  function diff(before, after, p) {
    const lines = [];
    const dLen = after.length.value - before.length.value;
    const dCross = after.crossings.value - before.crossings.value;
    const dPeak = after.congestion.peak - before.congestion.peak;
    if (Math.abs(dLen) >= 0.5) {
      const bm = new Map(before.length.perNet.map((x) => [x.net, x]));
      let top = null, tv = 0;
      for (const x of after.length.perNet) {
        const d = x.total - (bm.get(x.net)?.total || 0);
        if (Math.abs(d) > Math.abs(tv)) { tv = d; top = x; }
      }
      for (const x of before.length.perNet) if (!after.length.perNet.some((y) => y.net === x.net) && Math.abs(x.total) > Math.abs(tv)) { tv = -x.total; top = x; }
      let why = '';
      if (top) why = `：${top.net} ${tv > 0 ? '变长' : '变短'} ${Math.abs(tv / top.width).toFixed(1)} mm${top.width > 1 ? `（${top.width} 根线都${tv > 0 ? '变长' : '变短'}）` : ''}`;
      lines.push({ kind: 'length', good: dLen < 0, text: `线长 ${fmt(dLen)} mm${why}。` });
    }
    if (dCross !== 0) {
      const bm = new Map(before.crossings.pairs.map((x) => [x.a + '|' + x.b, x.n]));
      const am = new Map(after.crossings.pairs.map((x) => [x.a + '|' + x.b, x.n]));
      let top = null, tv = 0;
      for (const k of new Set([...bm.keys(), ...am.keys()])) {
        const d = (am.get(k) || 0) - (bm.get(k) || 0);
        if (Math.sign(d) === Math.sign(dCross) && Math.abs(d) > Math.abs(tv)) { tv = d; top = k; }
      }
      let why = '';
      if (top) { const [a, b] = top.split('|'); why = dCross > 0 ? `：${a} 与 ${b} 互相穿过` : `：${a} 与 ${b} 不再交叉`; }
      lines.push({ kind: 'crossings', good: dCross < 0, text: `交叉 ${fmtInt(dCross)}${why}。` });
    }
    if (Math.abs(dPeak) >= 0.15) {
      const near = after.congestion.peakPoint ? nearestPart(p, after.congestion.peakPoint) : null;
      const where = near ? `：${near.ref} ${SIDE_CN[near.side]}侧附近` : '';
      lines.push({ kind: 'congestion', good: dPeak < 0, text: `拥挤峰值从 ${Math.round(before.congestion.peak * 100)}% ${dPeak > 0 ? '升' : '降'}到 ${Math.round(after.congestion.peak * 100)}%${where}。` });
    }
    return { dLen, dCross, dPeak, lines };
  }

  // ---------- 朝向建议 ----------
  /** 在原位置试算其余三个朝向；legal(part, placed) 判断是否可放。返回明显更好的朝向或 null。 */
  function orientationSuggestion(p, ref, legal) {
    const part = M.partByRef(p, ref);
    if (!part || !part.placed || part.locked) return null;
    const orig = part.placed;
    const cur = quick(p);
    let best = null;
    for (const rot of M.ROTS) {
      if (rot === orig.rot) continue;
      const trial = { ...orig, rot };
      if (legal && !legal(part, trial)) continue;
      part.placed = trial;
      const q = quick(p);
      part.placed = orig;
      if (!best || q.crossings < best.crossings || (q.crossings === best.crossings && q.length < best.length)) best = { rot, ...q };
    }
    part.placed = orig;
    if (!best) return null;
    const dCross = best.crossings - cur.crossings;
    const dLenPct = cur.length > 0 ? (best.length - cur.length) / cur.length : 0;
    const better = -dCross >= CONFIG.orientMinCross || (dCross <= 0 && -dLenPct >= CONFIG.orientMinLenPct);
    if (!better) return null;
    const turn = ((best.rot - orig.rot) + 360) % 360;
    return { ref, rot: best.rot, turn, dCross, dLenPct };
  }

  LP.metrics = {
    CONFIG, status, netNodes, mst, netEdges, obstacles, criticalLengths,
    lengthMetric, crossingMetric, congestionMetric, criticalMetric, exitMetric, layerMetric,
    evaluate, quick, diff, orientationSuggestion, nearestPart,
  };
})(globalThis.LP = globalThis.LP || {});
