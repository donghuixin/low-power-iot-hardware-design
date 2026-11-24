// 布线前的候选路径集合：在可走区域上多次带随机扰动的 A*，叠加成"走线经过概率"图。
(function (LP) {
  'use strict';
  const S = LP.solver;

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  /** 平滑随机场：粗网格随机数双线性插值，幅度 ±amp。 */
  function smoothNoise(nx, ny, step, amp, rand) {
    const gx = Math.ceil(nx / step) + 2, gy = Math.ceil(ny / step) + 2;
    const r = new Float32Array(gx * gy);
    for (let k = 0; k < r.length; k++) r[k] = (rand() * 2 - 1) * amp;
    const out = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const u = i / step, v = j / step, i0 = Math.floor(u), j0 = Math.floor(v), fu = u - i0, fv = v - j0;
      const a = r[j0 * gx + i0], b = r[j0 * gx + i0 + 1], c = r[(j0 + 1) * gx + i0], d = r[(j0 + 1) * gx + i0 + 1];
      out[j * nx + i] = a * (1 - fu) * (1 - fv) + b * fu * (1 - fv) + c * (1 - fu) * fv + d * fu * fv;
    }
    return out;
  }

  /** 二叉堆。 */
  class Heap {
    constructor() { this.k = []; this.v = []; }
    push(key, val) { const k = this.k, v = this.v; k.push(key); v.push(val); let i = k.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; } }
    pop() {
      const k = this.k, v = this.v, top = v[0], last = k.length - 1;
      k[0] = k[last]; v[0] = v[last]; k.pop(); v.pop();
      let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < k.length && k[l] < k[m]) m = l; if (r < k.length && k[r] < k[m]) m = r; if (m === i) break; [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m; }
      return top;
    }
    get size() { return this.k.length; }
  }

  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

  /** A*：cost<=0 或非有限的格子不可走。返回格子序列或 null。 */
  function astar(nx, ny, cost, from, to) {
    const N = nx * ny, g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const ti = to % nx, tj = (to / nx) | 0;
    const h = (c) => { const dx = Math.abs((c % nx) - ti), dy = Math.abs(((c / nx) | 0) - tj); return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * 0.7; };
    const heap = new Heap();
    g[from] = 0; heap.push(h(from), from);
    while (heap.size) {
      const c = heap.pop();
      if (closed[c]) continue;
      if (c === to) break;
      closed[c] = 1;
      const i = c % nx, j = (c / nx) | 0;
      for (const [dx, dy, w] of DIRS) {
        const ii = i + dx, jj = j + dy;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const d = jj * nx + ii;
        if (closed[d] || !(cost[d] > 0) || !Number.isFinite(cost[d])) continue;
        if (w > 1 && (!(cost[j * nx + ii] > 0) || !(cost[jj * nx + i] > 0))) continue; // 不切角
        const ng = g[c] + w * 0.5 * (cost[c] + cost[d]);
        if (ng < g[d]) { g[d] = ng; came[d] = c; heap.push(ng + h(d), d); }
      }
    }
    if (came[to] < 0 && from !== to) return null;
    const path = [to];
    let c = to;
    while (c !== from) { c = came[c]; if (c < 0) return null; path.push(c); }
    return path.reverse();
  }

  function pathLen(nx, path, cell) {
    let L = 0;
    for (let k = 1; k < path.length; k++) { const a = path[k - 1], b = path[k]; L += Math.hypot((a % nx) - (b % nx), ((a / nx) | 0) - ((b / nx) | 0)); }
    return L * cell;
  }

  /**
   * 两个引脚之间的候选路径集合。
   * base: 基础代价（>0 可走）；a、b: {x, y, nx, ny}；opts.n 路径数，opts.seed。
   * 返回 {f(经过概率 0..1), dx, dy(方向), best(格子序列), bestLen, spread(mm), lens}
   */
  function ensemble(grid, base, a, b, opts = {}) {
    const { nx, ny, cell } = grid, N = nx * ny;
    const n = opts.n ?? 16, rand = rng(opts.seed ?? 7);
    const ca = grid.at(a.x, a.y), cb = grid.at(b.x, b.y);
    // 引脚出线扇区：背向出线方向的格子要绕路，代价高
    const fan = new Float32Array(N);
    const R = 2.5;
    for (const p of [a, b]) {
      if (!(p.nx || p.ny)) continue;
      const r = Math.ceil(R / cell);
      const pi = Math.floor((p.x - grid.x0) / cell), pj = Math.floor((p.y - grid.y0) / cell);
      for (let j = Math.max(0, pj - r); j <= Math.min(ny - 1, pj + r); j++) for (let i = Math.max(0, pi - r); i <= Math.min(nx - 1, pi + r); i++) {
        const dx = grid.cx(i) - p.x, dy = grid.cy(j) - p.y, d = Math.hypot(dx, dy);
        if (d > R || d < 1e-6) continue;
        const cos = (dx * p.nx + dy * p.ny) / d;
        fan[j * nx + i] += 1.5 * ((1 - cos) / 2) ** 2 * (1 - d / R);
      }
    }
    const f = new Float32Array(N), dxs = new Float32Array(N), dys = new Float32Array(N);
    const paths = [], lens = [];
    for (let k = 0; k < n; k++) {
      const noise = k === 0 ? null : smoothNoise(nx, ny, Math.max(3, Math.round(2 / cell)), 0.3, rand);
      const cost = new Float32Array(N);
      for (let c = 0; c < N; c++) cost[c] = base[c] > 0 ? base[c] * (1 + (noise ? noise[c] : 0)) + fan[c] : 0;
      cost[ca] = Math.max(cost[ca], 1); cost[cb] = Math.max(cost[cb], 1);
      const path = astar(nx, ny, cost, ca, cb);
      if (!path) continue;
      paths.push(path); lens.push(pathLen(nx, path, cell));
    }
    if (!paths.length) return null;
    const lmin = Math.min(...lens);
    let wsum = 0;
    const ws = lens.map((L) => Math.exp(-4 * (L / lmin - 1)));
    paths.forEach((path, k) => {
      const w = ws[k]; wsum += w;
      for (let q = 0; q < path.length; q++) {
        const c = path[q], pr = path[Math.max(0, q - 1)], nx2 = path[Math.min(path.length - 1, q + 1)];
        let ddx = (nx2 % nx) - (pr % nx), ddy = ((nx2 / nx) | 0) - ((pr / nx) | 0);
        const dl = Math.hypot(ddx, ddy) || 1;
        f[c] += w; dxs[c] += (w * ddx) / dl; dys[c] += (w * ddy) / dl;
      }
    });
    for (let c = 0; c < N; c++) if (f[c] > 0) { f[c] /= wsum; }
    // 路径离散程度：各路径到最短路径的平均距离（mm）
    const best = paths[lens.indexOf(lmin)];
    const bestSet = best.map((c) => [c % nx, (c / nx) | 0]);
    let spread = 0;
    paths.forEach((path, k) => {
      if (path === best) return;
      let s = 0;
      for (let q = 0; q < path.length; q += 3) {
        const i = path[q] % nx, j = (path[q] / nx) | 0;
        let m = Infinity;
        for (const [bi, bj] of bestSet) { const d = (bi - i) ** 2 + (bj - j) ** 2; if (d < m) m = d; }
        s += Math.sqrt(m);
      }
      spread += (ws[k] * s / Math.ceil(path.length / 3)) * cell;
    });
    spread = wsum > ws[lens.indexOf(lmin)] ? spread / (wsum - ws[lens.indexOf(lmin)]) : 0;
    return { f, dx: dxs, dy: dys, best, bestLen: lmin, spread, lens, paths };
  }

  /** 把格子序列转成 mm 折线（每隔 step 格取一点）。 */
  function toPolyline(grid, path, step = 2) {
    const pts = [];
    for (let q = 0; q < path.length; q += step) pts.push([grid.cx(path[q] % grid.nx), grid.cy((path[q] / grid.nx) | 0)]);
    const last = path[path.length - 1];
    pts.push([grid.cx(last % grid.nx), grid.cy((last / grid.nx) | 0)]);
    return pts;
  }
  function polyLen(pts) { let L = 0; for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return L; }
  /** 去程 + 反向回程围成的面积（mm²，鞋带公式取绝对值）。 */
  function loopArea(sup, ret) {
    const poly = sup.concat(ret.slice().reverse());
    let s = 0;
    for (let k = 0; k < poly.length; k++) { const [x1, y1] = poly[k], [x2, y2] = poly[(k + 1) % poly.length]; s += x1 * y2 - x2 * y1; }
    return Math.abs(s) / 2;
  }

  LP.routes = { rng, smoothNoise, astar, ensemble, toPolyline, polyLen, loopArea, pathLen };
})(globalThis.LP = globalThis.LP || {});
