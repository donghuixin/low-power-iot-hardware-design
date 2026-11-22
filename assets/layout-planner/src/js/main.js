/*
 * main.js — 启动：读取注入的项目数据（没有则使用内置示例），创建 2D 绘制层，连接交互与界面。
 */
(function (LP) {
  'use strict';

  async function readJSONScript(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const text = el.textContent.trim();
    if (text) return JSON.parse(text);
    // 开发模式：直接打开 src/index.html 时通过 HTTP 读取
    const src = el.getAttribute('data-src');
    if (src) {
      try { const r = await fetch(src); if (r.ok) return await r.json(); } catch (e) { /* file:// 下无法读取 */ }
    }
    return null;
  }

  async function boot() {
    const App = LP.App;
    LP.ui.init(App);
    let raw = null;
    try { raw = await readJSONScript('project-data'); } catch (e) { LP.ui.toast(LP.t('ui.import_parse_error'), 'bad'); }
    if (!raw) raw = await readJSONScript('example-data');
    if (!raw) { document.body.insertAdjacentHTML('beforeend', '<p style="position:fixed;top:50%;width:100%;text-align:center">没有找到项目数据。</p>'); return; }

    const r2 = new LP.Renderer2D(App, document.getElementById('c2d'), document.getElementById('overlay'));
    LP.ui.r2 = r2;
    App.renderer = r2;
    LP.interactionApi = LP.interaction.init(App, document.getElementById('stage'));

    const res = App.load(raw);
    if (!res.ok) {
      LP.ui.showErrors(res.errors);
      return;
    }
    r2.resize();
    r2.fit(false);
    LP.ui.maybeIntro();
    window.__LP_READY = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(globalThis.LP = globalThis.LP || {});
