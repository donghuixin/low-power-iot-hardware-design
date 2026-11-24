// 加载验证器的计算模块（复用规划器的 geometry/model），返回 LP 命名空间。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PSRC = path.join(__dirname, '..', 'assets', 'layout-planner', 'src', 'js');
const VSRC = path.join(__dirname, '..', 'assets', 'layout-verifier', 'src', 'js');
const PLANNER = ['geometry.js', 'model.js'];
const VERIFIER = ['constants.js', 'solver.js', 'vmodel.js', 'routes.js', 'vrules.js', 'current.js', 'thermal.js', 'emi.js', 'copper.js', 'analysis.js'];
function loadV() {
  const ctx = vm.createContext({ console });
  for (const f of PLANNER) vm.runInContext(fs.readFileSync(path.join(PSRC, f), 'utf8'), ctx, { filename: f });
  for (const f of VERIFIER) { const p = path.join(VSRC, f); if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f }); }
  return ctx.LP;
}
function readJSON(rel) { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')); }
module.exports = { loadV, readJSON, PSRC, VSRC, PLANNER, VERIFIER };
