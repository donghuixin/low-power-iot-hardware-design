// 验证器的单调性测试：做一个已知会让情况变好或变坏的改动，断言指标朝正确方向变化。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadV, readJSON } = require('./vload');
const LP = loadV();
const A = LP.analysis;
const good = () => readJSON('assets/layout-verify-example.json');
const bad = () => readJSON('tests/fixtures/verify-bad.json');
const loadIdx = (ref) => A.state.v.loads.findIndex((l) => l.part === ref);
const has = (r, id) => (r.findings || []).some((f) => f.rule === id);

test('默认值补全：缺 verify 块时仍能给出负载、干扰源和叠层', () => {
  const p = good(); delete p.verify;
  const s = A.init(p);
  assert.ok(s.loads.length >= 4 && s.loads.every((l) => l.def));
  assert.ok(s.defaults.includes('loads') && s.defaults.includes('stackup'));
  assert.ok(s.emitters.some((e) => e.kind === 'antenna'));
});

test('去耦电容挪远 → 高频小回路变大并触发 VF-04', () => {
  A.init(good());
  const near = A.current(loadIdx('U1'));
  assert.ok(!has(near, 'VF-04'));
  const p = good();
  for (const s of p.satellites) if (s.parent && s.parent[0] === 'U1' && ['decoupling', 'bulk'].includes(s.kind)) s.placed = { x: 12, y: 6, rot: 0, side: 'top' };
  A.init(p);
  const far = A.current(loadIdx('U1'));
  assert.ok(far.hfLoop == null || far.hfLoop > (near.hfLoop || 0));
  assert.ok(has(far, 'VF-04'), '应触发 VF-04');
});

test('2 层板：在去程上加禁布区 → 去程变长；电流加倍 → 建议线宽变大', () => {
  A.init(good());
  const st2 = { planes: [], cu_oz: [1, 1], h_mm: 1.6, er: 4.4 };
  const i = loadIdx('U4');
  const a = A.current(i, { stackup: st2 });
  assert.strictEqual(a.supMode, 'route');
  assert.ok(a.loopArea > 0 && a.noPlane);
  const p = good();
  const mid = a.supPts[Math.floor(a.supPts.length / 2)];
  p.board.keepouts = [{ x: mid[0] - 2, y: mid[1] - 2, w: 4, h: 4 }];
  A.init(p);
  const b = A.current(loadIdx('U4'), { stackup: st2 });
  assert.ok(b.supLen > a.supLen, `${b.supLen} > ${a.supLen}`);
  const p2 = good(); p2.verify.loads.find((l) => l.part === 'U4').i_avg_ma = 2000;
  A.init(p2);
  const c = A.current(loadIdx('U4'), { stackup: st2 });
  assert.ok(c.wReq > a.wReq);
});

test('地平面开槽挡在高频去程下方 → 回流绕行，触发 VF-05', () => {
  const stG = { planes: [{ layer: 1, net: 'GND' }], cu_oz: [1, 0.5, 0.5, 1], h_mm: 0.2, er: 4.4 };
  A.init(good());
  const a = A.current(loadIdx('U1'), { stackup: stG });
  assert.strictEqual(a.retMode, 'image');
  const p = good();
  const q = a.supPts[Math.floor(a.supPts.length / 2)];
  p.verify.plane_cuts = [{ x: q[0] - 6, y: q[1] - 0.6, w: 12, h: 1.2 }, { x: q[0] - 0.6, y: q[1] - 6, w: 1.2, h: 12 }];
  A.init(p);
  const b = A.current(loadIdx('U1'), { stackup: stG });
  assert.strictEqual(b.retMode, 'detour');
  assert.ok(has(b, 'VF-05'));
  assert.ok(b.loopArea > a.loopArea);
});

test('温度：加散热器、加风、大面积铺铜都让结温下降；能量守恒', () => {
  const p = good(); p.verify.thermal = [{ part: 'U1', p_w: 1.2 }, { part: 'U4', p_w: 0.2 }];
  A.init(p);
  const base = A.thermal({});
  const u1 = (r) => r.parts.find((q) => q.ref === 'U1').tj;
  assert.ok(Math.abs(base.loss - base.P) / base.P < 0.02, `散出 ${base.loss} 输入 ${base.P}`);
  assert.ok(u1(A.thermal({ heatsinks: { U1: 0.25 } })) < u1(base));
  assert.ok(u1(A.thermal({ env: { airflow_m_s: 1 } })) < u1(base));
  assert.ok(u1(A.thermal({ copper: [{ rect: { x0: -99, y0: -99, x1: 99, y1: 99 }, cov: 0.9 }] })) < u1(base));
  assert.ok(base.findings.some((f) => f.rule === 'VF-11'), '1.2 W 的 QFN 应接近或超过结温上限');
});

test('电磁：敏感器件离干扰源越远等级越低；移到背面（隔整层地）等级下降', () => {
  const lv = (p, ref) => { A.init(p); return A.emi({}).victims.find((v) => v.label === ref).level; };
  const p0 = good(), y0 = lv(p0, 'U3');
  const p1 = good(); p1.parts.find((x) => x.ref === 'U3').placed = { x: 3, y: 3, rot: 0, side: 'top' };
  assert.ok(lv(p1, 'U3') < y0);
  const p2 = good(); const u3 = p2.parts.find((x) => x.ref === 'U3'); u3.sides = ['top', 'bottom']; u3.placed = { ...u3.placed, side: 'bottom' };
  assert.ok(lv(p2, 'U3') < y0 - 20);
});

test('矩形 4 层板第一平面模态 ≈ c / (2·√εr·L)', () => {
  const p = good();
  p.board.outline = { type: 'rect', w: 36, h: 28, corner_r: 0 }; p.board.holes = [];
  p.parts = p.parts.filter((x) => x.role !== 'antenna'); p.nets = p.nets.filter((n) => n.class !== 'rf');
  p.satellites = p.satellites.filter((s) => s.parent[1] !== 'RF');
  A.init(p);
  const md = A.modes({});
  const want = 299792458 / (2 * Math.sqrt(4.4) * 0.036);
  assert.ok(Math.abs(md.modes[0].f - want) / want < 0.05, `${md.modes[0].f} vs ${want}`);
});

test('校准：待修正示例的 P1 及以上结论明显多于验证示例', () => {
  A.init(good()); const g = A.report({});
  A.init(bad()); const b = A.report({});
  const n = (r) => r.findings.filter((f) => f.sev === 'P0' || f.sev === 'P1').length;
  assert.ok(n(b) >= n(g) + 2, `bad ${n(b)} vs good ${n(g)}`);
  assert.ok(g.findings.every((f) => f.title.startsWith('估计：')), '布线前结论都应以"估计："开头');
});
