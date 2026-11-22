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
      App.on('load', () => this.renderAll(true));
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
      App.reducedMotion = mq.matches;
      mq.addEventListener && mq.addEventListener('change', (e) => { App.reducedMotion = e.matches; });
      this.onResize(true);
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
        this.r3.syncFrom(this.r2);
        App.renderer = this.r3;
        this.r3.resize(); this.r3.rebuild();
      } else {
        App.view = '2d';
        this.root.classList.remove('is-3d');
        if (this.r3) this.r2.syncFrom3d && this.r2.syncFrom3d(this.r3);
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
        }, part.placed ? '✓ ' : '', ref, h('span', { class: 'muted' }, ` ${part.label}`)));
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
      const shape = h('select', { onchange: (e) => {
        const v = e.target.value;
        if (v === 'rect') App.setBoard({ outline: { type: 'rect', w: o.w || o.d || 30, h: o.h || o.d || 20, corner_r: o.corner_r || 2 } });
        if (v === 'circle') App.setBoard({ outline: { type: 'circle', d: o.d || Math.max(o.w || 20, o.h || 20) } });
      } },
      h('option', { value: 'rect', selected: o.type === 'rect' }, t('board_rect')),
      h('option', { value: 'circle', selected: o.type === 'circle' }, t('board_circle')),
      o.type === 'polygon' ? h('option', { value: 'polygon', selected: true, disabled: true }, t('board_polygon')) : null);
      wrap.append(h('label', { class: 'field' }, h('span', {}, t('board_shape')), shape));
      if (o.type === 'rect') wrap.append(
        h('div', { class: 'row2' }, num(t('board_w'), o.w, (v) => App.setBoard({ outline: { w: v } })), num(t('board_h'), o.h, (v) => App.setBoard({ outline: { h: v } }))),
        num(t('board_r'), o.corner_r || 0, (v) => App.setBoard({ outline: { corner_r: v } })));
      if (o.type === 'circle') wrap.append(num(t('board_d'), o.d, (v) => App.setBoard({ outline: { d: v } })));
      wrap.append(h('div', { class: 'row2' },
        h('label', { class: 'field' }, h('span', {}, t('board_layers')), h('select', { onchange: (e) => App.setBoard({ layers: parseInt(e.target.value, 10) }) }, ...[2, 4, 6].map((n) => h('option', { value: n, selected: b.layers === n }, n)))),
        num(t('board_thickness'), b.thickness, (v) => App.setBoard({ thickness: v }), 0.1)));
      wrap.append(h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: b.two_sided, onchange: (e) => App.setBoard({ two_sided: e.target.checked }) }), h('span', {}, t('board_two_sided'))));
      wrap.append(h('p', { class: 'muted small' }, t('board_holes', { n: b.holes.length, m: b.keepouts.length })));
      if (o.type !== 'polygon') wrap.append(h('p', { class: 'muted small' }, t('board_edit_hint')));
      wrap.append(h('button', { class: 'primary', onclick: () => { App.confirmBoard(); this.openStep = null; this.renderSteps(); } }, App.boardConfirmed ? t('board_reconfirm') : t('board_confirm')));
      return wrap;
    },
    renderBoardForm() {
      const o = this.App.p.board.outline;
      const f = $('#board-form');
      if (!f) return;
      const inputs = f.querySelectorAll('input[type=number]');
      if (o.type === 'rect' && inputs.length >= 2) { inputs[0].value = o.w; inputs[1].value = o.h; }
      if (o.type === 'circle' && inputs.length) inputs[0].value = o.d;
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
        h('button', { onclick: () => this.exportPNG() }, t('export_png_short'))));
      box.append(h('p', { class: 'muted small' }, t('check_handback')));
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
        const sub = r.k === 'exit' && m.exit.worst ? t('m_exit_where', { ref: m.exit.worst.ref, side: LP.S.sideCN[m.exit.worst.side], need: m.exit.worst.need, ch: Math.floor(m.exit.worst.channels) })
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
        const card = h('button', { class: `tray-card ${x.placed ? 'placed' : ''} ${hot ? 'hot' : ''}`, 'data-ref': x.ref, title: `${x.ref} · ${x.label} · ${x.w}×${x.h} mm`, 'aria-label': `${x.ref} ${x.label}${x.placed ? ' ' + t('tray_placed') : ''}` });
        const cv = h('canvas', { class: 'thumb', width: 64, height: 44, 'aria-hidden': 'true' });
        card.append(cv, h('span', { class: 'tray-ref' }, x.ref), h('span', { class: 'tray-label' }, x.label));
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
        a.append(h('span', { class: 'act-ref' }, part.ref),
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
        text = t('tip_part', { ref: x.ref, label: x.label, w: x.w, h: x.h }) + (d.backside ? t('tip_backside') : '');
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
      if (!seen) $('#intro').showModal();
      $('#intro-start').addEventListener('click', () => { try { localStorage.setItem('lp:intro-seen', '1'); } catch (e) { /* 存储不可用 */ } $('#intro').close(); });
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
