/*
 * interaction.js — 指针、触屏、键盘与托盘拖放。只在毫米坐标中工作，屏幕↔板面换算交给当前绘制层（2D 或 3D）。
 */
(function (LP) {
  'use strict';
  const M = LP.model, G = LP.geometry;

  const GRID = 0.5;          // 吸附网格（mm）
  const ALIGN_PX = 7;        // 对齐吸附阈值（屏幕像素）
  const CLICK_PX = 4;

  function init(App, stage) {
    const R = () => App.renderer;
    const ptrs = new Map();
    let gesture = null;       // {type:'pan'|'orbit'|'pinch'|'drag'|'resize'|'press', ...}
    let spaceDown = false;

    const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const overStage = (e) => { const r = stage.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && !LP.ui.isOverPanel(e.clientX, e.clientY); };

    // ---------- 拖动器件 ----------
    function snapAndAlign(item, pl, isSat, alt) {
      let x = pl.x, y = pl.y;
      if (!alt) { x = Math.round(x / GRID) * GRID; y = Math.round(y / GRID) * GRID; }
      const guides = [];
      if (!alt && !isSat) {
        const fp = M.footprint(item, { ...pl, x, y });
        const thr = ALIGN_PX / Math.max(R().s || 20, 1);
        const xs = [], ys = [];
        for (const q of App.p.parts) {
          if (q === item || !q.placed) continue;
          const r = M.footprint(q);
          xs.push(r.x0, (r.x0 + r.x1) / 2, r.x1); ys.push(r.y0, (r.y0 + r.y1) / 2, r.y1);
        }
        const bb = G.outlineBBox(App.p.board.outline);
        // 板边优先：贴边器件吸到距板边 0.3 mm（装配间距），阈值放宽到 1.5 倍
        const EDGE = 0.3;
        const bxs = [bb.x0 + EDGE, bb.x1 - EDGE], bys = [bb.y0 + EDGE, bb.y1 - EDGE];
        const best = (mine, cands, k) => {
          let b = null;
          for (const m of mine) for (const c of cands) { const d = c - m; if (Math.abs(d) < thr * k && (!b || Math.abs(d) < Math.abs(b.d))) b = { d, v: c }; }
          return b;
        };
        const bx = best([fp.x0, fp.x1], bxs, 1.5) || best([fp.x0, (fp.x0 + fp.x1) / 2, fp.x1], xs, 1);
        const by = best([fp.y0, fp.y1], bys, 1.5) || best([fp.y0, (fp.y0 + fp.y1) / 2, fp.y1], ys, 1);
        if (bx) { x += bx.d; guides.push({ axis: 'x', v: bx.v }); }
        if (by) { y += by.d; guides.push({ axis: 'y', v: by.v }); }
      }
      return { pl: { ...pl, x, y }, guides };
    }
    function satStatus(s, pl) {
      const r = M.satFootprint(s, pl);
      if (!G.rectInBoard(App.p.board.outline, r)) return 'bad';
      for (const q of App.p.parts) if (q.placed && (q.through || q.placed.side === pl.side) && G.overlaps(r, M.footprint(q))) return 'bad';
      for (const o of App.p.satellites) if (o !== s && o.placed && o._active && o.placed.side === pl.side && G.overlaps(r, M.satFootprint(o))) return 'bad';
      return 'ok';
    }
    function startDrag(kind, ref, sp, fromTray) {
      const item = M.itemByRef(App.p, ref);
      if (kind === 'part' && item.locked) { App.toast(LP.t('ui.toast_locked', { ref }), 'warn'); return false; }
      const bp = R().screenToBoard(sp.x, sp.y);
      if (!bp) return false;
      const orig = item.placed && (kind === 'sat' || item.placed) ? { ...item.placed } : null;
      const pl0 = orig ? { ...orig } : { x: bp.x, y: bp.y, rot: 0, side: App.defaultSide(item) };
      App.drag = {
        kind, ref, fromTray: !!fromTray, orig, pl: pl0, raw: pl0, lastLegal: orig, guides: [], status: 'ok', moved: false,
        dx: orig ? bp.x - orig.x : 0, dy: orig ? bp.y - orig.y : 0, visible: !fromTray,
      };
      App.select({ type: kind, ref });
      return true;
    }
    function moveDrag(sp, alt) {
      const d = App.drag;
      const bp = R().screenToBoard(sp.x, sp.y);
      if (!bp) return;
      const item = M.itemByRef(App.p, d.ref);
      const raw = { ...d.pl, x: bp.x - d.dx, y: bp.y - d.dy };
      const { pl, guides } = snapAndAlign(item, raw, d.kind === 'sat', alt);
      d.raw = raw; d.pl = pl; d.guides = guides; d.moved = true; d.visible = true;
      if (d.kind === 'part') {
        const st = LP.rules.dragStatus(App.p, item, pl);
        d.status = st.level; d.reason = st;
      } else d.status = satStatus(item, pl);
      if (d.status !== 'bad') d.lastLegal = { ...pl };
      setCarrying(d.kind === 'part');
      App.emit('dragmove', { sp });
      App.redraw();
    }

    /** 拾取中：隐藏系统光标，由器件本身充当光标。 */
    function setCarrying(on) {
      document.getElementById('app').classList.toggle('carrying', !!on);
    }

    /**
     * 单击拾取：器件（和它的卫星）悬浮在光标处，移动指针即跟随；
     * 再次单击落地。点到托盘则放回托盘，点到其他面板或按 Esc 则取消。右键在拾取中旋转 90°。
     */
    let carry = null;
    function startCarry(ref, sp, fromTray) {
      if (!startDrag('part', ref, sp, fromTray)) return false;
      App.drag.carry = true;
      App.emit('hover', null);
      if (fromTray) App.drag.visible = false;
      else { App.drag.visible = true; App.drag.moved = false; App.drag.raw = { ...App.drag.pl }; setCarrying(true); }
      LP.ui.setTrayDragging(ref, true);
      const move = (ev) => {
        if (!App.drag) return;
        if (overStage(ev)) moveDrag(local(ev), ev.altKey);
        else { App.drag.visible = false; setCarrying(false); App.emit('dragmove', { offStage: true }); App.redraw(); }
      };
      const down = (ev) => {
        if (!App.drag) { cleanup(); return; }
        ev.preventDefault(); ev.stopPropagation();
        if (ev.button === 2) { rotateDrag(); return; }
        const inTray = ev.target && ev.target.closest && ev.target.closest('#tray');
        cleanup();
        if (overStage(ev)) {
          if (!App.drag.moved) moveDrag(local(ev), ev.altKey);
          endDrag(true);
        } else if (inTray && App.drag.orig) { cancelDrag(); App.unplace(ref); }
        else cancelDrag();
      };
      const ctx = (ev) => { ev.preventDefault(); };
      function cleanup() {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerdown', down, true);
        window.removeEventListener('contextmenu', ctx, true);
        LP.ui.setTrayDragging(ref, false);
        carry = null;
      }
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerdown', down, true);
      window.addEventListener('contextmenu', ctx, true);
      carry = { cleanup };
      App.redraw();
      return true;
    }
    function cancelDrag() {
      if (carry) carry.cleanup();
      const d = App.drag;
      App.drag = null;
      setCarrying(false);
      if (R()) R().orbitPos = null;
      App.emit('dragend');
      if (d && d.orig) {
        // 取消：卫星落回原位
        LP.satellites.satsOf(App.p, d.ref).forEach((s, k) => { if (s.placed && s._active && !s.pinned) R().animate('pop', { ref: s.ref, delay: 30 * k, dur: 260 }); });
      }
      App.redraw();
    }
    function rotateDrag() {
      const d = App.drag;
      d.pl = { ...d.pl, rot: (d.pl.rot + 90) % 360 };
      d.raw = { ...d.raw, rot: d.pl.rot };
      const item = M.itemByRef(App.p, d.ref);
      if (d.kind === 'part') { const st = LP.rules.dragStatus(App.p, item, d.pl); d.status = st.level; d.reason = st; }
      if (d.status !== 'bad') d.lastLegal = { ...d.pl };
      App.emit('dragmove', {});
      App.redraw();
    }
    function endDrag(dropOnStage) {
      const d = App.drag;
      App.drag = null;
      setCarrying(false);
      App.emit('dragend');
      if (!d) return;
      if (!d.moved && !d.fromTray) { App.redraw(); return; }
      if (d.fromTray && !dropOnStage) { App.redraw(); return; }
      let target = d.status === 'bad' ? d.lastLegal : d.pl;
      if (d.status === 'bad') {
        const why = d.reason ? LP.t(`ui.toast_illegal_${d.reason.reason}`, { ref: d.ref, with: d.reason.with || '' }) : LP.t('ui.toast_illegal_overlap', { ref: d.ref, with: '' });
        App.toast(why + (target ? LP.t('ui.toast_reverted') : ''), 'bad');
      }
      const orbitFrom = d.kind === 'part' && R().orbitPos ? { ...R().orbitPos } : null;
      if (R()) R().orbitPos = null;
      if (!target || (d.orig && target.x === d.orig.x && target.y === d.orig.y && target.rot === d.orig.rot && target.side === d.orig.side)) {
        // 没有移动：卫星从轨道飞回原位
        if (orbitFrom && d.orig) {
          let k = 0;
          for (const [ref, from] of Object.entries(orbitFrom)) {
            const s = M.satByRef(App.p, ref);
            if (s && s.placed && s._active) R().animate('pop', { ref, delay: 40 + 30 * k++, dur: 380, from, orbit: true });
          }
        }
        App.redraw(); return;
      }
      if (d.kind === 'part') App.placePart(d.ref, target, { orbitFrom });
      else App.moveSat(d.ref, target);
      if (d.kind === 'part' && d.reason && d.reason.level === 'warn' && d.reason.reason === 'halo') App.toast(LP.t('ui.toast_halo', { with: d.reason.with, kind: d.reason.kind }), 'warn');
    }

    // ---------- 板框缩放 ----------
    function handleAt(sp) {
      if (!App.boardEditing || R().kind !== '2d') return null;
      for (const h of R().boardHandles()) if (Math.hypot(h.x - sp.x, h.y - sp.y) < 10) return h;
      return null;
    }

    // ---------- 指针事件 ----------
    stage.addEventListener('pointerdown', (e) => {
      if (LP.ui.isOverPanel(e.clientX, e.clientY)) return;
      App.emit('hover', null);
      stage.setPointerCapture(e.pointerId);
      const sp = local(e);
      ptrs.set(e.pointerId, sp);
      if (ptrs.size === 2) {
        if (App.drag) { App.drag = null; App.emit('dragend'); }
        const [a, b] = [...ptrs.values()];
        gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        return;
      }
      const h = handleAt(sp);
      if (h && e.button === 0) {
        gesture = { type: 'resize', handle: h.id, orig: JSON.parse(JSON.stringify(App.p.board.outline)) };
        return;
      }
      if (e.button === 1 || (e.button === 0 && spaceDown)) { gesture = { type: 'pan', last: sp }; return; }
      if (e.button === 2) { gesture = { type: R().kind === '3d' ? 'orbit' : 'pan', last: sp }; return; }
      const hit = R().pick(sp.x, sp.y);
      if (hit && (hit.type === 'part' || (hit.type === 'sat' && App.editSats))) {
        gesture = { type: 'press', start: sp, hit };
        return;
      }
      gesture = { type: 'press', start: sp, hit, panIfMove: true, last: sp };
    });
    stage.addEventListener('pointermove', (e) => {
      const sp = local(e);
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, sp);
      if (!gesture) {
        if (App.drag) return;
        const h = handleAt(sp);
        if (h) { stage.style.cursor = h.cursor; App.emit('hover', null); return; }
        const hit = R().pick(sp.x, sp.y);
        stage.style.cursor = hit ? (hit.type === 'part' && !M.partByRef(App.p, hit.ref).locked ? 'grab' : 'pointer') : 'default';
        const key = hit ? hit.ref : null;
        if (key !== (App.hover && App.hover.ref)) { App.hover = hit; }
        App.emit('hover', hit ? { ...hit, x: e.clientX, y: e.clientY } : null);
        return;
      }
      if (gesture.type === 'pinch' && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        R().zoomAt(mid.x, mid.y, dist / gesture.dist);
        R().pan(mid.x - gesture.mid.x, mid.y - gesture.mid.y);
        gesture.dist = dist; gesture.mid = mid;
        return;
      }
      if (gesture.type === 'pan') { R().pan(sp.x - gesture.last.x, sp.y - gesture.last.y); gesture.last = sp; return; }
      if (gesture.type === 'orbit') { R().orbit(sp.x - gesture.last.x, sp.y - gesture.last.y); gesture.last = sp; return; }
      if (gesture.type === 'resize') {
        const bp = R().screenToBoard(sp.x, sp.y);
        const o = App.p.board.outline;
        const q = (v) => Math.max(5, Math.round(v * 2) / 2);
        if (gesture.handle === 'e' || gesture.handle === 'ne') o.w = q(bp.x);
        if (gesture.handle === 'n' || gesture.handle === 'ne') o.h = q(bp.y);
        if (gesture.handle === 'd') o.d = q(bp.x);
        if (gesture.handle[0] === 'v') {
          // 拖动多边形顶点：形状变为自定义多边形
          const i = parseInt(gesture.handle.slice(1), 10);
          o.shape = 'custom';
          for (const k of ['w', 'h', 'c', 'nw', 'nh']) delete o[k];
          o.points[i] = [Math.round(bp.x * 2) / 2, Math.round(bp.y * 2) / 2];
        }
        App.emit('boardlive');
        App.redraw();
        return;
      }
      if (gesture.type === 'press') {
        const moved = Math.hypot(sp.x - gesture.start.x, sp.y - gesture.start.y) > CLICK_PX;
        if (!moved) return;
        if (gesture.panIfMove) { gesture = { type: 'pan', last: gesture.last }; R().pan(sp.x - gesture.last.x, sp.y - gesture.last.y); gesture.last = sp; return; }
        if (startDrag(gesture.hit.type, gesture.hit.ref, gesture.start, false)) { gesture = { type: 'drag' }; stage.style.cursor = 'grabbing'; moveDrag(sp, e.altKey); }
        else gesture = null;
        return;
      }
      if (gesture.type === 'drag' && App.drag) moveDrag(sp, e.altKey);
    });
    const up = (e) => {
      const sp = local(e);
      ptrs.delete(e.pointerId);
      if (!gesture) return;
      const g = gesture;
      if (g.type === 'pinch') { if (ptrs.size < 2) gesture = null; return; }
      gesture = null;
      stage.style.cursor = 'default';
      if (g.type === 'drag') { endDrag(true); return; }
      if (g.type === 'resize') {
        const now = { ...App.p.board.outline };
        App.p.board.outline = g.orig;
        App.setBoard({ outline: now });
        return;
      }
      if (g.type === 'press') {
        const hit = R().pick(sp.x, sp.y);
        App.focusIssue = null;
        if (hit && hit.type === 'part' && e.button === 0 && !M.partByRef(App.p, hit.ref).locked) { startCarry(hit.ref, g.start, false); return; }
        App.select(hit ? { type: hit.type, ref: hit.ref } : null);
      }
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', (e) => { ptrs.delete(e.pointerId); if (gesture && gesture.type === 'drag') cancelDrag(); gesture = null; });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    // 编辑板框时：双击多边形的边添加顶点，双击顶点删除
    stage.addEventListener('dblclick', (e) => {
      if (!App.boardEditing || R().kind !== '2d') return;
      const o = App.p.board.outline;
      if (o.type !== 'polygon') return;
      const sp = local(e);
      const pts = o.points.map(([x, y]) => R().boardToScreen(x, y));
      const vi = pts.findIndex((q) => Math.hypot(q.x - sp.x, q.y - sp.y) < 10);
      if (vi >= 0) {
        if (pts.length <= 3) { App.toast(LP.t('ui.toast_min_vertices'), 'warn'); return; }
        App.setBoard({ outline: { type: 'polygon', shape: 'custom', points: o.points.filter((_, i) => i !== vi) } });
        return;
      }
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (G.pointSegDist(sp, a, b) < 8) {
          const bp = R().screenToBoard(sp.x, sp.y);
          const np = o.points.map((q) => [...q]);
          np.splice(i + 1, 0, [Math.round(bp.x * 2) / 2, Math.round(bp.y * 2) / 2]);
          App.setBoard({ outline: { type: 'polygon', shape: 'custom', points: np } });
          return;
        }
      }
    });
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const sp = local(e);
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) R().zoomAt(sp.x, sp.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      else R().pan(-e.deltaX, 0);
    }, { passive: false });
    stage.addEventListener('pointerleave', () => App.emit('hover', null));

    // ---------- 托盘拖出 ----------
    function trayDrag(ref, e) {
      const part = M.partByRef(App.p, ref);
      if (!part || part.placed) return;
      let started = false;
      const sx = e.clientX, sy = e.clientY;
      const move = (ev) => {
        if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < CLICK_PX) return;
        const sp = local(ev);
        if (!started) { started = startDrag('part', ref, sp, true); if (!started) return; LP.ui.setTrayDragging(ref, true); }
        if (overStage(ev)) moveDrag(sp, ev.altKey);
        else { App.drag.visible = false; App.drag.moved = false; App.emit('dragmove', { offStage: true }); App.redraw(); }
      };
      const done = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', done);
        window.removeEventListener('pointercancel', done);
        if (!started) { if (ev.type === 'pointerup') startCarry(ref, local(ev), true); return; }
        LP.ui.setTrayDragging(ref, false);
        endDrag(ev.type === 'pointerup' && overStage(ev) && App.drag && App.drag.moved);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', done);
      window.addEventListener('pointercancel', done);
    }

    // ---------- 键盘 ----------
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
      if (e.target && e.target.closest && e.target.closest('dialog[open]')) { if (e.key === 'Escape') return; }
      const mod = e.ctrlKey || e.metaKey;
      const sel = App.sel;
      const k = e.key;
      if (k === ' ') { spaceDown = true; if (e.target === document.body) e.preventDefault(); return; }
      if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) App.redo(); else App.undo(); return; }
      if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); App.redo(); return; }
      if (mod) return;
      if (k === 'Escape') { if (App.drag) cancelDrag(); else { App.focusIssue = null; App.select(null); } return; }
      if (k === 't' || k === 'T') { LP.ui.setView(App.view === '2d' ? '3d' : '2d'); return; }
      if (k === 'b' || k === 'B') { LP.ui.flipBoard(); return; }
      if (App.drag && (k === 'r' || k === 'R')) { rotateDrag(); return; }
      if (!sel) return;
      if (sel.type === 'part') {
        if (k === 'r' || k === 'R') { App.rotatePart(sel.ref); return; }
        if (k === 'f' || k === 'F') { App.flipPart(sel.ref); return; }
        if (k === 'l' || k === 'L') { App.toggleLock(sel.ref); return; }
        if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); App.unplace(sel.ref); return; }
        if (k === 'Enter' && App.suggestion) { App.acceptSuggestion(); return; }
        const step = e.shiftKey ? GRID * 10 : GRID;
        const dirs = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (dirs[k]) {
          e.preventDefault();
          const [dx, dy] = dirs[k];
          App.nudge(sel.ref, App.flipped ? -dx : dx, dy);
        }
      } else if (sel.type === 'sat' && (k === 'Delete' || k === 'Backspace')) { e.preventDefault(); App.unpinSat(sel.ref); }
    });
    window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });

    return { trayDrag, startCarry, cancelDrag };
  }

  LP.interaction = { init, GRID };
})(globalThis.LP = globalThis.LP || {});
