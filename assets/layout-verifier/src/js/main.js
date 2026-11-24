// 启动：读页面里嵌入的项目（make_layout_project.py --verifier 注入），没有就用示例；可选的铜皮数据包。
(function (LP) {
  'use strict';
  function readJSON(id) {
    const el = document.getElementById(id);
    const t = el && el.textContent.trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }
  window.addEventListener('DOMContentLoaded', async () => {
    const project = readJSON('project-data') || readJSON('example-data');
    const copper = readJSON('copper-data');
    if (!project) { document.getElementById('right').textContent = '页面里没有项目数据。用"打开"选择布局规划器导出的布局 JSON。'; return; }
    await LP.App.boot(project, copper);
    window.__LV_READY = true;
  });
})(globalThis.LP = globalThis.LP || {});
