// M4：卫星器件自动贴放
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadLP, loadExample, place } = require('./load.js');
const { GOOD } = require('./layouts.js');

const LP = loadLP();
const M = LP.model, G = LP.geometry;

/** 同一面上的器件与卫星两两不重叠，且都在板内。 */
function assertClean(p) {
  const items = [];
  for (const x of p.parts) if (x.placed) items.push({ ref: x.ref, r: M.footprint(x), side: x.placed.side });
  for (const s of p.satellites) if (s.placed && s._active) items.push({ ref: s.ref, r: M.satFootprint(s), side: s.placed.side, sat: true });
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.sat) assert.ok(G.rectInBoard(p.board.outline, a.r), `${a.ref} 在板内`);
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (a.side !== b.side || (!a.sat && !b.sat)) continue;
      assert.ok(!G.overlaps(a.r, b.r), `${a.ref} 与 ${b.ref} 重叠`);
    }
  }
}

test('好布局：所有卫星都放在距离上限内且互不重叠', () => {
  const p = place(LP, loadExample(LP), GOOD);
  const ev = LP.engine.evaluate(p);
  for (const s of p.satellites) {
    const r = ev.satResults[s.ref];
    assert.ok(r.placed && r.ok, `${s.ref}: ${r.msg || ''} dist=${r.dist}`);
  }
  assertClean(p);
});

test('移动、旋转主控后去耦电容跟随', () => {
  const p = place(LP, loadExample(LP), GOOD);
  LP.engine.evaluate(p);
  const before = M.satByRef(p, 'C1').placed;
  M.partByRef(p, 'U1').placed = { x: 22, y: 17.5, rot: 90, side: 'top' };
  M.partByRef(p, 'U4').placed = { x: 29, y: 10.5, rot: 0, side: 'top' };
  const ev = LP.engine.evaluate(p);
  const after = M.satByRef(p, 'C1').placed;
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) > 0.5, 'C1 位置随主控改变');
  for (const s of p.satellites.filter((x) => x.parent[0] === 'U1' && x.kind === 'decoupling')) assert.ok(ev.satResults[s.ref].ok, `${s.ref} 仍在 2 mm 内`);
  assertClean(p);
});

test('射频匹配沿"射频引脚 → 天线馈点"排成一串', () => {
  const p = place(LP, loadExample(LP), GOOD);
  LP.engine.evaluate(p);
  const P = M.pinWorld(M.partByRef(p, 'U1'), 'RF'), A = M.pinWorld(M.partByRef(p, 'ANT1'), 'FEED');
  const chain = ['C10', 'L2', 'C11'].map((r) => M.satByRef(p, r));
  for (const s of chain) assert.ok(G.pointSegDist(s.placed, P, A) <= 1.0, `${s.ref} 偏离馈线 ${G.pointSegDist(s.placed, P, A).toFixed(2)} mm`);
  // 靠天线一端：数据顺序中最后一个离天线最近
  const dA = chain.map((s) => G.dist(s.placed, A));
  assert.ok(dA[2] < dA[1] && dA[1] < dA[0], `顺序 ${dA.map((d) => d.toFixed(2))}`);
});

test('空间不足时报出放不下，并指明挡路的器件', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'layout-project-example.json'), 'utf8'));
  raw.board.two_sided = false;
  raw.parts.push({ ref: 'L10', role: 'inductor', label: '功率电感', w: 4, h: 12, pins: [{ id: 'A', side: 'E', pos: 0.5 }] });
  const p = M.normalize(raw);
  place(LP, p, { ...GOOD, BT1: null, U2: [8, 12, 180], L10: [17.85, 20, 0] });
  const ev = LP.engine.evaluate(p);
  const r = ev.satResults.C1;
  assert.equal(r.ok, false, `C1 应超限：dist=${r.dist}`);
  assert.equal(r.blocker, 'L10');
  assert.match(r.msg, /C1 距 U1 的 VDD 引脚 [\d.]+ mm，超过 2 mm；U1 左侧被 L10 占用/);
  assert.match(r.fix, /把 L10 移开约 [\d.]+ mm/);
  assert.ok(ev.issues.some((i) => i.rule === 'satellite_distance' && i.refs.includes('L10') && i.severity === 'P1' && i.check === 'PI-04'));
});

test('手动固定的卫星不再被移动，恢复自动后重新贴放', () => {
  const p = place(LP, loadExample(LP), GOOD);
  LP.engine.evaluate(p);
  const c2 = M.satByRef(p, 'C2');
  c2.pinned = true; c2.placed = { x: 12, y: 8, rot: 0, side: 'top' };
  let ev = LP.engine.evaluate(p);
  assert.deepEqual([c2.placed.x, c2.placed.y], [12, 8]);
  assert.equal(ev.satResults.C2.ok, false, '离引脚太远');
  c2.pinned = false;
  ev = LP.engine.evaluate(p);
  assert.ok(ev.satResults.C2.ok && Math.hypot(c2.placed.x - 12, c2.placed.y - 8) > 3);
});

test('外晕覆盖主器件及其卫星', () => {
  const p = place(LP, loadExample(LP), GOOD);
  const ev = LP.engine.evaluate(p);
  const halo = ev.halos.find((x) => x.ref === 'U1').rect;
  for (const s of p.satellites.filter((x) => x.parent[0] === 'U1')) assert.ok(G.containsRect(halo, M.satFootprint(s)), `${s.ref} 在外晕内`);
});
