// 布线后（阶段 R）：用两块合成板的铜皮数据包检查铜皮求解与离线检查。
// 数据包由 tests/fixtures/make_demo_pcb.py + scripts/extract_copper.py 生成（见 tests/test_extract_copper.py）。
const test = require('node:test');
const assert = require('node:assert');
const { loadV, readJSON } = require('./vload.js');

const LP = loadV();
const proj = readJSON('assets/layout-verify-example.json');
const good = readJSON('tests/fixtures/copper-demo-plane.json');
const bad = readJSON('tests/fixtures/copper-demo-trace.json');
const rules = (fs) => new Set(fs.map((f) => f.rule));
const loadIdx = (s, ref) => s.loads.find((l) => l.part === ref).i;

test('数据包载入：阶段 R，网格与数据包逐格对齐，结论不带"估计："', () => {
  const s = LP.analysis.init(proj, good);
  assert.strictEqual(s.stage, 'R');
  assert.strictEqual(s.grid.nx, good.grid.nx);
  assert.strictEqual(s.grid.cell, good.grid.cell);
  const e = LP.analysis.emi({});
  for (const f of e.findings) assert.ok(!f.title.startsWith('估计：'));
});

test('base64 游程解码与 Python 端一致', () => {
  const n = good.nets.find((q) => q.name === 'GND');
  const N = good.grid.nx * good.grid.ny;
  const cov = LP.copper.rleDecode(n.cov['1'], N);
  assert.strictEqual(cov.length, N);
  let full = 0; for (const v of cov) if (v > 0.5) full++;
  assert.ok(full / N > 0.6);
});

test('好板：四个负载都能在铜皮上求解，射频负载下方有地，没有布线问题', () => {
  const s = LP.analysis.init(proj, good);
  for (const l of s.loads) {
    const r = LP.analysis.current(l.i);
    assert.ok(!r.error, r.error);
    assert.ok(r.supPts.length > 1 && r.retPts.length > 1);
    assert.ok(r.dropV > 0 && r.dropV < 0.01);
  }
  const u1 = LP.analysis.current(loadIdx(s, 'U1'));
  assert.ok(u1.gapFrac < 0.05);
  assert.ok(!rules(u1.findings).has('VF-05'));
  const e = LP.analysis.emi({});
  for (const id of ['VF-08', 'VF-09', 'VF-14']) assert.ok(!rules(e.findings).has(id), id);
});

test('坏板：射频参考缺口、并行耦合、地铜孤岛都能查出来', () => {
  const s = LP.analysis.init(proj, bad);
  const e = LP.analysis.emi({});
  for (const id of ['VF-08', 'VF-09', 'VF-14']) assert.ok(rules(e.findings).has(id), id);
  const u1 = LP.analysis.current(loadIdx(s, 'U1'));
  assert.ok(rules(u1.findings).has('VF-05'));
});

test('坏板加大电流：细颈触发 VF-01，压降随电流线性增长并触发 VF-02', () => {
  const p = JSON.parse(JSON.stringify(proj));
  const L = p.verify.loads.find((l) => l.part === 'U1');
  L.i_avg_ma = 20;
  let s = LP.analysis.init(p, bad);
  const d1 = LP.analysis.current(loadIdx(s, 'U1')).dropV;
  L.i_avg_ma = 3000;   // 细颈约 12 方、整条 VDD 约 20 mΩ：3 A 时压降约 2.5%
  s = LP.analysis.init(p, bad);
  const r = LP.analysis.current(loadIdx(s, 'U1'));
  assert.ok(Math.abs(r.dropV / d1 - 150) < 1, `线性：${r.dropV / d1}`);
  const f1 = r.findings.find((f) => f.rule === 'VF-01');
  assert.ok(f1, 'VF-01');
  assert.ok(Math.abs(f1.value - 0.1) < 1e-6);
  assert.ok(rules(r.findings).has('VF-02'));
});

test('地平面开槽让最低谐振频率下降', () => {
  LP.analysis.init(proj, good);
  const a = LP.analysis.modes({});
  LP.analysis.init(proj, bad);
  const b = LP.analysis.modes({});
  assert.ok(b.modes[0].f < a.modes[0].f);
});

test('热分析使用真实铜覆盖率', () => {
  LP.analysis.init(proj, good);
  const t = LP.analysis.thermal({});
  assert.ok(Number.isFinite(t.tmax) && t.tmax > t.ta);
  const P = t.P;
  let loss = 0; for (const q of t.parts) loss += q.p;
  assert.ok(Math.abs(loss - P) < 1e-6);
});
