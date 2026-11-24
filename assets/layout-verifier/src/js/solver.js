// 公共求解内核：对称正定稀疏系统的预条件共轭梯度法、规则网格上的拉普拉斯组装、低阶特征模态。
// 纯函数，不碰 DOM；Worker 与 Node 测试都能直接调用。
(function (LP) {
  'use strict';

  /**
   * 由"节点数 + 连接表 + 对角附加项"组装 CSR 矩阵（图拉普拉斯 + 对角）。
   * links: Int32Array/Array [a0,b0,a1,b1,...]，g: 每条连接的电导（或热导）。
   * diagAdd: Float64Array(n)，加在对角上（对流散热、Dirichlet 罚项等）。
   */
  function assemble(n, links, g, diagAdd) {
    const deg = new Int32Array(n);
    const m = g.length;
    for (let k = 0; k < m; k++) { deg[links[2 * k]]++; deg[links[2 * k + 1]]++; }
    const rowPtr = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) rowPtr[i + 1] = rowPtr[i] + deg[i] + 1;
    const col = new Int32Array(rowPtr[n]);
    const val = new Float64Array(rowPtr[n]);
    const fill = new Int32Array(n);
    const diag = new Float64Array(n);
    for (let i = 0; i < n; i++) { col[rowPtr[i]] = i; fill[i] = 1; }
    for (let k = 0; k < m; k++) {
      const a = links[2 * k], b = links[2 * k + 1], w = g[k];
      if (!(w > 0)) continue;
      diag[a] += w; diag[b] += w;
      let p = rowPtr[a] + fill[a]++; col[p] = b; val[p] = -w;
      p = rowPtr[b] + fill[b]++; col[p] = a; val[p] = -w;
    }
    for (let i = 0; i < n; i++) {
      val[rowPtr[i]] = diag[i] + (diagAdd ? diagAdd[i] : 0);
      // 未用到的预留位（g=0 的连接）保持 col=i、val=0，不影响结果
      for (let p = rowPtr[i] + fill[i]; p < rowPtr[i + 1]; p++) { col[p] = i; val[p] = 0; }
    }
    return { n, rowPtr, col, val };
  }

  function matvec(A, x, y) {
    const { n, rowPtr, col, val } = A;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) s += val[p] * x[col[p]];
      y[i] = s;
    }
  }

  // ---------- 聚合多重网格（作为 CG 的预条件） ----------
  /** 由节点坐标 (layer, i, j) 按 2×2 聚合；返回每个节点的粗节点编号和粗节点数。 */
  function aggregate(n, coords) {
    const map = new Map(), agg = new Int32Array(n);
    for (let a = 0; a < n; a++) {
      const k = coords[3 * a] * 1e8 + (coords[3 * a + 1] >> 1) * 1e4 + (coords[3 * a + 2] >> 1);
      let id = map.get(k);
      if (id === undefined) { id = map.size; map.set(k, id); }
      agg[a] = id;
    }
    const cc = new Int32Array(map.size * 3);
    for (let a = 0; a < n; a++) { const I = agg[a]; cc[3 * I] = coords[3 * a]; cc[3 * I + 1] = coords[3 * a + 1] >> 1; cc[3 * I + 2] = coords[3 * a + 2] >> 1; }
    return { agg, nc: map.size, coords: cc };
  }
  /** Galerkin 粗化：Ac = Pᵀ A P，P 为分片常数。 */
  function galerkin(A, agg, nc) {
    const rows = Array.from({ length: nc }, () => new Map());
    for (let a = 0; a < A.n; a++) {
      const I = agg[a], row = rows[I];
      for (let p = A.rowPtr[a]; p < A.rowPtr[a + 1]; p++) { const J = agg[A.col[p]]; row.set(J, (row.get(J) || 0) + A.val[p]); }
    }
    const rowPtr = new Int32Array(nc + 1);
    for (let I = 0; I < nc; I++) rowPtr[I + 1] = rowPtr[I] + rows[I].size + (rows[I].has(I) ? 0 : 1);
    const col = new Int32Array(rowPtr[nc]), val = new Float64Array(rowPtr[nc]);
    for (let I = 0; I < nc; I++) {
      let q = rowPtr[I];
      col[q] = I; val[q] = rows[I].get(I) || 0; q++;
      for (const [J, w] of rows[I]) if (J !== I) { col[q] = J; val[q] = w; q++; }
    }
    return { n: nc, rowPtr, col, val };
  }
  function cholesky(A) {
    const n = A.n, L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let p = A.rowPtr[i]; p < A.rowPtr[i + 1]; p++) L[i * n + A.col[p]] += A.val[p];
    for (let j = 0; j < n; j++) {
      let d = L[j * n + j];
      for (let k = 0; k < j; k++) d -= L[j * n + k] * L[j * n + k];
      d = Math.sqrt(Math.max(d, 1e-300));
      L[j * n + j] = d;
      for (let i = j + 1; i < n; i++) {
        let s = L[i * n + j];
        for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
        L[i * n + j] = s / d;
      }
    }
    return (b, x) => {
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
      for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
    };
  }
  function gs(A, b, x, forward) {
    const { n, rowPtr, col, val } = A;
    const step = (i) => {
      let s = b[i], d = 0;
      for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) { const j = col[p]; if (j === i) d += val[p]; else s -= val[p] * x[j]; }
      if (d > 0) x[i] = s / d;
    };
    if (forward) for (let i = 0; i < n; i++) step(i); else for (let i = n - 1; i >= 0; i--) step(i);
  }
  /** 建立层级。coords：每个节点的 (layer, i, j)。 */
  function amgSetup(A, coords) {
    const levels = [{ A }];
    let cur = A, cc = coords;
    while (cur.n > 300 && levels.length < 12) {
      const ag = aggregate(cur.n, cc);
      if (ag.nc > 0.9 * cur.n) break;
      const Ac = galerkin(cur, ag.agg, ag.nc);
      levels[levels.length - 1].agg = ag.agg;
      levels.push({ A: Ac });
      cur = Ac; cc = ag.coords;
    }
    levels[levels.length - 1].direct = cholesky(cur);
    return levels;
  }
  /** 一次对称 V 循环，作为预条件 z = M⁻¹ r。粗网格校正乘 1.6（非光滑聚合的常用放大）。 */
  function vcycle(levels, l, b, x) {
    const L = levels[l];
    if (L.direct) { L.direct(b, x); return; }
    const A = L.A, n = A.n;
    gs(A, b, x, true);
    const r = new Float64Array(n);
    matvec(A, x, r);
    for (let i = 0; i < n; i++) r[i] = b[i] - r[i];
    const nc = levels[l + 1].A.n, rc = new Float64Array(nc), ec = new Float64Array(nc);
    for (let i = 0; i < n; i++) rc[L.agg[i]] += r[i];
    vcycle(levels, l + 1, rc, ec);
    for (let i = 0; i < n; i++) x[i] += 1.6 * ec[L.agg[i]];
    gs(A, b, x, false);
  }

  /** 预条件共轭梯度：默认 Jacobi；opts.levels 给出时用多重网格 V 循环。返回 {x, iters, residual}（相对残差）。 */
  function pcg(A, b, opts = {}) {
    const n = A.n, tol = opts.tol ?? 1e-4, maxIt = opts.maxIt ?? Math.max(400, 4 * Math.sqrt(n) * 10);
    const x = opts.x0 ? Float64Array.from(opts.x0) : new Float64Array(n);
    const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
    const dinv = new Float64Array(n);
    for (let i = 0; i < n; i++) { const d = A.val[A.rowPtr[i]]; dinv[i] = d > 0 ? 1 / d : 1; }
    matvec(A, x, Ap);
    let bn = 0;
    for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; bn += b[i] * b[i]; }
    bn = Math.sqrt(bn) || 1;
    const lv = opts.levels;
    const prec = (rr, zz) => { if (lv) { zz.fill(0); vcycle(lv, 0, rr, zz); } else for (let i = 0; i < n; i++) zz[i] = rr[i] * dinv[i]; };
    let rz = 0;
    prec(r, z);
    for (let i = 0; i < n; i++) { p[i] = z[i]; rz += r[i] * z[i]; }
    let it = 0, res = 0;
    for (; it < maxIt; it++) {
      let rn = 0;
      for (let i = 0; i < n; i++) rn += r[i] * r[i];
      res = Math.sqrt(rn) / bn;
      if (res < tol) break;
      matvec(A, p, Ap);
      let pAp = 0;
      for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
      if (!(pAp > 0)) break;
      const alpha = rz / pAp;
      for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
      let rz2 = 0;
      prec(r, z);
      for (let i = 0; i < n; i++) rz2 += r[i] * z[i];
      const beta = rz2 / rz;
      rz = rz2;
      for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
    return { x, iters: it, residual: res };
  }

  /**
   * 规则网格上的连接表。mask[c] 为 1 的格子参与；coeff[c] 为格子系数（片电导或片热导），
   * 相邻两格的面系数取调和平均（串联）。返回 {n, index(网格→节点), cells(节点→网格), links, g}。
   */
  function gridLinks(nx, ny, mask, coeff) {
    const index = new Int32Array(nx * ny).fill(-1);
    const cells = [];
    for (let c = 0; c < nx * ny; c++) if (mask[c]) { index[c] = cells.length; cells.push(c); }
    const links = [], g = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i, a = index[c];
      if (a < 0) continue;
      const ka = coeff ? coeff[c] : 1;
      if (i + 1 < nx) { const d = c + 1, b = index[d]; if (b >= 0) { const kb = coeff ? coeff[d] : 1; const w = ka + kb > 0 ? (2 * ka * kb) / (ka + kb) : 0; if (w > 0) { links.push(a, b); g.push(w); } } }
      if (j + 1 < ny) { const d = c + nx, b = index[d]; if (b >= 0) { const kb = coeff ? coeff[d] : 1; const w = ka + kb > 0 ? (2 * ka * kb) / (ka + kb) : 0; if (w > 0) { links.push(a, b); g.push(w); } } }
    }
    const coords = new Int32Array(cells.length * 3);
    cells.forEach((c, a) => { coords[3 * a + 1] = c % nx; coords[3 * a + 2] = (c / nx) | 0; });
    return { n: cells.length, index, cells: Int32Array.from(cells), links: Int32Array.from(links), g: Float64Array.from(g), coords };
  }

  /**
   * 单层网格上的势场：mask 内求解 ∇·(k∇u) − h·u = −s。
   * src: [{cell, q}]，q>0 注入、q<0 抽出；fixed: 网格下标列表，u 固定为 0（大罚项）。
   * 返回网格大小的 Float32Array（mask 外为 NaN）。
   */
  function solveGrid({ nx, ny, mask, coeff, hdiag, src, fixed, tol, maxIt }) {
    const L = gridLinks(nx, ny, mask, coeff);
    const diagAdd = new Float64Array(L.n);
    let gmax = 0;
    for (let k = 0; k < L.g.length; k++) if (L.g[k] > gmax) gmax = L.g[k];
    if (hdiag) for (let a = 0; a < L.n; a++) diagAdd[a] += hdiag[L.cells[a]] || 0;
    for (const c of fixed || []) { const a = L.index[c]; if (a >= 0) diagAdd[a] += gmax * 1e6 + 1; }
    const A = assemble(L.n, L.links, L.g, diagAdd);
    const b = new Float64Array(L.n);
    for (const s of src || []) { const a = L.index[s.cell]; if (a >= 0) b[a] += s.q; }
    const levels = L.n > 1500 ? amgSetup(A, L.coords) : null;
    const r = pcg(A, b, { tol: tol ?? 1e-4, maxIt, levels });
    const out = new Float32Array(nx * ny).fill(NaN);
    for (let a = 0; a < L.n; a++) out[L.cells[a]] = r.x[a];
    return { field: out, iters: r.iters, residual: r.residual };
  }

  /** 由势场求通量密度 q = −k∇u（每格中心差分；mask 外为 0）。返回 {fx, fy, mag}。 */
  function flux(nx, ny, u, coeff, cell) {
    const fx = new Float32Array(nx * ny), fy = new Float32Array(nx * ny), mag = new Float32Array(nx * ny);
    const ok = (c) => Number.isFinite(u[c]);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!ok(c)) continue;
      const k = coeff ? coeff[c] : 1;
      const l = i > 0 && ok(c - 1) ? u[c - 1] : u[c], r = i < nx - 1 && ok(c + 1) ? u[c + 1] : u[c];
      const d = j > 0 && ok(c - nx) ? u[c - nx] : u[c], t = j < ny - 1 && ok(c + nx) ? u[c + nx] : u[c];
      const di = (i > 0 && ok(c - 1) ? 1 : 0) + (i < nx - 1 && ok(c + 1) ? 1 : 0);
      const dj = (j > 0 && ok(c - nx) ? 1 : 0) + (j < ny - 1 && ok(c + nx) ? 1 : 0);
      const gx = di ? (r - l) / (di * cell) : 0, gy = dj ? (t - d) / (dj * cell) : 0;
      fx[c] = -k * gx; fy[c] = -k * gy;
      mag[c] = Math.hypot(fx[c], fy[c]);
    }
    return { fx, fy, mag };
  }

  /**
   * 诺伊曼边界（开路边缘）下 −∇²φ = λφ 的最低 nModes 个非零模态。
   * 块反幂迭代 + Rayleigh–Ritz；去掉常数模态。返回 [{lambda(单位 1/cell²), phi(Float32 网格)}]。
   */
  function modes({ nx, ny, mask, nModes = 4, iters = 24, tol = 1e-5 }) {
    const L = gridLinks(nx, ny, mask, null);
    const n = L.n;
    if (n < 8) return [];
    const shift = 1e-3;
    const diagAdd = new Float64Array(n).fill(shift);
    const A = assemble(n, L.links, L.g, diagAdd);
    const A0 = assemble(n, L.links, L.g, null);
    const levels = n > 1500 ? amgSetup(A, L.coords) : null;
    const k = nModes + 2;
    // 初始子空间：低频余弦组合 + 少量随机，去均值
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
    let V = [];
    for (let m = 0; m < k; m++) {
      const v = new Float64Array(n);
      for (let a = 0; a < n; a++) {
        const c = L.cells[a], i = c % nx, j = (c / nx) | 0;
        v[a] = Math.cos(((m % 3) + 1) * Math.PI * (i + 0.5) / nx) * Math.cos((((m / 3) | 0)) * Math.PI * (j + 0.5) / ny) + 0.1 * rnd();
      }
      V.push(v);
    }
    const dot = (a, b) => { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };
    const orth = (vs) => {
      const out = [];
      for (const v0 of vs) {
        const v = Float64Array.from(v0);
        let mean = 0; for (let i = 0; i < n; i++) mean += v[i]; mean /= n;
        for (let i = 0; i < n; i++) v[i] -= mean;
        for (const u of out) { const d = dot(v, u); for (let i = 0; i < n; i++) v[i] -= d * u[i]; }
        const nr = Math.sqrt(dot(v, v));
        if (nr > 1e-12) { for (let i = 0; i < n; i++) v[i] /= nr; out.push(v); }
      }
      return out;
    };
    V = orth(V);
    let lams = [];
    const tmp = new Float64Array(n);
    for (let it = 0; it < iters; it++) {
      V = orth(V.map((v) => pcg(A, v, { tol: 1e-5, maxIt: 2000, x0: v, levels }).x));
      // Rayleigh–Ritz：小矩阵 H = Vᵀ A0 V，Jacobi 特征分解
      const m = V.length, H = [];
      for (let a = 0; a < m; a++) { matvec(A0, V[a], tmp); H.push(V.map((vb) => dot(tmp, vb))); }
      const { values, vectors } = jacobiEig(H);
      const order = values.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
      const nv = order.map(([, i]) => { const v = new Float64Array(n); for (let b = 0; b < m; b++) { const w = vectors[b][i]; for (let q = 0; q < n; q++) v[q] += w * V[b][q]; } return v; });
      const newL = order.map(([v]) => v);
      V = orth(nv);
      const conv = lams.length && newL.slice(0, nModes).every((v, i) => Math.abs(v - lams[i]) <= tol * Math.max(1e-9, Math.abs(v)));
      lams = newL;
      if (conv) break;
    }
    return lams.slice(0, nModes).map((lambda, idx) => {
      const phi = new Float32Array(nx * ny).fill(NaN);
      let mx = 0;
      for (let a = 0; a < n; a++) mx = Math.max(mx, Math.abs(V[idx][a]));
      for (let a = 0; a < n; a++) phi[L.cells[a]] = V[idx][a] / (mx || 1);
      return { lambda, phi };
    });
  }

  /** 小对称矩阵的 Jacobi 特征分解。返回 {values, vectors(列为特征向量)}。 */
  function jacobiEig(H) {
    const m = H.length;
    const a = H.map((r) => r.slice());
    const v = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let p = 0; p < m; p++) for (let q = p + 1; q < m; q++) off += a[p][q] * a[p][q];
      if (off < 1e-20) break;
      for (let p = 0; p < m; p++) for (let q = p + 1; q < m; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < m; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < m; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < m; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
    return { values: a.map((r, i) => r[i]), vectors: v };
  }

  /** 可分离高斯模糊（mask 外不参与，结果归一化到 mask 内权重）。sigma 单位：格。 */
  function blur(nx, ny, f, sigma, mask) {
    if (!(sigma > 0.3)) return Float32Array.from(f);
    const r = Math.ceil(sigma * 2.5), ker = [];
    for (let k = -r; k <= r; k++) ker.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
    const conv = (src, dx, dy) => {
      const out = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        let s = 0;
        for (let k = -r; k <= r; k++) {
          const ii = i + k * dx, jj = j + k * dy;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          s += ker[k + r] * src[jj * nx + ii];
        }
        out[j * nx + i] = s;
      }
      return out;
    };
    // 归一化卷积：mask 外的格子既不贡献也不稀释
    const fm = new Float32Array(nx * ny), m = new Float32Array(nx * ny);
    for (let c = 0; c < nx * ny; c++) { const w = mask ? (mask[c] ? 1 : 0) : 1; m[c] = w; fm[c] = f[c] * w; }
    const A = conv(conv(fm, 1, 0), 0, 1), B = conv(conv(m, 1, 0), 0, 1);
    const out = new Float32Array(nx * ny);
    for (let c = 0; c < nx * ny; c++) out[c] = m[c] && B[c] > 1e-9 ? A[c] / B[c] : 0;
    return out;
  }

  /** 二值 mask 的欧氏距离变换（两遍 3-4 倒角近似），单位：格。 */
  function distance(nx, ny, free) {
    const INF = 1e9, d = new Float32Array(nx * ny);
    for (let c = 0; c < nx * ny; c++) d[c] = free[c] ? INF : 0;
    const a = 1, b = Math.SQRT2;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i; if (!d[c]) continue;
      let v = d[c];
      if (i > 0) v = Math.min(v, d[c - 1] + a);
      if (j > 0) { v = Math.min(v, d[c - nx] + a); if (i > 0) v = Math.min(v, d[c - nx - 1] + b); if (i < nx - 1) v = Math.min(v, d[c - nx + 1] + b); }
      d[c] = v;
    }
    for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
      const c = j * nx + i; if (!d[c]) continue;
      let v = d[c];
      if (i < nx - 1) v = Math.min(v, d[c + 1] + a);
      if (j < ny - 1) { v = Math.min(v, d[c + nx] + a); if (i < nx - 1) v = Math.min(v, d[c + nx + 1] + b); if (i > 0) v = Math.min(v, d[c + nx - 1] + b); }
      d[c] = v;
    }
    return d;
  }

  LP.solver = { assemble, matvec, pcg, amgSetup, vcycle, gridLinks, solveGrid, flux, modes, jacobiEig, blur, distance };
})(globalThis.LP = globalThis.LP || {});
