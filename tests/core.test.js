// M1：数据与计算内核
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { loadLP, loadExample, place } = require('./load.js');
const { GOOD } = require('./layouts.js');

const LP = loadLP();
const G = LP.geometry, M = LP.model;
const ROOT = path.join(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'assets', 'layout-project-example.json');

test('几何：重叠、距离、线段相交', () => {
  const a = G.rect(0, 0, 2, 2), b = G.rect(2, 0, 4, 2), c = G.rect(1, 1, 3, 3);
  assert.equal(G.overlaps(a, b), false, '共边不算重叠');
  assert.equal(G.overlaps(a, c), true);
  assert.equal(G.overlaps(a, b, 0.1), true, '要求间距时共边算冲突');
  assert.equal(G.rectDist(a, G.rect(5, 0, 6, 2)), 3);
  assert.equal(G.segIntersect({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 }), true);
  assert.equal(G.segIntersect({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 0 }), false, '端点接触不算交叉');
});

test('几何：圆角板框与贴边判断', () => {
  const o = { type: 'rect', w: 20, h: 10, corner_r: 3 };
  assert.equal(G.rectInBoard(o, G.rect(0.1, 0.1, 1, 1)), false, '圆角处越界');
  assert.equal(G.rectInBoard(o, G.rect(5, 0.1, 6, 1)), true);
  assert.ok(Math.abs(G.rectEdgeDistance(o, G.rect(5, 0.3, 6, 1)) - 0.3) < 1e-6);
  assert.equal(G.faceOutside(o, G.rect(5, 0.2, 7, 1), 'S', 0.8), true);
  assert.equal(G.faceOutside(o, G.rect(5, 0.2, 7, 1), 'N', 0.8), false);
  const circ = { type: 'circle', d: 20 };
  assert.equal(G.rectInBoard(circ, G.rect(9, 9, 11, 11)), true);
  assert.equal(G.rectInBoard(circ, G.rect(0, 0, 2, 2)), false);
});

test('校验：示例项目通过', () => {
  const raw = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  assert.equal(JSON.stringify(M.validate(raw)), '[]');
});

test('校验：写错的字段报出具体路径', () => {
  const raw = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  raw.parts[1].ref = 'U1';
  raw.parts[2].role = 'gyro';
  raw.nets[1].pins[1] = ['U2', 'NOPE'];
  raw.satellites[0].parent = ['U9', 'VDD'];
  raw.satellites[5].near = 'X99';
  raw.board.outline.w = -3;
  const errs = M.validate(raw).map((e) => e.path);
  for (const pth of ['parts[1].ref', 'parts[2].role', 'nets[1].pins[1]', 'satellites[0].parent', 'satellites[5].near', 'board.outline.w']) {
    assert.ok(errs.includes(pth), `应报出 ${pth}，实际：${errs.join(', ')}`);
  }
});

test('坐标：引脚组随旋转和换面变换', () => {
  const p = loadExample(LP);
  const u2 = M.partByRef(p, 'U2'); // 3.0 × 2.5，SPI 在 W 边
  const at = (pl) => M.pinWorld(u2, 'SPI', pl);
  let w = at({ x: 10, y: 10, rot: 0, side: 'top' });
  assert.equal(w.nx, -1); assert.ok(Math.abs(w.x - 8.5) < 1e-9);
  w = at({ x: 10, y: 10, rot: 180, side: 'top' });
  assert.equal(w.nx, 1, '转 180° 后朝东');
  w = at({ x: 10, y: 10, rot: 90, side: 'top' });
  assert.equal(w.ny, -1, '逆时针转 90° 后 W 边朝南');
  w = at({ x: 10, y: 10, rot: 0, side: 'bottom' });
  assert.equal(w.nx, 1, '背面从正面看是镜像');
  assert.equal(JSON.stringify(M.dims(3, 2.5, 90)), '[2.5,3]');
});

test('快照：撤销恢复与项目指纹', () => {
  const p = loadExample(LP);
  const h0 = M.definitionHash(p);
  const s0 = M.snapshot(p);
  place(LP, p, GOOD);
  assert.equal(M.definitionHash(p), h0, '摆放不改变项目指纹');
  const s1 = M.snapshot(p);
  M.restore(p, s0);
  assert.equal(M.partByRef(p, 'U1').placed, null);
  M.restore(p, s1);
  assert.equal(M.partByRef(p, 'U1').placed.x, GOOD.U1[0]);
});

test('指标：生成树、线长、交叉', () => {
  const nodes = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 1 }];
  const e = LP.metrics.mst(nodes);
  assert.equal(e.length, 2);
  assert.equal(e.reduce((s, x) => s + x.len, 0), 11);

  const p = place(LP, loadExample(LP), GOOD);
  const good = LP.metrics.quick(p);
  M.partByRef(p, 'U2').placed.rot = 0; // SPI 转到背向主控的一侧
  const bad = LP.metrics.quick(p);
  assert.ok(bad.crossings >= good.crossings + 2, `IMU 转错方向应多出交叉：${good.crossings} → ${bad.crossings}`);
});

test('脚本：make_layout_project.py 校验', () => {
  const ok = spawnSync('python3', [path.join(ROOT, 'scripts', 'make_layout_project.py'), EXAMPLE, '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const raw = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  raw.nets[0].pins[1] = ['ANT9', 'FEED'];
  raw.parts[0].pins[0].pos = 1.5;
  const tmp = path.join(require('node:os').tmpdir(), 'lp-broken.json');
  fs.writeFileSync(tmp, JSON.stringify(raw));
  const bad = spawnSync('python3', [path.join(ROOT, 'scripts', 'make_layout_project.py'), tmp, '--check'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /nets\[0\]\.pins\[1\]: 位号 ANT9 不存在/);
  assert.match(bad.stderr, /parts\[0\]\.pins\[0\]\.pos/);
});

test('改板框尺寸时固定孔跟着最近的板角移动', () => {
  const p = loadExample(LP);
  const b = p.board;
  const old = { ...b.outline };
  b.outline = { type: 'rect', w: 30, h: 20, corner_r: 2 };
  M.remapBoardFeatures(b, old, b.outline);
  assert.equal(JSON.stringify(b.holes.map((h) => [h.x, h.y])), JSON.stringify([[3.5, 17], [26.5, 3.5]]));
  for (const h of b.holes) assert.ok(G.rectInBoard(b.outline, G.rectFromCenter(h.x, h.y, h.d, h.d)));
});

test('固定孔：四角生成、建议空位、冲突判断', () => {
  const p = loadExample(LP);
  const hs = LP.model.cornerHoles(p.board.outline, 2.2);
  assert.equal(hs.length, 4);
  for (const h of hs) assert.ok(LP.geometry.rectInBoard(p.board.outline, LP.geometry.expand(LP.geometry.rectFromCenter(h.x, h.y, h.d, h.d), 1.5)));
  // 圆形板也能放四个
  assert.equal(LP.model.cornerHoles({ type: 'circle', d: 32 }, 2.2).length, 4);
  p.board.holes = hs.slice(0, 3);
  const q = LP.model.suggestHole(p, 2.2);
  assert.ok(q, '应找到第四个孔位');
  assert.ok(LP.model.holeFits(p, q.x, q.y, 2.2));
  assert.ok(!LP.model.holeFits(p, hs[0].x, hs[0].y, 2.2), '与已有孔重合时不合适');
  assert.ok(LP.model.holeFits(p, hs[0].x, hs[0].y, 2.2, 0), '跳过自身时合适');
  assert.ok(!LP.model.holeFits(p, 0.5, 0.5, 2.2), '贴板边不合适');
  // 孔位不影响自动保存的项目指纹
  const h1 = LP.model.definitionHash(p); p.board.holes = []; assert.equal(LP.model.definitionHash(p), h1);
});

test('自动保存指纹不受评估时写入的运行时字段影响', () => {
  const p = loadExample(LP);
  const h0 = LP.model.definitionHash(p);
  LP.engine.evaluate(p, { boardConfirmed: true });
  assert.equal(LP.model.definitionHash(p), h0);
});
