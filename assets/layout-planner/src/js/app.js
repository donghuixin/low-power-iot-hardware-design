/*
 * app.js — 应用状态与操作：加载项目、提交修改（评估、差值、撤销栈）、选择、朝向建议、自动保存、导入导出。
 * 绘制层（2D/3D）和界面只读取这里的状态，通过事件 'change' / 'select' / 'load' / 'view' 得知更新。
 */
(function (LP) {
  'use strict';
  const M = LP.model, G = LP.geometry;

  const STORAGE_PREFIX = 'lp:v1:';
  const UNDO_LIMIT = 100;

  const App = {
    p: null, ev: null,
    boardConfirmed: false, boardEditing: false,
    sel: null, hover: null,
    view: '2d', flipped: false,
    layers: { keepout: true, edge: false, heat: false, magnetic: false, congestion: false, sats: true, halo: true, grid: true },
    editSats: false,
    theme: 'light',
    animOn: false,          // 动效开关，默认关闭
    systemReduced: false,   // 系统"减少动态效果"
    /** 动效关闭或系统要求减少动态效果时，不播放动画（卫星仍静止排在器件周围）。 */
    get reducedMotion() { return this.systemReduced || !this.animOn; },
    undoStack: [], redoStack: [],
    drag: null, suggestion: null, delta: null, focusIssue: null,
    storageOk: true,
    renderer: null,
    listeners: {},

    on(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); },
    emit(name, data) { for (const fn of this.listeners[name] || []) fn(data); },
    /** 面板遮挡的区域（像素），由界面层提供。 */
    insets() { return LP.ui ? LP.ui.insets() : { left: 0, right: 0, top: 0, bottom: 0 }; },
    redraw() { if (this.renderer) this.renderer.requestDraw(); },

    // ---------- 加载 ----------
    /** 加载原始项目数据。返回 {ok, errors}。 */
    load(raw, opts) {
      const errors = M.validate(raw);
      if (errors.length) return { ok: false, errors };
      this.p = M.normalize(raw);
      this.boardConfirmed = !!(raw.result || this.p.parts.some((x) => x.placed));
      this.undoStack = []; this.redoStack = [];
      this.sel = null; this.suggestion = null; this.delta = null; this.focusIssue = null;
      if (!(opts && opts.skipRestore)) this.restoreAutosave();
      this.evaluate();
      this.emit('load');
      return { ok: true, errors: [] };
    },
    evaluate() {
      this.ev = LP.engine.evaluate(this.p, { boardConfirmed: this.boardConfirmed });
      return this.ev;
    },

    // ---------- 提交 ----------
    /** 执行一次修改：记录撤销点、重新评估、计算差值、触发动画与界面更新。 */
    commit(label, fn, opts) {
      opts = opts || {};
      const before = M.snapshot(this.p);
      const mBefore = this.ev ? this.ev.metrics : null;
      const satBefore = new Map(this.p.satellites.filter((s) => s.placed && s._active).map((s) => [s.ref, { x: s.placed.x, y: s.placed.y }]));
      const stepsBefore = this.ev ? this.ev.steps.map((s) => s.state) : [];
      const res = fn();
      if (res === false) return false;
      if (M.snapshot(this.p) === before) return false;
      this.undoStack.push(before);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.afterChange(label, mBefore, satBefore, stepsBefore, opts);
      return true;
    },
    afterChange(label, mBefore, satBefore, stepsBefore, opts) {
      this.evaluate();
      this.delta = mBefore && !opts.noDelta ? { ...LP.metrics.diff(mBefore, this.ev.metrics, this.p), ref: opts.ref || null, at: Date.now(), label } : null;
      // 卫星弹出：新出现或移动过的卫星
      const r = this.renderer;
      if (r && opts.ref && !opts.noAnim) {
        const parent = M.partByRef(this.p, opts.ref);
        let k = 0;
        for (const s of this.p.satellites) {
          if (!s.placed || !s._active || s.pinned || s.parent[0] !== opts.ref) continue;
          const b = satBefore.get(s.ref);
          if (b && Math.hypot(b.x - s.placed.x, b.y - s.placed.y) < 0.01) continue;
          const orbit = opts.orbitFrom && opts.orbitFrom[s.ref];
          if (orbit) r.animate('pop', { ref: s.ref, delay: 60 + 35 * k++, dur: 420, from: orbit, orbit: true });
          else r.animate('pop', { ref: s.ref, delay: 140 + 20 * k++, dur: 260, from: parent && parent.placed ? { x: parent.placed.x, y: parent.placed.y } : null });
        }
        if (parent && parent.placed) {
          r.animate('drop', { ref: opts.ref });
          const fp = M.footprint(parent);
          r.animate('ripple', { x: parent.placed.x, y: parent.placed.y, r: Math.max(G.width(fp), G.height(fp)) / 2 });
        }
      }
      // 步骤刚完成时闪过一道浅光
      if (r && stepsBefore.length) {
        this.ev.steps.forEach((s, i) => {
          if (s.state === 'done' && stepsBefore[i] !== 'done' && s.parts.length) r.animate('flash', { refs: s.parts });
        });
      }
      this.updateSuggestion();
      this.scheduleAutosave();
      this.emit('change', { label, ref: opts.ref });
      this.redraw();
    },
    undo() {
      if (!this.undoStack.length) return;
      const mBefore = this.ev.metrics;
      this.redoStack.push(M.snapshot(this.p));
      M.restore(this.p, this.undoStack.pop());
      this.afterChange(LP.t('ui.undo'), mBefore, new Map(), [], { noAnim: true });
    },
    redo() {
      if (!this.redoStack.length) return;
      const mBefore = this.ev.metrics;
      this.undoStack.push(M.snapshot(this.p));
      M.restore(this.p, this.redoStack.pop());
      this.afterChange(LP.t('ui.redo'), mBefore, new Map(), [], { noAnim: true });
    },

    // ---------- 选择与建议 ----------
    select(sel) {
      this.sel = sel;
      this.updateSuggestion();
      this.emit('select');
      this.redraw();
    },
    updateSuggestion() {
      this.suggestion = null;
      if (!this.sel || this.sel.type !== 'part') return;
      this.suggestion = LP.metrics.orientationSuggestion(this.p, this.sel.ref, (part, pl) => LP.rules.quickLegal(this.p, part, pl).ok);
    },
    acceptSuggestion() {
      const s = this.suggestion;
      if (!s) return;
      const part = M.partByRef(this.p, s.ref);
      this.commit(LP.t('ui.op_rotate'), () => { part.placed = { ...part.placed, rot: s.rot }; }, { ref: s.ref });
    },
    focusOn(refs) {
      let r = null;
      for (const ref of refs) {
        const it = M.itemByRef(this.p, ref);
        if (!it || !it.placed) continue;
        r = G.union(r, it.kind && M.SAT_KINDS[it.kind] ? M.satFootprint(it) : M.footprint(it));
      }
      if (r && this.renderer) this.renderer.focus(r);
    },

    // ---------- 器件操作 ----------
    defaultSide(part) {
      if (part.sides.includes('top') && !this.flipped) return 'top';
      if (part.sides.includes('bottom') && (this.flipped || !part.sides.includes('top'))) return 'bottom';
      return part.sides[0];
    },
    placePart(ref, pl, extra) {
      const part = M.partByRef(this.p, ref);
      return this.commit(LP.t('ui.op_place'), () => { part.placed = { ...pl }; }, { ref, ...(extra || {}) });
    },
    tryTransform(ref, fn, label) {
      const part = M.partByRef(this.p, ref);
      if (!part || !part.placed) return false;
      if (part.locked) { this.toast(LP.t('ui.toast_locked', { ref }), 'warn'); return false; }
      const pl = fn({ ...part.placed }, part);
      if (!pl) return false;
      const q = LP.rules.quickLegal(this.p, part, pl);
      if (!q.ok) { this.toast(LP.t(`ui.toast_illegal_${q.reason}`, { ref, with: q.with || '' }), 'bad'); this.emit('shake', ref); return false; }
      return this.commit(label, () => { part.placed = pl; }, { ref });
    },
    rotatePart(ref) { return this.tryTransform(ref, (pl) => ({ ...pl, rot: (pl.rot + 90) % 360 }), LP.t('ui.op_rotate')); },
    flipPart(ref) {
      const part = M.partByRef(this.p, ref);
      if (!this.p.board.two_sided) { this.toast(LP.t('ui.toast_single_sided'), 'warn'); return false; }
      const other = part.placed && part.placed.side === 'top' ? 'bottom' : 'top';
      if (!part.sides.includes(other)) { this.toast(LP.t('ui.toast_side_not_allowed', { ref, side: LP.t(`ui.side_${other}`) }), 'warn'); return false; }
      return this.tryTransform(ref, (pl) => ({ ...pl, side: other }), LP.t('ui.op_flip'));
    },
    nudge(ref, dx, dy) { return this.tryTransform(ref, (pl) => ({ ...pl, x: pl.x + dx, y: pl.y + dy }), LP.t('ui.op_move')); },
    toggleLock(ref) {
      const part = M.partByRef(this.p, ref);
      if (!part || !part.placed) return;
      this.commit(LP.t(part.locked ? 'ui.op_unlock' : 'ui.op_lock'), () => { part.locked = !part.locked; }, { ref, noAnim: true, noDelta: true });
    },
    unplace(ref) {
      const part = M.partByRef(this.p, ref);
      if (!part || !part.placed) return;
      if (part.locked) { this.toast(LP.t('ui.toast_locked', { ref }), 'warn'); return; }
      this.commit(LP.t('ui.op_unplace'), () => { part.placed = null; }, { ref, noAnim: true });
      if (this.sel && this.sel.ref === ref) this.select(null);
    },
    moveSat(ref, pl) {
      const s = M.satByRef(this.p, ref);
      this.commit(LP.t('ui.op_pin_sat'), () => { s.placed = { ...pl }; s.pinned = true; }, { noAnim: true });
    },
    unpinSat(ref) {
      const s = M.satByRef(this.p, ref);
      if (!s || !s.pinned) return;
      this.commit(LP.t('ui.op_unpin_sat'), () => { s.pinned = false; }, { ref: s.parent[0] });
    },
    unpinAll() {
      if (!this.p.satellites.some((s) => s.pinned)) return;
      this.commit(LP.t('ui.op_unpin_all'), () => { for (const s of this.p.satellites) s.pinned = false; }, { noAnim: true });
    },
    setBoard(patch) {
      this.commit(LP.t('ui.op_board'), () => {
        const b = this.p.board;
        if (patch.outline) {
          const old = { ...b.outline };
          b.outline = patch.outline.type && patch.outline.type !== old.type ? { ...patch.outline } : { ...b.outline, ...patch.outline };
          M.remapBoardFeatures(b, old, b.outline);
        }
        for (const k of ['layers', 'thickness', 'two_sided', 'mask']) if (patch[k] !== undefined) b[k] = patch[k];
        if (patch.two_sided === false) for (const x of this.p.parts) if (x.placed && x.placed.side === 'bottom' && x.sides.includes('top')) x.placed.side = 'top';
      }, { noAnim: true, noDelta: true });
      if (this.renderer) this.renderer.requestDraw();
    },
    /** 开场选定的板框：直接写入（不进撤销栈），然后确认。 */
    setupBoard(patch) {
      const b = this.p.board;
      const old = { ...b.outline };
      b.outline = { corner_r: 0, ...patch.outline };
      M.remapBoardFeatures(b, old, b.outline);
      if (patch.layers) b.layers = patch.layers;
      if (patch.two_sided !== undefined) b.two_sided = patch.two_sided;
      this.confirmBoard();
      if (this.renderer) this.renderer.fit(true);
    },
    confirmBoard() {
      this.boardConfirmed = true;
      this.boardEditing = false;
      this.evaluate();
      this.scheduleAutosave();
      this.emit('change', { label: LP.t('ui.op_board') });
      this.redraw();
    },
    resetLayout() {
      this.commit(LP.t('ui.op_reset'), () => {
        for (const x of this.p.parts) { x.placed = null; x.locked = false; }
        for (const s of this.p.satellites) { s.placed = null; s.pinned = false; }
      }, { noAnim: true });
      this.select(null);
    },

    // ---------- 自动保存 ----------
    storageKey() { return STORAGE_PREFIX + this.p.name + ':' + M.definitionHash(this.p); },
    scheduleAutosave() {
      clearTimeout(this._saveT);
      this._saveT = setTimeout(() => this.autosave(), 300);
    },
    autosave() {
      try {
        localStorage.setItem(this.storageKey(), JSON.stringify({ snap: M.snapshot(this.p), boardConfirmed: this.boardConfirmed, ts: Date.now() }));
        if (!this.storageOk) { this.storageOk = true; this.emit('storage'); }
      } catch (e) {
        if (this.storageOk) { this.storageOk = false; this.emit('storage'); }
      }
    },
    restoreAutosave() {
      try {
        const v = localStorage.getItem(this.storageKey());
        if (!v) return false;
        const o = JSON.parse(v);
        M.restore(this.p, o.snap);
        this.boardConfirmed = !!o.boardConfirmed;
        this.restored = true;
        return true;
      } catch (e) {
        this.storageOk = false;
        return false;
      }
    },
    clearAutosave() { try { localStorage.removeItem(this.storageKey()); } catch (e) { /* 存储不可用时忽略 */ } },

    // ---------- 导出 ----------
    slug() { return (this.p.name || 'layout').replace(/[\\/:*?"<>|\s]+/g, '-'); },
    download(name, text, type) {
      const blob = text instanceof Blob ? text : new Blob([text], { type });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
    exportJSON() { this.download(`${this.slug()}-layout.json`, JSON.stringify(M.exportLayout(this.p, this.ev), null, 2), 'application/json'); },
    exportCSV() { this.download(`${this.slug()}-placement.csv`, '﻿' + M.exportCSV(this.p), 'text/csv'); },

    setAnim(on) {
      this.animOn = !!on;
      try { localStorage.setItem('lp:anim', on ? '1' : '0'); } catch (e) { /* 存储不可用 */ }
      if (!on && this.renderer) this.renderer.anims = this.renderer.anims.filter((x) => x.type === 'view' || x.type === 'flip');
      this.emit('anim');
      this.redraw();
    },

    toast(msg, level) { this.emit('toast', { msg, level: level || 'info' }); },
  };

  LP.App = App;
})(globalThis.LP = globalThis.LP || {});
