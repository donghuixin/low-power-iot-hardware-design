/*
 * ui.js — 浮层面板与界面：工具条、步骤引导、评估面板、托盘、选中器件的操作按钮、朝向建议、移动差值卡片、提示与菜单。
 */
(function (LP) {
  'use strict';
  const M = LP.model, G = LP.geometry;
  const t = (k, p) => LP.t(`ui.${k}`, p);
  const $ = (sel, root) => (root || document).querySelector(sel);
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const pct = (v) => `${Math.round(v * 100)}%`;
  const SEV_ORDER = ['P0', 'P1', 'P2', 'P3'];
  const STATUS_ICON = { good: '✓', warn: '!', bad: '✕' };

  const ICONS = {
    rotate: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
    flip: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14l-5-5 5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
    undo: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    redo: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
    flipboard: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M12 3v4M12 17v4M9 5l3-2 3 2M9 19l3 2 3-2"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>',
  };

  const ui = {
    App: null,
    openStep: null,
    trayDragRef: null,

    init(App) {
      this.App = App;
      this.root = $('#app');
      this.stage = $('#stage');
      this.overlay = $('#overlay');
      this.buildToolbar();
      this.buildFloat();
      this.bindSearch();
      LP.motion.init(App, $('#motion-layer'));
      App.on('load', () => { this.renderAll(true); const d = $('#board-setup'); if (d && d.open && App.boardConfirmed) d.close(); });
      App.on('change', (d) => { this.renderAll(); this.showDeltaCard(d); });
      App.on('select', () => { this.renderSelection(); this.renderSteps(); });
      App.on('drawn', () => this.positionOverlays());
      App.on('toast', (d) => this.toast(d.msg, d.level));
      App.on('hover', (d) => this.showTip(d));
      App.on('dragmove', () => this.positionDragChip());
      App.on('dragend', () => { this.dragChip.hidden = true; });
      App.on('storage', () => this.renderToolbar());
      App.on('boardlive', () => this.renderBoardForm(true));
      App.on('shake', () => {});
      window.addEventListener('resize', () => this.onResize());
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      App.systemReduced = mq.matches;
      mq.addEventListener && mq.addEventListener('change', (e) => { App.systemReduced = e.matches; this.renderToolbar(); });
      try { App.animOn = localStorage.getItem('lp:anim') === '1'; } catch (e) { App.animOn = false; }
      App.on('anim', () => this.renderToolbar());
      this.onResize(true);
    },

    bindSearch() {
      const app = this.App, input = $('#find-item'), options = $('#item-options');
      app.on('load', () => {
        input.value = '';
        options.replaceChildren(...[...app.p.parts, ...app.p.satellites].map(item =>
          h('option', { value: item.ref, label: M.faceName(item) })));
      });
      $('#item-search').addEventListener('submit', event => {
        event.preventDefault();
        const query = input.value.trim().toLowerCase();
        if (!query) return;
        const items = [...app.p.parts, ...app.p.satellites];
        const exact = items.find(item => item.ref.toLowerCase() === query);
        const matches = exact ? [exact] : items.filter(item => M.faceName(item).toLowerCase().includes(query));
        if (matches.length !== 1) {
          app.toast(matches.length ? '有多个匹配器件，请选择位号。' : '没有找到该器件。', 'info');
          return;
        }
        const item = matches[0];
        app.select({ type: item.kind ? 'sat' : 'part', ref: item.ref });
        if (item.placed) app.focusOn([item.ref]);
        else this.highlightTray(item.kind ? item.parent[0] : item.ref);
      });
    },

    // ---------- 布局 ----------
    onResize(first) {
      const narrow = window.innerWidth < 1000;
      this.root.classList.toggle('narrow', narrow);
      if (!narrow) { this.root.classList.remove('show-left', 'show-right'); }
      if (!this.App.renderer) return;
      this.App.renderer.resize();
      // 窗口尺寸变化后重新适配，避免板子落到面板后面或画面外
      clearTimeout(this._fitT);
      if (first) this.App.renderer.fit(false);
      else this._fitT = setTimeout(() => this.App.renderer && this.App.renderer.fit(true), 120);
    },
    insets() {
      const r = this.stage.getBoundingClientRect();
      const box = (sel) => { const el = $(sel); if (!el || el.offsetParent === null || getComputedStyle(el).visibility === 'hidden') return null; return el.getBoundingClientRect(); };
      const L = box('#left'), Rr = box('#right'), T = box('#toolbar'), B = box('#tray');
      return {
        left: L ? Math.max(0, L.right - r.left) : 0,
        right: Rr ? Math.max(0, r.right - Rr.left) : 0,
        top: T ? Math.max(0, T.bottom - r.top) : 0,
        bottom: B ? Math.max(0, r.bottom - B.top) : 0,
      };
    },
    isOverPanel(x, y) {
      const el = document.elementFromPoint(x, y);
      return !!(el && el.closest('[data-ui]'));
    },

    // ---------- 工具条 ----------
    buildToolbar() {
      const App = this.App;
      $('#proj-name').textContent = '';
      $('#v2d').addEventListener('click', () => this.setView('2d'));
      $('#v3d').addEventListener('click', () => this.setView('3d'));
      $('#btn-flip').insertAdjacentHTML('afterbegin', ICONS.flipboard);
      $('#btn-flip').addEventListener('click', () => this.flipBoard());
      $('#btn-undo').innerHTML = ICONS.undo; $('#btn-redo').innerHTML = ICONS.redo;
      $('#btn-undo').addEventListener('click', () => App.undo());
      $('#btn-redo').addEventListener('click', () => App.redo());
      $('#btn-star').insertAdjacentHTML('afterbegin', ICONS.star);
      $('#btn-help').addEventListener('click', () => this.openHelp());
      $('#btn-anim').insertAdjacentHTML('afterbegin', ICONS.sparkle);
      $('#btn-anim').addEventListener('click', () => App.setAnim(!App.animOn));
      $('#btn-steps').addEventListener('click', () => { this.root.classList.toggle('show-left'); this.root.classList.remove('show-right'); });
      $('#btn-eval').addEventListener('click', () => { this.root.classList.toggle('show-right'); this.root.classList.remove('show-left'); });
      $('#file-input').addEventListener('change', (e) => this.importFile(e.target.files[0]));
      // 菜单
      for (const btn of document.querySelectorAll('[data-menu]')) {
        btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMenu(btn.dataset.menu, btn); });
      }
      document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) this.closeMenus(); });
      // 图层
      const layers = $('#menu-layers');
      for (const k of ['keepout', 'edge', 'heat', 'magnetic', 'congestion', 'sats', 'halo', 'grid']) {
        const id = `layer-${k}`;
        layers.append(h('label', { class: 'menu-item check' },
          h('input', { type: 'checkbox', id, onchange: (e) => { App.layers[k] = e.target.checked; App.redraw(); if (App.renderer && App.renderer.kind === '3d') App.renderer.rebuild(); } }),
          h('span', {}, t(`layer_${k}`))));
      }
      // 导出
      const ex = $('#menu-export');
      ex.append(
        h('button', { class: 'menu-item', onclick: () => { this.closeMenus(); App.exportJSON(); } }, t('export_json')),
        h('button', { class: 'menu-item', onclick: () => { this.closeMenus(); App.exportCSV(); } }, t('export_csv')),
        h('button', { class: 'menu-item', onclick: () => { this.closeMenus(); this.exportPNG(); } }, t('export_png')),
        h('button', { class: 'menu-item', onclick: () => { this.closeMenus(); App.exportDXF(); } }, t('export_dxf')),
        h('div', { class: 'menu-sep' }),
        h('button', { class: 'menu-item', onclick: () => { this.closeMenus(); $('#file-input').click(); } }, t('import')),
      );
      // 更多
      const more = $('#menu-more');
      more.append(
        h('label', { class: 'menu-item check' }, h('input', { type: 'checkbox', id: 'opt-editsats', onchange: (e) => { App.editSats = e.target.checked; this.renderSelection(); } }), h('span', {}, t('edit_sats'))),
        h('button', { class: 'menu-item', onclick: () => { this.closeMenus(); App.unpinAll(); } }, t('unpin_all')),
        h('div', { class: 'menu-sep' }),
        h('div', { class: 'menu-label' }, t('theme')),
        h('div', { class: 'menu-row' },
          h('button', { class: 'chip-btn', 'data-theme-set': 'light', onclick: () => this.setTheme('light') }, t('theme_light')),
          h('button', { class: 'chip-btn', 'data-theme-set': 'dark', onclick: () => this.setTheme('dark') }, t('theme_dark'))),
        h('div', { class: 'menu-label' }, t('board_mask')),
        h('div', { class: 'menu-row' }, ...['green', 'blue', 'black', 'white'].map((m) => h('button', { class: `swatch mask-${m}`, title: t(`mask_${m}`), 'aria-label': t(`mask_${m}`), onclick: () => App.setBoard({ mask: m }) }))),
        h('div', { class: 'menu-sep' }),
        h('button', { class: 'menu-item danger', onclick: () => { this.closeMenus(); if (confirm(t('reset_confirm'))) App.resetLayout(); } }, t('reset')),
      );
      let theme = 'light';
      try { theme = localStorage.getItem('lp:theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch (e) { /* 存储不可用 */ }
      this.setTheme(theme, true);
    },
    toggleMenu(id, btn) {
      const m = $(`#menu-${id}`);
      const open = !m.hidden;
      this.closeMenus();
      if (open) return;
      m.hidden = false;
      const r = btn.getBoundingClientRect();
      m.style.top = `${r.bottom + 6}px`;
      m.style.left = `${Math.min(window.innerWidth - m.offsetWidth - 8, r.left)}px`;
      btn.setAttribute('aria-expanded', 'true');
    },
    closeMenus() {
      for (const m of document.querySelectorAll('.menu')) m.hidden = true;
      for (const b of document.querySelectorAll('[data-menu]')) b.setAttribute('aria-expanded', 'false');
    },
    setTheme(theme, silent) {
      this.App.theme = theme;
      this.root.dataset.theme = theme;
      for (const b of document.querySelectorAll('[data-theme-set]')) b.classList.toggle('on', b.dataset.themeSet === theme);
      try { localStorage.setItem('lp:theme', theme); } catch (e) { /* 存储不可用 */ }
      if (!silent) { this.App.redraw(); if (this.App.renderer && this.App.renderer.kind === '3d') this.App.renderer.rebuild(); }
    },
    renderToolbar() {
      const App = this.App;
      $('#proj-name').textContent = App.p.name;
      $('#btn-undo').disabled = !App.undoStack.length;
      $('#btn-redo').disabled = !App.redoStack.length;
      $('#btn-flip').classList.toggle('on', App.flipped);
      $('#btn-flip').querySelector('span').textContent = App.flipped ? t('flip_on') : t('flip');
      $('#v2d').classList.toggle('active', App.view === '2d'); $('#v2d').setAttribute('aria-selected', String(App.view === '2d'));
      $('#v3d').classList.toggle('active', App.view === '3d'); $('#v3d').setAttribute('aria-selected', String(App.view === '3d'));
      $('#storage-note').hidden = App.storageOk;
      const an = $('#btn-anim');
      an.classList.toggle('on', App.animOn);
      an.setAttribute('aria-pressed', String(App.animOn));
      an.querySelector('span').textContent = App.animOn ? t('anim_on') : t('anim_off');
      an.title = App.animOn ? t('anim_title_on') : t('anim_title_off');
      this.root.classList.toggle('no-anim', App.reducedMotion);
      for (const [k, v] of Object.entries(App.layers)) { const el = $(`#layer-${k}`); if (el) el.checked = v; }
      const es = $('#opt-editsats'); if (es) es.checked = App.editSats;
    },
    async setView(v) {
      const App = this.App;
      if (v === App.view) return;
      if (v === '3d') {
        const btn = $('#v3d');
        if (!LP.three.supported()) { this.toast(t('view3d_nowebgl'), 'warn'); return; }
        btn.classList.add('loading'); btn.textContent = t('view3d_loading');
        try {
          if (!this.r3) this.r3 = await LP.three.create(App, $('#three-host'), this.overlay);
        } catch (err) {
          console.error(err);
          this.toast(t('view3d_failed'), 'bad');
          btn.classList.remove('loading'); btn.textContent = t('view3d');
          return;
        }
        btn.classList.remove('loading'); btn.textContent = t('view3d');
        App.view = '3d';
        this.root.classList.add('is-3d');
        App.renderer = this.r3;
        this.r3.resize(); this.r3.rebuild(); this.r3.fit(false);
      } else {
        App.view = '2d';
        this.root.classList.remove('is-3d');
        App.renderer = this.r2;
        this.r2.resize();
      }
      App.emit('view');
      this.renderToolbar();
      App.redraw();
    },
    flipBoard() {
      const App = this.App;
      App.flipped = !App.flipped;
      if (App.renderer && App.renderer.onFlip) App.renderer.onFlip();
      this.renderToolbar();
      App.redraw();
    },

    // ---------- 渲染全部面板 ----------
    renderAll(first) {
      const App = this.App;
      if (!App.p) return;
      this.renderToolbar();
      this.renderSteps();
      this.renderMetrics();
      this.renderDelta();
      this.renderIssues();
      this.renderTray();
      this.renderSelection();
      if (first) {
        if (App.restored) this.toast(t('restored'), 'info');
        document.title = `${App.p.name} · ${t('title')}`;
      }
    },

    // ---------- 步骤 ----------
    currentStep() {
      const ev = this.App.ev;
      const s = ev.steps.find((x) => x.state === 'todo' || x.state === 'issues');
      return s ? s.id : 8;
    },
    renderSteps() {
      const App = this.App, ev = App.ev;
      const list = $('#steps');
      list.innerHTML = '';
      const cur = this.currentStep();
      const open = this.openStep || cur;
      App.boardEditing = open === 1;
      for (const S of LP.engine.STEPS) {
        const st = ev.steps.find((x) => x.id === S.id);
        const isOpen = S.id === open;
        const mark = st.state === 'done' ? '✓' : st.state === 'skip' ? '–' : st.state === 'issues' ? '!' : String(S.id);
        const li = h('li', { class: `step ${st.state} ${S.id === cur ? 'current' : ''} ${isOpen ? 'open' : ''}` });
        li.append(h('button', { class: 'step-head', 'aria-expanded': String(isOpen), onclick: () => { this.openStep = isOpen ? -1 : S.id; this.renderSteps(); App.redraw(); } },
          h('span', { class: 'step-mark', 'aria-hidden': 'true' }, mark),
          h('span', { class: 'step-title' }, S.title),
          h('span', { class: 'sr-only' }, t(`step_state_${st.state}`))));
        if (isOpen) li.append(this.stepBody(S, st));
        list.append(li);
      }
      $('#steps-hint').textContent = t('step_free_order');
    },
    stepBody(S, st) {
      const App = this.App;
      const body = h('div', { class: 'step-body' }, h('p', { class: 'step-hint' }, S.hint));
      if (S.key === 'board') { body.append(this.boardForm()); return body; }
      if (S.key === 'check') { body.append(this.checkSummary()); return body; }
      if (st.state === 'skip') { body.append(h('p', { class: 'muted' }, t('step_skip'))); return body; }
      body.append(h('div', { class: 'step-sub' }, t('step_parts')));
      const chips = h('div', { class: 'chips' });
      for (const ref of st.parts) {
        const part = M.partByRef(App.p, ref);
        chips.append(h('button', {
          class: `chip ${part.placed ? 'placed' : ''}`,
          onclick: () => { if (part.placed) { App.select({ type: 'part', ref }); App.focusOn([ref]); } else this.highlightTray(ref); },
          }, part.placed ? '✓ ' : '', M.faceName(part)));
      }
      body.append(chips);
      const issues = App.ev.issues.filter((i) => i.refs.some((r) => st.parts.includes(r)) && i.severity !== 'P3');
      const unplaced = st.parts.filter((r) => !M.partByRef(App.p, r).placed);
      if (unplaced.length || issues.length) {
        body.append(h('div', { class: 'step-sub' }, t('step_missing')));
        const ul = h('ul', { class: 'mini-list' });
        if (unplaced.length) ul.append(h('li', {}, t('step_unplaced', { refs: unplaced.join('、') })));
        for (const i of issues.slice(0, 3)) ul.append(h('li', {}, h('button', { class: 'link', onclick: () => this.focusIssue(i) }, h('span', { class: `sev ${i.severity}` }, i.severity), ' ', i.msg)));
        if (issues.length > 3) ul.append(h('li', { class: 'muted' }, t('step_more', { n: issues.length - 3 })));
        body.append(ul);
      } else body.append(h('p', { class: 'ok-line' }, '✓ ', t('step_done')));
      return body;
    },
    boardForm() {
      const App = this.App, b = App.p.board, o = b.outline;
      const num = (label, val, onc, step) => h('label', { class: 'field' }, h('span', {}, label), h('input', { type: 'number', step: step || 0.5, min: 1, value: val, onchange: (e) => { const v = parseFloat(e.target.value); if (v > 0) onc(v); } }));
      const wrap = h('div', { class: 'board-form', id: 'board-form' });
      wrap.append(this.shapeEditor(o, (ol) => App.setBoard({ outline: ol }), { allowCustom: true }).el);
      wrap.append(h('div', { class: 'row2' },
        h('label', { class: 'field' }, h('span', {}, t('board_layers')), h('select', { onchange: (e) => App.setBoard({ layers: parseInt(e.target.value, 10) }) }, ...[2, 4, 6].map((n) => h('option', { value: n, selected: b.layers === n }, n)))),
        num(t('board_thickness'), b.thickness, (v) => App.setBoard({ thickness: v }), 0.1)));
      wrap.append(h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: b.two_sided, onchange: (e) => App.setBoard({ two_sided: e.target.checked }) }), h('span', {}, t('board_two_sided'))));
      wrap.append(this.holesEditor());
      if (b.keepouts.length) wrap.append(h('p', { class: 'muted small' }, t('board_keepouts', { m: b.keepouts.length })));
      if (M.shapeOf(o) !== 'custom') wrap.append(h('p', { class: 'muted small' }, o.type === 'polygon' ? t('board_edit_hint_poly') : t('board_edit_hint')));
      wrap.append(h('p', { class: 'eda-note small' }, t('eda_final_outline')));
      wrap.append(h('button', { class: 'primary', onclick: () => { App.confirmBoard(); this.openStep = null; this.renderSteps(); } }, App.boardConfirmed ? t('board_reconfirm') : t('board_confirm')));
      return wrap;
    },
    /** 固定孔列表：逐个改坐标和孔径、删除，或按常用规格添加。 */
    holesEditor() {
      const App = this.App, holes = App.p.board.holes;
      const box = h('div', { class: 'holes-editor', id: 'holes-editor' });
      box.append(h('div', { class: 'step-sub' }, `${t('holes_title')}（${holes.length}）`, h('span', { class: 'unit' }, ' 单位 mm')));
      if (!holes.length) box.append(h('p', { class: 'muted small' }, t('hole_none')));
      if (holes.length) box.append(h('div', { class: 'hole-row hole-head', 'aria-hidden': 'true' }, h('span'), h('span', {}, 'x'), h('span', {}, 'y'), h('span', {}, '孔径'), h('span')));
      const numIn = (i, k, v, label) => h('label', { class: 'hole-f' }, h('span', { class: 'sr-only' }, `孔${i + 1} ${label}`),
        h('input', { type: 'number', step: k === 'd' ? 0.1 : 0.5, min: k === 'd' ? 0.5 : undefined, value: v, 'data-hole': i, 'data-k': k,
          onchange: (e) => { const x = parseFloat(e.target.value); if (Number.isFinite(x) && (k !== 'd' || x > 0)) App.setHole(i, { [k]: x }); } }));
      holes.forEach((ho, i) => box.append(h('div', { class: 'hole-row' },
        h('span', { class: 'hole-id' }, `孔${i + 1}`),
        numIn(i, 'x', ho.x, 'x'), numIn(i, 'y', ho.y, 'y'), numIn(i, 'd', ho.d, 'Ø'),
        h('button', { class: 'icon-btn hole-del', title: t('hole_del', { i: i + 1 }), 'aria-label': t('hole_del', { i: i + 1 }), onclick: () => App.removeHole(i) }, '×'))));
      const size = h('select', { class: 'hole-size', 'aria-label': t('holes_title') }, ...M.HOLE_SIZES.map((z) => h('option', { value: z.d }, `${z.id}（Ø${z.d}）`)));
      box.append(h('div', { class: 'hole-add' }, size, h('button', { class: 'ghost', id: 'hole-add', onclick: () => App.addHole(parseFloat(size.value)) }, '+ ', t('hole_add'))));
      box.append(h('p', { class: 'muted small' }, t('holes_hint')));
      return box;
    },
    /**
     * 板框形状编辑：圆角矩形、胶囊形、倒角矩形、L 形、圆形，以及可在板上逐点编辑的自定义多边形。
     * onChange(outline) 在输入有效时调用；opts.allowCustom 控制是否提供自定义多边形。
     */
    shapeEditor(o, onChange, opts) {
      const r1 = (v) => Math.round(v * 2) / 2;
      const bb = G.outlineBBox(o);
      const st = {
        shape: M.shapeOf(o),
        w: o.w ?? r1(bb.x1 - bb.x0), h: o.h ?? r1(bb.y1 - bb.y0), r: o.corner_r ?? 2, c: o.c ?? 3,
        d: o.d ?? r1(Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0)),
      };
      st.nw = o.nw ?? r1(st.w * 0.4); st.nh = o.nh ?? r1(st.h * 0.4);
      if (st.shape === 'custom' && !(opts && opts.allowCustom)) st.shape = 'rect';
      const shapes = ['rect', 'stadium', 'chamfer', 'lshape', 'circle'].concat(opts && opts.allowCustom ? ['custom'] : []);
      const wrap = h('div', { class: 'shape-editor' });
      const sel = h('select', { 'aria-label': t('board_shape') }, ...shapes.map((s) => h('option', { value: s, selected: s === st.shape }, t(`shape_${s}`))));
      const fields = h('div', { class: 'shape-fields' });
      const build = () => {
        if (st.shape === 'custom') return o.type === 'polygon' && o.shape === 'custom' ? o : M.toEditablePolygon(o);
        return M.outlineFromShape(st.shape, st);
      };
      const valid = () => {
        const keys = { rect: ['w', 'h'], stadium: ['w', 'h'], chamfer: ['w', 'h'], lshape: ['w', 'h'], circle: ['d'], custom: [] }[st.shape];
        return keys.every((k) => Number.isFinite(st[k]) && st[k] >= 5);
      };
      const num = (k, label, step) => h('label', { class: 'field' }, h('span', {}, label),
        h('input', { type: 'number', step: step || 0.5, min: 0, value: st[k], 'data-k': k, onchange: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v >= 0) { st[k] = v; if (valid()) onChange(build()); } } }));
      const renderFields = () => {
        fields.innerHTML = '';
        const row = (...kids) => h('div', { class: 'row2' }, ...kids);
        if (st.shape === 'circle') fields.append(num('d', t('board_d')));
        else if (st.shape === 'custom') {
          const n = (o.type === 'polygon' && o.shape === 'custom' ? o.points : M.toEditablePolygon(o).points).length;
          fields.append(h('p', { class: 'muted small' }, t('shape_custom_hint', { n })));
        } else {
          fields.append(row(num('w', t('board_w')), num('h', t('board_h'))));
          if (st.shape === 'rect') fields.append(num('r', t('board_r')));
          if (st.shape === 'chamfer') fields.append(num('c', t('board_c')));
          if (st.shape === 'lshape') fields.append(row(num('nw', t('board_nw')), num('nh', t('board_nh'))), h('p', { class: 'muted small' }, t('shape_lshape_hint')));
        }
      };
      sel.addEventListener('change', () => { st.shape = sel.value; renderFields(); if (valid()) onChange(build()); });
      renderFields();
      wrap.append(h('label', { class: 'field' }, h('span', {}, t('board_shape')), sel), fields);
      return { el: wrap, value: () => (valid() ? build() : null), state: st };
    },
    renderBoardForm() {
      const o = this.App.p.board.outline;
      const f = $('#board-form');
      if (!f) return;
      for (const inp of f.querySelectorAll('input[data-k]')) {
        const k = inp.dataset.k;
        if (k === 'w' && o.w !== undefined) inp.value = o.w;
        if (k === 'h' && o.h !== undefined) inp.value = o.h;
        if (k === 'd' && o.d !== undefined) inp.value = o.d;
      }
    },
    checkSummary() {
      const App = this.App, ev = App.ev;
      const n = Object.fromEntries(SEV_ORDER.map((s) => [s, ev.issues.filter((i) => i.severity === s).length]));
      const box = h('div', { class: 'check-box' });
      box.append(h('div', { class: 'sev-row' }, ...SEV_ORDER.map((s) => h('span', { class: `sev ${s}` }, `${s} ${n[s]}`))));
      if (ev.unplacedParts.length) box.append(h('p', {}, t('check_unplaced', { n: ev.unplacedParts.length, refs: ev.unplacedParts.join('、') })));
      else if (!n.P0 && !n.P1) box.append(h('p', { class: 'ok-line' }, '✓ ', t('check_ready')));
      else box.append(h('p', {}, t('check_blocking', { n: n.P0 + n.P1 })));
      const L = ev.metrics.layers;
      box.append(h('p', {}, h('strong', {}, t('check_layers', { n: L.layers })), ...L.reasons.map((r) => h('span', { class: 'muted block small' }, '· ', r))));
      box.append(h('div', { class: 'btn-row' },
        h('button', { class: 'primary', onclick: () => App.exportJSON() }, t('export_json_short')),
        h('button', { onclick: () => App.exportCSV() }, t('export_csv_short')),
        h('button', { onclick: () => this.exportPNG() }, t('export_png_short')),
        h('button', { onclick: () => App.exportDXF() }, t('export_dxf_short'))));
      box.append(h('p', { class: 'muted small' }, t('check_handback')));
      box.append(h('p', { class: 'eda-note small' }, t('eda_next_step')));
      return box;
    },

    // ---------- 评估 ----------
    renderMetrics() {
      const App = this.App, m = App.ev.metrics, C = LP.metrics.CONFIG;
      const rows = [
        { k: 'length', value: `${f1(m.length.value)} mm`, frac: m.length.norm / C.lengthNorm.warn, st: m.length.status, onclick: () => this.focusLongest() },
        { k: 'crossings', value: String(m.crossings.value), frac: m.crossings.density / C.crossDensity.warn, st: m.crossings.status, onclick: () => this.focusCrossings() },
        { k: 'congestion', value: pct(m.congestion.peak), frac: m.congestion.peak / C.congestion.warn, st: m.congestion.status, onclick: () => this.focusCongestion() },
        { k: 'critical', value: m.critical.violations ? t('m_critical_bad', { n: m.critical.violations }) : t('m_critical_ok', { n: m.critical.items.length }), frac: m.critical.violations ? 1.2 : 0.2, st: m.critical.status, onclick: () => this.focusCritical() },
        { k: 'exit', value: m.exit.worst ? `${pct(m.exit.max)}` : '—', frac: m.exit.max / C.exit.warn, st: m.exit.status, onclick: () => m.exit.worst && this.focusRefs([m.exit.worst.ref], 'P2') },
        { k: 'layers', value: t('m_layers_value', { n: m.layers.layers }), frac: m.layers.layers > m.layers.current ? 1.1 : 0.3, st: m.layers.status, onclick: () => { this.layersOpen = !this.layersOpen; this.renderMetrics(); } },
      ];
      const box = $('#metrics');
      box.innerHTML = '';
      for (const r of rows) {
        const badCrit = m.critical.items.filter((x) => !x.ok);
        const critList = () => {
          const fmt = (x) => x.unplaced ? t('m_critical_unplaced', { name: x.name }) : t(x.kind === 'net' ? 'm_critical_net' : 'm_critical_sat', { name: x.name, v: f1(x.value), limit: x.limit });
          return badCrit.slice(0, 2).map(fmt).join('；') + (badCrit.length > 2 ? ' ' + t('m_critical_more', { n: badCrit.length }) : '');
        };
        const sub = r.k === 'critical' && badCrit.length ? critList()
          : r.k === 'exit' && m.exit.worst ? t('m_exit_where', { ref: m.exit.worst.ref, side: LP.S.sideCN[m.exit.worst.side], need: m.exit.worst.need, ch: Math.floor(m.exit.worst.channels) })
          : r.k === 'congestion' ? t('m_congestion_over', { p: pct(m.congestion.overFrac) })
          : t(`m_${r.k}_desc`);
        const row = h('button', { class: `metric ${r.st}`, onclick: r.onclick, 'aria-label': `${t(`m_${r.k}`)} ${r.value} ${t(`status_${r.st}`)}` },
          h('div', { class: 'metric-top' },
            h('span', { class: 'metric-name' }, t(`m_${r.k}`)),
            h('span', { class: 'metric-value' }, r.value),
            h('span', { class: `status ${r.st}` }, h('span', { 'aria-hidden': 'true' }, STATUS_ICON[r.st]), ' ', t(`status_${r.st}`))),
          h('div', { class: 'bar' }, h('span', { class: 'bar-fill', style: `width:${Math.max(4, Math.min(100, r.frac * 75))}%` }), h('i', { class: 'tick t1' }), h('i', { class: 'tick t2' })),
          h('div', { class: 'metric-desc' }, sub));
        box.append(row);
        if (r.k === 'layers' && this.layersOpen) box.append(h('ul', { class: 'mini-list reasons' }, ...m.layers.reasons.map((x) => h('li', {}, x))));
      }
    },
    renderDelta() {
      const d = this.App.delta, box = $('#delta');
      box.innerHTML = '';
      if (!d) { box.append(h('p', { class: 'muted small' }, t('delta_none'))); return; }
      box.append(h('div', { class: 'delta-label muted small' }, d.label + (d.ref ? ` · ${d.ref}` : '')));
      if (!d.lines.length) { box.append(h('p', { class: 'small' }, t('delta_nochange'))); }
      for (const l of d.lines) box.append(h('p', { class: `delta-line ${l.good ? 'good' : 'bad'}` }, h('span', { 'aria-hidden': 'true' }, l.good ? '▼ ' : '▲ '), l.text));
      const s = this.App.suggestion;
      if (s && d.ref === s.ref) box.append(h('p', { class: 'delta-line hint' }, this.suggestText(s), ' ', h('button', { class: 'link', onclick: () => this.App.acceptSuggestion() }, t('suggest_accept'))));
    },
    renderIssues() {
      const App = this.App, list = $('#issues');
      list.innerHTML = '';
      const issues = App.ev.issues;
      $('#issue-count').textContent = issues.length ? String(issues.length) : '';
      if (!issues.length) { list.append(h('li', { class: 'empty' }, '✓ ', t('issues_none'))); return; }
      for (const i of issues) {
        list.append(h('li', {}, h('button', { class: `issue ${App.focusIssue && App.focusIssue.id === i.id ? 'on' : ''}`, onclick: () => this.focusIssue(i) },
          h('div', { class: 'issue-top' }, h('span', { class: `sev ${i.severity}` }, i.severity), h('code', { class: 'check-id' }, i.check || '—')),
          h('div', { class: 'issue-msg' }, i.msg),
          h('div', { class: 'issue-fix' }, i.fix))));
      }
    },
    focusIssue(i) {
      const App = this.App;
      App.focusIssue = i;
      const first = i.refs.find((r) => M.itemByRef(App.p, r));
      if (first) App.select({ type: M.partByRef(App.p, first) ? 'part' : 'sat', ref: first });
      App.focusOn(i.refs);
      this.renderIssues();
      if (this.root.classList.contains('narrow')) this.root.classList.remove('show-right');
    },
    focusRefs(refs, sev) { this.focusIssue({ id: 'm:' + refs.join(','), refs, severity: sev || 'P2', msg: '', fix: '' }); },
    focusLongest() {
      const m = this.App.ev.metrics;
      const top = [...m.length.perNet].sort((a, b) => b.total - a.total)[0];
      if (!top) return;
      const net = this.App.p.nets.find((n) => n.name === top.net);
      this.focusRefs(net.pins.map((q) => q[0]), 'P3');
      this.toast(t('m_length_top', { net: top.net, len: f1(top.len), w: top.width }), 'info');
    },
    focusCrossings() {
      const m = this.App.ev.metrics;
      if (!m.crossings.pairs.length) { this.toast(t('m_crossings_none'), 'info'); return; }
      const refs = [...new Set(m.crossings.pairs.slice(0, 3).flatMap((x) => x.refs))];
      this.focusRefs(refs, 'P2');
      this.toast(m.crossings.pairs.slice(0, 3).map((x) => `${x.a} × ${x.b}（${x.n}）`).join('；'), 'info');
    },
    focusCongestion() {
      const App = this.App;
      App.layers.congestion = true;
      this.renderToolbar();
      const pt = App.ev.metrics.congestion.peakPoint;
      if (pt && App.renderer) App.renderer.focus({ x0: pt.x - 6, y0: pt.y - 6, x1: pt.x + 6, y1: pt.y + 6 });
      if (App.renderer && App.renderer.kind === '3d') App.renderer.rebuild();
      App.redraw();
    },
    focusCritical() {
      const bad = this.App.ev.metrics.critical.items.filter((x) => !x.ok);
      if (!bad.length) { this.toast(t('m_critical_all_ok'), 'info'); return; }
      this.focusRefs([...new Set(bad.flatMap((x) => x.refs))], 'P1');
    },

    // ---------- 托盘 ----------
    renderTray() {
      const App = this.App, list = $('#tray-list');
      list.innerHTML = '';
      const cur = this.currentStep();
      const parts = [...App.p.parts].sort((a, b) => LP.engine.stepOfRole(a.role) - LP.engine.stepOfRole(b.role) || a.ref.localeCompare(b.ref, 'en', { numeric: true }));
      const unplaced = parts.filter((x) => !x.placed).length;
      $('#tray-count').textContent = t('tray_count', { n: unplaced, total: parts.length });
      for (const x of parts) {
        const hot = !x.placed && LP.engine.stepOfRole(x.role) === cur;
        const name = M.faceName(x);
        const card = h('button', { class: `tray-card ${x.placed ? 'placed' : ''} ${hot ? 'hot' : ''}`, 'data-ref': x.ref, title: `${x.ref} · ${name} · ${x.w}×${x.h} mm`, 'aria-label': `${name} ${x.ref}${x.placed ? ' ' + t('tray_placed') : ''}` });
        const cv = h('canvas', { class: 'thumb', width: 64, height: 44, 'aria-hidden': 'true' });
        card.append(cv, h('span', { class: 'tray-ref' }, name));
        if (x.label !== name && x.label !== x.ref) card.append(h('span', { class: 'tray-label' }, x.label));
        if (x.placed) card.append(h('span', { class: 'tray-badge' }, '✓'));
        card.addEventListener('pointerdown', (e) => {
          if (x.placed) return;
          e.preventDefault();
          LP.interactionApi.trayDrag(x.ref, e);
        });
        card.addEventListener('click', () => { if (x.placed) { App.select({ type: 'part', ref: x.ref }); App.focusOn([x.ref]); } });
        card.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !x.placed) { e.preventDefault(); this.placeByKeyboard(x.ref); } });
        list.append(card);
        requestAnimationFrame(() => LP.render2d.drawThumb(cv, x));
      }
      const bad = App.ev.unplacedSats;
      const satBox = $('#tray-sats');
      satBox.innerHTML = '';
      satBox.hidden = !bad.length;
      if (bad.length) satBox.append(h('span', { class: 'sev P1' }, t('tray_unplaced_sats')), ' ', bad.join('、'));
    },
    /** 键盘用户：把器件放到板子中央附近第一个合法位置。 */
    placeByKeyboard(ref) {
      const App = this.App, part = M.partByRef(App.p, ref);
      const bb = G.outlineBBox(App.p.board.outline);
      const c = G.center(bb);
      const side = App.defaultSide(part);
      for (let r = 0; r < Math.max(bb.x1, bb.y1); r += 1) for (let a = 0; a < 16; a++) {
        const pl = { x: Math.round((c.x + r * Math.cos(a * Math.PI / 8)) * 2) / 2, y: Math.round((c.y + r * Math.sin(a * Math.PI / 8)) * 2) / 2, rot: 0, side };
        if (LP.rules.quickLegal(App.p, part, pl).ok) { App.placePart(ref, pl); App.select({ type: 'part', ref }); return; }
      }
      this.toast(t('toast_no_room', { ref }), 'bad');
    },
    highlightTray(ref) {
      const el = document.querySelector(`.tray-card[data-ref="${CSS.escape(ref)}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: this.App.reducedMotion ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });
      el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
    },
    setTrayDragging(ref, on) {
      const el = document.querySelector(`.tray-card[data-ref="${CSS.escape(ref)}"]`);
      if (el) el.classList.toggle('dragging', on);
      this.root.classList.toggle('tray-dragging', on);
    },

    // ---------- 浮层：选中操作、建议、差值卡片、提示 ----------
    buildFloat() {
      this.actions = h('div', { class: 'float actions', 'data-ui': '', hidden: true, role: 'toolbar', 'aria-label': t('act_toolbar') });
      this.suggestChip = h('button', { class: 'float suggest', 'data-ui': '', hidden: true, onclick: () => this.App.acceptSuggestion() });
      this.dragChip = h('div', { class: 'float drag-chip', hidden: true });
      this.tip = h('div', { class: 'tip', hidden: true, role: 'tooltip' });
      this.overlay.append(this.actions, this.suggestChip, this.dragChip);
      document.body.append(this.tip);
    },
    renderSelection() {
      const App = this.App, sel = App.sel, a = this.actions;
      a.innerHTML = '';
      if (!sel || App.drag) { a.hidden = true; this.suggestChip.hidden = true; return; }
      const btn = (icon, label, fn, extra) => h('button', { class: `act ${extra || ''}`, onclick: (e) => { e.stopPropagation(); fn(); }, title: label, 'aria-label': label }, h('span', { html: ICONS[icon] }), h('span', { class: 'act-label' }, label));
      if (sel.type === 'part') {
        const part = M.partByRef(App.p, sel.ref);
        if (!part || !part.placed) { a.hidden = true; this.suggestChip.hidden = true; return; }
        a.append(h('span', { class: 'act-ref' }, `${part.ref} · ${M.faceName(part)}`),
          btn('rotate', t('act_rotate') + ' (R)', () => App.rotatePart(part.ref)),
          btn('flip', t('act_flip') + ' (F)', () => App.flipPart(part.ref)),
          btn('lock', (part.locked ? t('act_unlock') : t('act_lock')) + ' (L)', () => App.toggleLock(part.ref), part.locked ? 'on' : ''),
          btn('back', t('act_unplace'), () => App.unplace(part.ref)));
      } else {
        const s = M.satByRef(App.p, sel.ref);
        if (!s || !s.placed) { a.hidden = true; return; }
        const r = App.ev.satResults[s.ref] || {};
        a.append(h('span', { class: 'act-ref' }, `${s.ref} · ${s.label}${s.value ? ' ' + s.value : ''} → ${s.parent.join('.')}${Number.isFinite(r.dist) ? ` · ${f1(r.dist)} mm` : ''}`));
        if (s.pinned) a.append(btn('back', t('act_unpin'), () => App.unpinSat(s.ref)));
        else if (!App.editSats) a.append(h('span', { class: 'muted small act-note' }, t('act_sat_hint')));
      }
      a.hidden = false;
      const s = App.suggestion;
      if (s && sel.type === 'part' && sel.ref === s.ref) {
        this.suggestChip.innerHTML = '';
        this.suggestChip.append(h('span', {}, this.suggestText(s)), h('kbd', {}, t('suggest_accept')));
        this.suggestChip.hidden = false;
      } else this.suggestChip.hidden = true;
      this.positionOverlays();
    },
    suggestText(s) {
      return s.dCross < 0 ? t('suggest', { turn: s.turn, n: -s.dCross }) : t('suggest_len', { turn: s.turn, pct: Math.round(-s.dLenPct * 100) });
    },
    positionOverlays() {
      const App = this.App, R = App.renderer;
      if (!R || !App.p) return;
      const sel = App.sel;
      if (sel && !this.actions.hidden && !App.drag) {
        const it = M.itemByRef(App.p, sel.ref);
        if (it && it.placed) {
          const rect = sel.type === 'part' ? M.footprint(it) : M.satFootprint(it);
          const sr = R.screenRect(rect);
          const aw = this.actions.offsetWidth, ah = this.actions.offsetHeight;
          let x = sr.x + sr.w / 2 - aw / 2, y = sr.y - ah - 14;
          const ins = this.insets();
          if (y < ins.top + 6) y = sr.y + sr.h + 14;
          x = Math.max(ins.left + 6, Math.min(R.W - ins.right - aw - 6, x));
          this.actions.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
          if (!this.suggestChip.hidden && App.suggestion) {
            // 朝向建议放在器件下方（操作条在上方时），避免遮住相邻器件的位号
            const part = M.partByRef(App.p, App.suggestion.ref);
            const g = R.screenRect(G.union(rect, M.footprint(part, { ...part.placed, rot: App.suggestion.rot })));
            const cw = this.suggestChip.offsetWidth;
            const below = y < sr.y;
            const cx = Math.max(ins.left + 6, Math.min(R.W - ins.right - cw - 6, g.x + g.w / 2 - cw / 2));
            const cy = below ? g.y + g.h + 12 : g.y - this.suggestChip.offsetHeight - 12;
            this.suggestChip.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy)}px)`;
          }
        }
      }
      if (this.deltaCard && this.deltaCard.isConnected && this.deltaRef) {
        const it = M.partByRef(App.p, this.deltaRef);
        if (it && it.placed) {
          // 差值卡片放在器件右侧，不与上方的操作条、下方的朝向建议重叠
          const sr = R.screenRect(M.footprint(it));
          this.deltaCard.style.left = `${Math.round(sr.x + sr.w + 12)}px`;
          this.deltaCard.style.top = `${Math.round(sr.y + sr.h / 2 + 12)}px`;
        }
      }
    },
    showDeltaCard(d) {
      const App = this.App;
      if (!d || !d.ref || !App.delta || !App.delta.lines.length) return;
      if (this.deltaCard) this.deltaCard.remove();
      const short = App.delta.lines.map((l) => {
        if (l.kind === 'length') return { good: l.good, text: t('dc_length', { v: (App.delta.dLen > 0 ? '+' : '−') + f1(Math.abs(App.delta.dLen)) }) };
        if (l.kind === 'crossings') return { good: l.good, text: t('dc_cross', { v: (App.delta.dCross > 0 ? '+' : '−') + Math.abs(App.delta.dCross) }) };
        return { good: l.good, text: t('dc_cong', { v: (App.delta.dPeak > 0 ? '+' : '−') + Math.round(Math.abs(App.delta.dPeak) * 100) + '%' }) };
      });
      this.deltaCard = h('div', { class: 'delta-card', 'aria-hidden': 'true' }, ...short.map((s) => h('span', { class: s.good ? 'good' : 'bad' }, s.text)));
      this.deltaRef = d.ref;
      this.overlay.append(this.deltaCard);
      this.positionOverlays();
      const card = this.deltaCard;
      setTimeout(() => { if (card.isConnected) card.remove(); }, App.reducedMotion ? 2000 : 2400);
    },
    positionDragChip() {
      const App = this.App, d = App.drag, chip = this.dragChip;
      if (!d || !d.visible || d.status === 'ok' || !d.reason) { chip.hidden = true; return; }
      const R = App.renderer;
      const item = M.itemByRef(App.p, d.ref);
      const sr = R.screenRect(d.kind === 'part' ? M.footprint(item, d.pl) : M.satFootprint(item, d.pl));
      const r = d.reason;
      chip.textContent = d.status === 'bad' ? LP.t(`ui.toast_illegal_${r.reason}`, { ref: d.ref, with: r.with || '' }) : t(`drag_warn_${r.reason}`, { with: r.with, kind: r.kind });
      chip.className = `float drag-chip ${d.status}`;
      chip.hidden = false;
      chip.style.transform = `translate(${Math.round(sr.x + sr.w / 2 - chip.offsetWidth / 2)}px, ${Math.round(sr.y + sr.h + 10)}px)`;
    },
    showTip(d) {
      const App = this.App, tip = this.tip;
      if (!d || App.drag) { tip.hidden = true; return; }
      let text;
      if (d.type === 'part') {
        const x = M.partByRef(App.p, d.ref);
        text = t('tip_part', { ref: x.ref, label: M.faceName(x), w: x.w, h: x.h }) + (d.backside ? t('tip_backside') : '');
      } else {
        const s = M.satByRef(App.p, d.ref);
        const r = App.ev.satResults[s.ref] || {};
        text = t('tip_sat', { ref: s.ref, kind: s.label, value: s.value || '', parent: s.parent[0], pin: s.parent[1], d: Number.isFinite(r.dist) ? f1(r.dist) : '—' }) + (s.pinned ? t('tip_pinned') : '');
      }
      tip.textContent = text;
      tip.hidden = false;
      tip.style.transform = `translate(${Math.min(window.innerWidth - tip.offsetWidth - 8, d.x + 14)}px, ${d.y + 16}px)`;
    },
    toast(msg, level) {
      const box = $('#toasts');
      const el = h('div', { class: `toast ${level || 'info'}`, role: level === 'bad' ? 'alert' : 'status' }, msg);
      box.append(el);
      while (box.children.length > 3) box.firstChild.remove();
      setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, level === 'bad' ? 4200 : 3000);
    },

    // ---------- 帮助与首次引导 ----------
    openHelp() { $('#help').showModal(); },
    maybeIntro() {
      let seen = false;
      try { seen = localStorage.getItem('lp:intro-seen') === '1'; } catch (e) { /* 存储不可用 */ }
      $('#intro-start').addEventListener('click', () => {
        try { localStorage.setItem('lp:intro-seen', '1'); } catch (e) { /* 存储不可用 */ }
        $('#intro').close();
        this.maybeBoardSetup();
      });
      if (!seen) $('#intro').showModal();
      else this.maybeBoardSetup();
    },

    // ---------- 开场：选定板子尺寸 ----------
    maybeBoardSetup() {
      if (!this.App.boardConfirmed) this.openBoardSetup();
    },
    openBoardSetup() {
      const App = this.App, p = App.p, o = p.board.outline;
      const d = $('#board-setup');
      const body = $('#board-setup-body');
      body.innerHTML = '';
      const area = M.partsArea(p);
      const need = Math.ceil(Math.max(area.top, area.bottom) * 2.2 / 10) * 10;
      const presets = [];
      if (o.type === 'rect') presets.push({ id: 'project', label: t('bs_project'), outline: { type: 'rect', w: o.w, h: o.h, corner_r: o.corner_r || 0 } });
      if (o.type === 'circle') presets.push({ id: 'project', label: t('bs_project'), outline: { type: 'circle', d: o.d } });
      presets.push(
        { id: 'r30', label: t('bs_compact'), outline: { type: 'rect', w: 30, h: 20, corner_r: 2 } },
        { id: 'r40', label: t('bs_standard'), outline: { type: 'rect', w: 40, h: 30, corner_r: 3 } },
        { id: 'r50', label: t('bs_roomy'), outline: { type: 'rect', w: 50, h: 35, corner_r: 3 } },
        { id: 'c32', label: t('bs_round'), outline: { type: 'circle', d: 32 } },
        { id: 'custom', label: t('bs_custom'), outline: null },
      );
      let chosen = presets[0];
      const dimText = (ol) => ol.type === 'circle' ? `Ø ${ol.d} mm` : `${ol.w} × ${ol.h} mm`;
      const fits = (ol) => {
        const A = G.outlineArea({ corner_r: 0, ...ol });
        const bb = G.outlineBBox(ol);
        const minSide = Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) * (ol.type === 'circle' ? 0.7 : 1);
        return A >= need && minSide >= area.maxDim + 2;
      };
      const grid = h('div', { class: 'preset-grid', role: 'radiogroup', 'aria-label': t('bs_title') });
      const custom = h('div', { class: 'custom-row', hidden: true });
      const editor = this.shapeEditor(o, () => updateHint(), { allowCustom: false });
      custom.append(editor.el);
      custom.addEventListener('input', () => {
        for (const inp of custom.querySelectorAll('input[data-k]')) { const v = parseFloat(inp.value); if (Number.isFinite(v)) editor.state[inp.dataset.k] = v; }
        updateHint();
      });
      const customOutline = () => editor.value();
      const syncCustom = () => updateHint();
      const hint = h('p', { class: 'small bs-hint' });
      const updateHint = () => {
        const ol = chosen.outline || customOutline();
        const ok = !!ol;
        const A = ok ? Math.round(G.outlineArea({ corner_r: 0, ...ol })) : 0;
        hint.textContent = t('bs_area', { top: Math.round(area.top), bottom: Math.round(area.bottom), need, a: A });
        hint.classList.toggle('warn', ok && !fits(ol));
        if (ok && !fits(ol)) hint.textContent += ' ' + t('bs_too_small');
      };
      for (const pr of presets) {
        const btn = h('button', { class: `preset ${pr === chosen ? 'on' : ''}`, role: 'radio', 'aria-checked': String(pr === chosen), type: 'button' });
        const shape = h('span', { class: `preset-shape ${pr.outline && pr.outline.type === 'circle' ? 'circle' : pr.outline ? 'rect' : 'custom'}`, 'aria-hidden': 'true' });
        if (pr.outline && pr.outline.type === 'rect') { const k = 34 / Math.max(pr.outline.w, pr.outline.h); shape.style.width = `${pr.outline.w * k}px`; shape.style.height = `${pr.outline.h * k}px`; }
        btn.append(shape, h('span', { class: 'preset-label' }, pr.label), h('span', { class: 'preset-dim' }, pr.outline ? dimText(pr.outline) : t('bs_custom_dim')));
        if (pr.outline && !fits(pr.outline)) btn.append(h('span', { class: 'preset-warn' }, t('bs_tight')));
        btn.addEventListener('click', () => {
          chosen = pr;
          for (const b of grid.children) { b.classList.toggle('on', b === btn); b.setAttribute('aria-checked', String(b === btn)); }
          custom.hidden = pr.id !== 'custom';
          if (pr.id === 'custom') syncCustom(); else updateHint();
        });
        grid.append(btn);
      }
      const layers = h('select', {}, ...[2, 4, 6].map((n) => h('option', { value: n, selected: p.board.layers === n }, n)));
      const nh = p.board.holes.length;
      const holeOpts = [...(nh ? [['keep', t('bs_holes_keep', { n: nh })]] : []), ['corners', t('bs_holes_corners')], ['none', t('bs_holes_none')]];
      const holeSel = h('select', { id: 'bs-holes' }, ...holeOpts.map(([v, l], i) => h('option', { value: v, selected: i === 0 }, l)));
      const two = h('input', { type: 'checkbox', checked: p.board.two_sided });
      body.append(grid, custom, hint,
        h('div', { class: 'row2 bs-opts' },
          h('label', { class: 'field' }, h('span', {}, t('board_layers')), layers),
          h('label', { class: 'field check' }, two, h('span', {}, t('board_two_sided')))),
        h('label', { class: 'field bs-holes' }, h('span', {}, t('bs_holes')), holeSel),
        h('p', { class: 'muted small' }, t('bs_later')),
        h('p', { class: 'eda-note small' }, t('eda_final_outline')));
      updateHint();
      const go = $('#board-setup-go');
      go.onclick = () => {
        const ol = chosen.outline || customOutline();
        if (!ol) { this.toast(t('bs_invalid'), 'bad'); return; }
        d.close();
        App.setupBoard({ outline: ol, layers: parseInt(layers.value, 10), two_sided: two.checked, holes: holeSel.value });
        this.openStep = null;
        this.renderAll();
      };
      d.addEventListener('cancel', (e) => e.preventDefault(), { once: false });
      if (!d.open) d.showModal();
    },

    // ---------- 导入导出 ----------
    async importFile(file) {
      if (!file) return;
      const App = this.App;
      let raw;
      try { raw = JSON.parse(await file.text()); } catch (e) { this.toast(t('import_parse_error'), 'bad'); return; }
      const res = App.load(raw, { skipRestore: true });
      $('#file-input').value = '';
      if (!res.ok) { this.showErrors(res.errors); return; }
      this.r2.fit(true);
      this.toast(t('import_ok', { name: App.p.name }), 'info');
    },
    showErrors(errors) {
      const d = $('#errors');
      const list = $('#errors-list');
      list.innerHTML = '';
      $('#errors-title').textContent = t('import_error', { n: errors.length });
      for (const e of errors.slice(0, 50)) list.append(h('li', {}, h('code', {}, e.path || '(根)'), ' ', e.msg));
      d.showModal();
    },
    exportPNG() {
      const App = this.App;
      const W = 1600, H = 1200;
      const host = h('div', { style: `position:fixed;left:-20000px;top:0;width:${W}px;height:${H}px` });
      const cv = h('canvas');
      host.append(cv);
      document.body.append(host);
      const r = new LP.Renderer2D(App, cv, null, { noInsets: true });
      r.fit(false);
      r.draw();
      const ctx = cv.getContext('2d');
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = App.theme === 'dark' ? '#1d1f23' : '#ebe8e2';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.restore();
      cv.toBlob((blob) => { App.download(`${App.slug()}-layout.png`, blob); host.remove(); }, 'image/png');
    },
  };

  LP.ui = ui;
})(globalThis.LP = globalThis.LP || {});
