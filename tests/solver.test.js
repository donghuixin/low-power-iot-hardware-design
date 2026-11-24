// 求解器对有解析解的情形：误差 < 5%。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadV } = require('./vload');
const LP = loadV();
const S = LP.solver;

test('均匀长条：电流密度均匀，等于 I ÷ 宽度', () => {
  const nx = 80, ny = 20, cell = 0.5e-3, I = 2;
  const mask = new Uint8Array(nx * ny).fill(1);
  const src = [], fixed = [];
  for (let j = 0; j < ny; j++) { src.push({ cell: j * nx, q: I / ny }); fixed.push(j * nx + nx - 1); }
  const r = S.solveGrid({ nx, ny, mask, src, fixed, tol: 1e-8 });
  const fl = S.flux(nx, ny, r.field, null, cell);
  const want = I / (ny * cell);
  for (const i of [20, 40, 60]) for (const j of [3, 10, 16]) {
    const v = fl.mag[j * nx + i];
    assert.ok(Math.abs(v - want) / want < 0.05, `(${i},${j}) ${v} vs ${want}`);
  }
});

test('一维散热片：温度分布符合 cosh 解析解', () => {
  const nx = 300, ny = 1, k = 1, hc = 1e-3, Q = 1;
  const mask = new Uint8Array(nx).fill(1), coeff = new Float32Array(nx).fill(k), hdiag = new Float64Array(nx).fill(hc);
  const r = S.solveGrid({ nx, ny, mask, coeff, hdiag, src: [{ cell: 0, q: Q }], tol: 1e-10, maxIt: 5000 });
  const m = Math.sqrt(hc / k), L = nx;
  const ana = (x) => (Q / (k * m)) * Math.cosh(m * (L - x)) / Math.sinh(m * L);
  for (const x of [0, 30, 80, 150]) {
    const v = r.field[x], a = ana(x + 0.5);
    assert.ok(Math.abs(v - a) / a < 0.05, `x=${x} ${v} vs ${a}`);
  }
  let loss = 0; for (let i = 0; i < nx; i++) loss += hc * r.field[i];
  assert.ok(Math.abs(loss - Q) / Q < 0.02, '能量守恒 ' + loss);
});

test('矩形腔体：前 3 个模态频率与解析值相差 < 5%', () => {
  const nx = 48, ny = 36;
  const ms = S.modes({ nx, ny, mask: new Uint8Array(nx * ny).fill(1), nModes: 3, iters: 40 });
  const want = [Math.PI / nx, Math.PI / ny, Math.hypot(Math.PI / nx, Math.PI / ny)];
  ms.forEach((m, i) => { const k = Math.sqrt(m.lambda); assert.ok(Math.abs(k - want[i]) / want[i] < 0.05, `mode ${i + 1}: ${k} vs ${want[i]}`); });
});

test('多重网格预条件与 Jacobi 结果一致，迭代次数大幅减少', () => {
  const nx = 120, ny = 90, mask = new Uint8Array(nx * ny).fill(1);
  const L = S.gridLinks(nx, ny, mask, null), d = new Float64Array(L.n); d[0] = 1e6;
  const A = S.assemble(L.n, L.links, L.g, d), b = new Float64Array(L.n); b[L.n - 1] = 1;
  const a = S.pcg(A, b, { tol: 1e-6 }), m = S.pcg(A, b, { tol: 1e-6, levels: S.amgSetup(A, L.coords) });
  assert.ok(m.iters * 5 < a.iters, `${m.iters} vs ${a.iters}`);
  assert.ok(Math.abs(m.x[L.n - 1] - a.x[L.n - 1]) / a.x[L.n - 1] < 1e-3);
});
