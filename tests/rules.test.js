// M3：规则与引导
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadLP, loadExample, place } = require('./load.js');
const { GOOD, BAD } = require('./layouts.js');

const LP = loadLP();
const M = LP.model;

function badProject() {
  const p = place(LP, loadExample(LP), BAD);
  const L1 = M.satByRef(p, 'L1');
  L1.pinned = true; L1.placed = { x: 18, y: 19.5, rot: 0, side: 'top' }; // 手动把 DCDC 电感放到天线旁
  return p;
}
const has = (issues, sev, check, refPart) => issues.some((i) => i.severity === sev && i.check === check && (!refPart || i.refs.includes(refPart)));

test('好布局没有 P0–P2 问题', () => {
  const ev = LP.engine.evaluate(place(LP, loadExample(LP), GOOD), { boardConfirmed: true });
  const serious = ev.issues.filter((i) => i.severity !== 'P3');
  assert.equal(serious.length, 0, serious.map((i) => i.msg).join('\n'));
  assert.ok(ev.steps.filter((s) => s.state !== 'skip').every((s) => s.state === 'done'), '所有步骤完成');
});

test('故意摆错的布局逐条报出，级别和编号正确', () => {
  const ev = LP.engine.evaluate(badProject(), { boardConfirmed: true });
  const I = ev.issues;
  assert.ok(has(I, 'P1', 'RF-01', 'ANT1') && I.some((i) => i.rule === 'antenna_edge'), '天线不在板边 → P1 RF-01');
  assert.ok(I.some((i) => i.rule === 'antenna_keepout' && i.refs.includes('BT1') && i.severity === 'P1' && i.check === 'RF-01'), '电池压进天线净空区 → P1 RF-01');
  assert.ok(has(I, 'P1', 'RF-03', 'BT1'), '电池离天线太近 → P1 RF-03');
  assert.ok(has(I, 'P2', 'SEN-01', 'U2'), 'IMU 贴边 → P2 SEN-01');
  assert.ok(I.some((i) => i.rule === 'inductor_antenna' && i.refs.includes('L1') && i.severity === 'P1' && i.check === 'PI-03'), '电感靠近天线 → P1 PI-03');
  assert.ok(has(I, 'P2', 'RF-04'), '射频馈线过长 → P2 RF-04');
  for (const i of I) { assert.ok(i.msg && i.fix, `问题需要说明和改法：${i.id}`); assert.match(i.msg + i.fix, /\d/, `文案含具体数值或位号：${i.msg}`); }
  // 按级别排序
  const order = I.map((i) => i.severity);
  assert.equal(order.join(), [...order].sort().join());
  // 改正后问题消失
  const p = badProject();
  M.satByRef(p, 'L1').pinned = false;
  place(LP, p, GOOD);
  const ev2 = LP.engine.evaluate(p, { boardConfirmed: true });
  assert.equal(ev2.issues.filter((i) => i.severity !== 'P3').length, 0, ev2.issues.map((i) => i.msg).join('\n'));
});

test('项目可以覆盖或关闭默认规则', () => {
  const p = badProject();
  p.rules = [{ id: 'imu_edge', min: 1 }, { id: 'antenna_keepout', disabled: true }];
  const I = LP.engine.evaluate(p).issues;
  assert.ok(!I.some((i) => i.rule === 'imu_edge'), 'IMU 距边 1.1 mm 不小于覆盖后的 1 mm');
  assert.ok(!I.some((i) => i.rule === 'antenna_keepout'), '净空区规则已关闭');
  p.rules = [{ type: 'min_distance', id: 'my_rule', a: { roles: ['imu'] }, b: { roles: ['flash'] }, min: 50, severity: 'P3', check: 'SEN-01' }];
  assert.ok(LP.engine.evaluate(p).issues.some((i) => i.rule === 'my_rule'), '新增规则生效');
});

test('连接器开口必须朝外', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'layout-project-example.json'), 'utf8'));
  raw.parts.push({ ref: 'J2', role: 'connector', label: 'USB-C', w: 9, h: 7.5, shape: 'usb_c', edge_face: 'S', pins: [{ id: 'VBUS', side: 'N', pos: 0.5 }] });
  const p = place(LP, M.normalize(raw), { ...GOOD, J2: [18, 3.95, 0] });
  let I = LP.engine.evaluate(p).issues;
  assert.ok(!I.some((i) => i.rule === 'connector_edge'), '开口朝下且贴下边：通过');
  M.partByRef(p, 'J2').placed.rot = 180;
  I = LP.engine.evaluate(p).issues;
  assert.ok(I.some((i) => i.rule === 'connector_edge' && i.severity === 'P0' && i.check === 'ASM-02'), '开口转向板内：P0 ASM-02');
});

test('拖动反馈：重叠为 bad，挤占卫星位置为 warn', () => {
  const p = place(LP, loadExample(LP), GOOD);
  LP.engine.evaluate(p);
  const u3 = M.partByRef(p, 'U3');
  assert.equal(LP.rules.dragStatus(p, u3, { x: 23, y: 20, rot: 0, side: 'top' }).level, 'bad');
  const c1 = M.satByRef(p, 'C1');
  const st = LP.rules.dragStatus(p, u3, { x: c1.placed.x - 0.6, y: c1.placed.y, rot: 0, side: 'top' });
  assert.ok(st.level === 'warn' && st.reason === 'halo' && st.with === 'U1', JSON.stringify(st));
});

test('规则引用的核对清单编号都存在于 references/checklists.md', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'references', 'checklists.md'), 'utf8');
  const ids = new Set([...md.matchAll(/- \[ \] ([A-Z]+-\d+)/g)].map((m) => m[1]));
  const used = new Set([...LP.rules.DEFAULT_RULES.map((r) => r.check), ...Object.values(M.SAT_KINDS).map((k) => k.check), 'SI-01'].filter(Boolean));
  for (const id of used) assert.ok(ids.has(id), `清单中缺少 ${id}`);
});

test('天线馈点朝向板外时提示旋转', () => {
  const p = place(LP, loadExample(LP), { ...GOOD, ANT1: [33.2, 20, 180] });
  const ev = LP.engine.evaluate(p);
  assert.ok(ev.issues.some((i) => i.rule === 'antenna_feed' && i.severity === 'P2' && i.check === 'RF-05' && /转 180°/.test(i.fix)));
  assert.ok(!LP.engine.evaluate(place(LP, loadExample(LP), GOOD)).issues.some((i) => i.rule === 'antenna_feed'));
});

test('改板框形状后固定孔压到板边时报出', () => {
  const p = loadExample(LP);
  const old = { ...p.board.outline };
  p.board.outline = M.outlineFromShape('chamfer', { w: 36, h: 28, c: 6 });
  M.remapBoardFeatures(p.board, old, p.board.outline);
  const I = LP.engine.evaluate(p).issues;
  assert.ok(I.some((i) => i.refs.includes('孔1') && i.severity === 'P1' && /固定孔 1/.test(i.msg)), I.map((i) => i.msg).join('\n'));
  assert.ok(!LP.engine.evaluate(loadExample(LP)).issues.some((i) => /固定孔/.test(i.msg)), '原始板框不报');
});

test('板框形状：各形状生成有效的项目数据，L 形缺口处不在板内', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'layout-project-example.json'), 'utf8'));
  for (const s of ['rect', 'stadium', 'chamfer', 'lshape', 'circle']) {
    raw.board.outline = M.outlineFromShape(s, { w: 40, h: 30, r: 2, c: 4, d: 32 });
    assert.equal(M.validate(raw).length, 0, s);
    assert.equal(M.shapeOf(raw.board.outline), s);
  }
  const L = M.outlineFromShape('lshape', { w: 40, h: 30, nw: 16, nh: 12 });
  assert.equal(LP.geometry.pointInBoard(L, { x: 35, y: 25 }), false);
  assert.equal(LP.geometry.pointInBoard(L, { x: 10, y: 25 }), true);
  const dxf = M.exportDXF({ board: { outline: L, holes: [{ x: 3, y: 3, d: 2 }] } });
  assert.equal((dxf.match(/\r\nLINE\r\n/g) || []).length, 6);
  assert.equal((dxf.match(/\r\nCIRCLE\r\n/g) || []).length, 1);
});
