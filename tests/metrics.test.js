// M5：复杂度反馈。三组"好 / 差"对照布局，指标排序应与人工判断一致。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadLP, loadExample, place } = require('./load.js');
const { GOOD } = require('./layouts.js');

const LP = loadLP();
const M = LP.model;
const rank = { good: 0, warn: 1, bad: 2 };
const evalOf = (map) => { const p = place(LP, loadExample(LP), map); return { p, ev: LP.engine.evaluate(p, { boardConfirmed: true }) }; };

test('对照 A：IMU 远离主控 → 线长更长', () => {
  const good = evalOf(GOOD).ev.metrics, bad = evalOf({ ...GOOD, U2: [6, 10, 180] }).ev.metrics;
  assert.ok(bad.length.value > good.length.value + 10, `${good.length.value.toFixed(1)} → ${bad.length.value.toFixed(1)}`);
  assert.ok(rank[bad.length.status] >= rank[good.length.status]);
});

test('对照 B：IMU 转错方向 → 交叉增加，并给出朝向建议', () => {
  const g = evalOf(GOOD), b = evalOf({ ...GOOD, U2: [15, 20, 0] });
  assert.ok(b.ev.metrics.crossings.value >= g.ev.metrics.crossings.value + 2, `${g.ev.metrics.crossings.value} → ${b.ev.metrics.crossings.value}`);
  const s = LP.metrics.orientationSuggestion(b.p, 'U2', (part, pl) => LP.rules.quickLegal(b.p, part, pl).ok);
  assert.ok(s && s.rot === 180 && s.dCross <= -2, JSON.stringify(s));
  assert.equal(LP.metrics.orientationSuggestion(g.p, 'U2', (part, pl) => LP.rules.quickLegal(g.p, part, pl).ok), null, '好朝向不打扰');
});

test('对照 C：Flash 紧贴主控右下角 → 拥挤和出线压力上升', () => {
  const good = evalOf(GOOD).ev.metrics, bad = evalOf({ ...GOOD, U4: [27.5, 16, 0] }).ev.metrics;
  assert.ok(bad.congestion.peak > good.congestion.peak + 0.2, `拥挤 ${good.congestion.peak.toFixed(2)} → ${bad.congestion.peak.toFixed(2)}`);
  assert.ok(rank[bad.congestion.status] > rank[good.congestion.status], `${good.congestion.status} → ${bad.congestion.status}`);
  assert.ok(bad.exit.max >= good.exit.max, `出线 ${good.exit.max.toFixed(2)} → ${bad.exit.max.toFixed(2)}`);
  assert.equal(good.congestion.status, 'good');
});

test('移动差值说明原因，并点名网络', () => {
  const g = evalOf(GOOD);
  const before = g.ev.metrics;
  M.partByRef(g.p, 'U2').placed.rot = 0;
  const after = LP.engine.evaluate(g.p).metrics;
  const d = LP.metrics.diff(before, after, g.p);
  const cross = d.lines.find((l) => l.kind === 'crossings');
  assert.ok(cross && !cross.good, JSON.stringify(d.lines));
  assert.match(cross.text, /^交叉 \+\d+：\S+ 与 \S+ 互相穿过。$/);
  const len = d.lines.find((l) => l.kind === 'length');
  if (len) assert.match(len.text, /^线长 [+−][\d.]+ mm：\S+ (变长|变短)/);
});

test('关键网络：射频馈线超长、卫星超距都计入', () => {
  const { ev } = evalOf({ ...GOOD, ANT1: [33.2, 6, 0] });
  const m = ev.metrics.critical;
  assert.ok(m.items.some((x) => x.name === 'RF_FEED' && !x.ok));
  assert.notEqual(m.status, 'good');
});

test('层数建议：有射频网络建议 4 层；没有时说明 2 层的前提', () => {
  assert.equal(evalOf(GOOD).ev.metrics.layers.layers, 4);
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'layout-project-example.json'), 'utf8'));
  raw.nets = raw.nets.filter((n) => n.class !== 'rf');
  raw.satellites = raw.satellites.filter((s) => s.kind !== 'rf_match');
  raw.board.layers = 2;
  const p = place(LP, M.normalize(raw), GOOD);
  const L = LP.engine.evaluate(p).metrics.layers;
  assert.equal(L.layers, 2, L.reasons.join('；'));
  assert.ok(L.reasons.some((r) => r.includes('铺地')));
});

test('完整评估在 50 ms 内', () => {
  const p = place(LP, loadExample(LP), GOOD);
  for (let i = 0; i < 3; i++) LP.engine.evaluate(p);
  const t = performance.now();
  for (let i = 0; i < 5; i++) LP.engine.evaluate(p);
  const ms = (performance.now() - t) / 5;
  assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
});

test('拥挤度峰值会随移开拥挤器件而回落，且不落在器件本体下方', () => {
  const good = evalOf(GOOD).ev.metrics.congestion.peak;
  const jam = evalOf({ ...GOOD, U4: [27.5, 16, 0] }).ev.metrics.congestion.peak;
  const back = evalOf({ ...GOOD, U4: [29, 14.5, 0] }).ev.metrics.congestion.peak;
  assert.ok(jam > good + 0.2 && Math.abs(back - good) < 1e-6, `${good.toFixed(2)} → ${jam.toFixed(2)} → ${back.toFixed(2)}`);
  const far = evalOf({ ...GOOD, U2: [8, 12, 180] });
  const pt = far.ev.metrics.congestion.peakPoint;
  for (const x of far.p.parts) if (x.placed && x.placed.side === 'top') {
    const r = LP.model.footprint(x);
    assert.ok(!(pt.x > r.x0 && pt.x < r.x1 && pt.y > r.y0 && pt.y < r.y1), `峰值落在 ${x.ref} 本体下 (${pt.x}, ${pt.y})`);
  }
  assert.ok(far.ev.metrics.congestion.peak <= good + 0.15, `IMU 移远不应虚高：${far.ev.metrics.congestion.peak.toFixed(2)}`);
});

test('规划合格的卫星不计入拥挤度，超距的才计入', () => {
  const { p, ev } = evalOf(GOOD);
  const okAll = LP.metrics.congestionMetric(p, ev.metrics.edges, ev.zones, ev.satResults).peak;
  const badAll = Object.fromEntries(Object.entries(ev.satResults).map(([k, r]) => [k, { ...r, ok: false }]));
  const counted = LP.metrics.congestionMetric(p, ev.metrics.edges, ev.zones, badAll).peak;
  assert.ok(counted > okAll, `${okAll.toFixed(2)} vs ${counted.toFixed(2)}`);
});

test('关键网络按 45° 走线估计，斜向摆放不误判超限', () => {
  const base = { BT1: [13, 13, 0, 'bottom'], J1: [27, 5, 0], SW1: [33.5, 8, 0], D1: [33, 11.5, 0], U3: [10, 25.5, 180], U4: [14, 23, 0] };
  const { p, ev } = evalOf({ ...base, ANT1: [3.3, 9, 180], U2: [9.5, 4, 0], U1: [15, 13, 90] });
  const rf = ev.metrics.critical.items.find((x) => x.name === 'RF_FEED');
  const P = LP.model.pinWorld(LP.model.partByRef(p, 'U1'), 'RF'), A = LP.model.pinWorld(LP.model.partByRef(p, 'ANT1'), 'FEED');
  assert.ok(LP.geometry.manhattan(P, A) > 10 && rf.ok, `曼哈顿 ${LP.geometry.manhattan(P, A).toFixed(1)}，45° 估计 ${rf.value.toFixed(1)}`);
});
