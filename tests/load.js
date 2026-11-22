// 在独立的 vm 上下文中按顺序加载计算模块（与构建脚本内联到页面中的顺序一致），返回 LP 命名空间。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'assets', 'layout-planner', 'src', 'js');
const CORE = ['strings.js', 'geometry.js', 'model.js', 'rules.js', 'satellites.js', 'metrics.js', 'engine.js'];

function loadLP() {
  const ctx = vm.createContext({ console });
  for (const f of CORE) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  return ctx.LP;
}
function loadExample(LP) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'layout-project-example.json'), 'utf8'));
  return LP.model.normalize(raw);
}
function loadFixture(LP, name) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
  return LP.model.normalize(raw);
}
/** 在示例项目上应用一组摆放：{ref: [x, y, rot, side]}。 */
function place(LP, p, map) {
  for (const [ref, v] of Object.entries(map)) {
    const it = LP.model.itemByRef(p, ref);
    if (!it) throw new Error('unknown ref ' + ref);
    it.placed = v ? { x: v[0], y: v[1], rot: v[2] || 0, side: v[3] || (it.sides ? it.sides[0] : 'top') } : null;
  }
  return p;
}
module.exports = { loadLP, loadExample, loadFixture, place, SRC, CORE };
