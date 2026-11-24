/*
 * satellites.js — 卫星器件（去耦、晶体、匹配、DCDC 外围、串阻、ESD、储能、上下拉）的自动贴放。
 * 每次主器件放下、旋转或换面后重算；拖动过程中不重算。用户手动拖过的卫星（pinned）不再移动。
 */
(function (LP) {
  'use strict';
  const G = LP.geometry, M = LP.model;

  const CONFIG = {
    gap: 0.2,            // 卫星与其他器件的最小间距（mm）
    edgeClear: 0.2,      // 卫星距板边
    step: 0.25,          // 沿边滑动步长
    rings: 3,
    w: { dist: 1.0, tang: 0.3, block: 0.6, avoid: 0.5, ring: 0.05, nearParent: 0.3 },
    blockStripDepth: 1.2,
  };

  function satsOf(p, ref) { return p.satellites.filter((s) => s.parent[0] === ref); }
  const unit = (v) => { const L = Math.hypot(v.x, v.y); return L > 1e-9 ? { x: v.x / L, y: v.y / L } : { x: 0, y: 0 }; };
  const sideOfNormal = (n) => (Math.abs(n.x) > Math.abs(n.y) ? (n.x > 0 ? 'E' : 'W') : (n.y > 0 ? 'N' : 'S'));
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

  function buildObstacles(p) {
    const obs = [];
    for (const pt of p.parts) if (pt.placed) obs.push({ rect: M.footprint(pt), side: pt.through ? 'both' : pt.placed.side, ref: pt.ref, kind: 'part', gap: true });
    for (const h of p.board.holes || []) obs.push({ rect: G.expand(LP.rules.holeRect(h), 0.3), side: 'both', ref: 'hole', kind: 'hole' });
    (p.board.keepouts || []).forEach((k) => obs.push({ rect: { x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h }, side: 'both', ref: 'keepout', kind: 'zone' }));
    const kr = LP.rules.effectiveRules(p).find((r) => r.id === 'antenna_keepout');
    if (kr) for (const pt of p.parts) if (pt.placed && pt.role === 'antenna') obs.push({ rect: LP.rules.antennaKeepout(pt, kr.clearance), side: 'both', ref: pt.ref, kind: 'zone', antenna: true });
    return obs;
  }
  /** 板框内一块保证安全的矩形（圆角矩形去掉圆角），落在其中的候选不必再做多边形判断。 */
  function safeRect(o) {
    if (o.type !== 'rect') return null;
    const r = Math.min(o.corner_r || 0, o.w / 2, o.h / 2);
    return [{ x0: r, y0: 0, x1: o.w - r, y1: o.h }, { x0: 0, y0: r, x1: o.w, y1: o.h - r }];
  }
  function feasible(p, rect, side, obs, opts) {
    const er = G.expand(rect, CONFIG.edgeClear);
    const safe = p._safe !== undefined ? p._safe : (p._safe = safeRect(p.board.outline));
    if (!(safe && safe.some((s) => G.containsRect(s, er))) && !G.rectInBoard(p.board.outline, er)) return false;
    for (const o of obs) {
      if (o.side !== 'both' && o.side !== side) continue;
      if (o.antenna && opts && opts.allowAntennaZone) continue;
      if (G.overlaps(rect, o.rect, o.gap ? CONFIG.gap : 0)) return false;
    }
    return true;
  }

  /** 父器件其他引脚组前方的出线通道，卫星占用时计入堵塞代价。 */
  function escapeStrips(part, exceptPin) {
    const out = [];
    for (const q of part.pins) {
      if (q.id === exceptPin || q.side === 'C') continue;
      const w = M.pinWorld(part, q.id);
      const span = Math.max(0.6, q.count * 0.3 + 0.4), d = CONFIG.blockStripDepth;
      const tx = -w.ny, ty = w.nx;
      const c = { x: w.x + w.nx * d / 2, y: w.y + w.ny * d / 2 };
      const hw = Math.abs(tx) * span / 2 + Math.abs(w.nx) * d / 2, hh = Math.abs(ty) * span / 2 + Math.abs(w.ny) * d / 2;
      out.push({ x0: c.x - hw, y0: c.y - hh, x1: c.x + hw, y1: c.y + hh });
    }
    return out;
  }
  /** 需要远离的实体（如电感远离天线），每个卫星只计算一次。 */
  function avoidList(p, K, selfRef) {
    if (!K.avoid) return [];
    return LP.rules.entities(p).filter((e) => e.ref !== selfRef && e.kind !== 'hole' && K.avoid.tags.some((t) => e.tags.has(t)));
  }
  function avoidPenalty(rect, list, r) {
    let pen = 0;
    for (const e of list) {
      const d = G.rectDist(rect, e.rect);
      if (d < r) pen += (r - d);
    }
    return pen;
  }

  /** 生成候选位：围绕锚定矩形的某条边（或四条边），多圈、沿边滑动、两种朝向。 */
  function candidates(anchorRect, edges, sat, sides) {
    const out = [];
    const rots = Math.abs(sat.w - sat.h) < 1e-6 ? [0] : [0, 90];
    const maxDim = Math.max(sat.w, sat.h);
    for (const ed of edges) {
      const n = ed.n, t = { x: -n.y, y: n.x };
      const edgeLen = Math.abs(n.x) > 0.5 ? G.height(anchorRect) : G.width(anchorRect);
      const range = Math.min(6, edgeLen / 2 + 3);
      for (const rot of rots) {
        const [w, h] = M.dims(sat.w, sat.h, rot);
        const depth = Math.abs(n.x) > 0.5 ? w : h;
        for (let k = 1; k <= CONFIG.rings; k++) {
          const off = CONFIG.gap + (k - 1) * (maxDim + CONFIG.gap) + depth / 2;
          for (let s = 0; s <= range + 1e-9; s += CONFIG.step) {
            for (const sg of s === 0 ? [1] : [1, -1]) {
              const tt = s * sg;
              const cx = ed.p.x + n.x * off + t.x * tt, cy = ed.p.y + n.y * off + t.y * tt;
              out.push({ x: cx, y: cy, rot, w, h, ring: k, tang: s, side: sides.front, back: false });
            }
          }
        }
        if (sides.back) {
          // 背面：放在锚点正下方，略向父器件内侧
          for (let s = 0; s <= 1.5 + 1e-9; s += CONFIG.step) for (const sg of s === 0 ? [1] : [1, -1]) {
            const off = depth / 2 + 0.1;
            out.push({ x: ed.p.x - n.x * off + t.x * s * sg, y: ed.p.y - n.y * off + t.y * s * sg, rot, w, h, ring: 1, tang: s, side: sides.back, back: true });
          }
        }
      }
    }
    return out;
  }

  function edgePointsOfRect(r) {
    const c = G.center(r);
    return [
      { p: { x: c.x, y: r.y1 }, n: { x: 0, y: 1 } }, { p: { x: c.x, y: r.y0 }, n: { x: 0, y: -1 } },
      { p: { x: r.x1, y: c.y }, n: { x: 1, y: 0 } }, { p: { x: r.x0, y: c.y }, n: { x: -1, y: 0 } },
    ];
  }

  // Imported electrical parts retain their own pads, nets and editable poses. Only a
  // committed move of their owner changes them; evaluating or opening a file never does.
  function seedOffset(child, previous) {
    // Translate the live group, including restored user edits. A first placement
    // or a tray round-trip uses the imported footprint's relative seed instead.
    if (!previous || !child.placed) return child.placementOffset || null;
    const dx = child.placed.x - previous.x, dy = child.placed.y - previous.y;
    const xAxis = M.dirToWorld(1, 0, previous), yAxis = M.dirToWorld(0, 1, previous);
    return { x: dx*xAxis.x + dy*xAxis.y, y: dx*yAxis.x + dy*yAxis.y,
      rot: (child.placed.rot - previous.rot) * (previous.side === 'bottom' ? -1 : 1),
      side: child.placed.side === previous.side ? 'same' : 'opposite' };
  }

  function placementPin(core, child, hint) {
    const pin = child.placementParent?.[1];
    const copper = pin && core.physicalPads?.find(pad => pad.n === pin);
    if (copper?.xy?.length) {
      const closest = copper.xy.map(([x,y]) => M.toWorld(x,y,core.placed))
        .sort((a,b) => distance(a,hint) - distance(b,hint))[0];
      return {...closest, net:copper.net};
    }
    return (pin && M.pinWorld(core,pin)) || hint;
  }
  function distance(a, b) { return Math.hypot(a.x-b.x, a.y-b.y); }

  function findImportedSlot(p, core, child, offset, obstacles, occupied, search) {
    const pose = core.placed;
    const requestedSide = offset?.side === 'opposite' ? (pose.side === 'top' ? 'bottom' : 'top') : pose.side;
    const allowed = child.sides.filter(side => side === 'top' || p.board.two_sided);
    const side = allowed.includes(requestedSide) ? requestedSide : allowed[0];
    if (!side) return null;
    const rot = ((pose.rot + (offset?.rot || 0) * (pose.side === 'bottom' ? -1 : 1)) % 360 + 360) % 360;
    const hint = offset ? M.toWorld(offset.x, offset.y, pose) : pose;
    const pin = placementPin(core, child, hint);
    const matchingPads = (child.physicalPads || []).find(pad => pin.net && pad.net === pin.net)?.xy || [];
    const target = offset ? hint : pin;
    const accepts = pl => {
      const rect = M.footprint(child,pl);
      return feasible(p,rect,side,obstacles) &&
        (!child.through || feasible(p,rect,side === 'top' ? 'bottom' : 'top',obstacles)) &&
        !LP.placementLimits?.violation(p,child,pl,rect,occupied);
    };
    const seed = {x:target.x, y:target.y, rot, side};
    if (accepts(seed)) return seed;
    if (!search) return null;

    // Expand around the intended footprint. Test alternate angles at each location.
    // Search the vicinity of this core, so an unrelated vacant corner cannot silently
    // become the location of a decoupler or termination.
    const step = 0.5, rings = Math.ceil(Math.max(6,core.w,core.h,child.w,child.h) / step);
    for (let ring = 0; ring <= rings; ring++) {
      let best = null, bestCost = Infinity;
      const trySite = (origin,dx,dy) => {
        const x = origin.x + dx*step, y = origin.y + dy*step;
        for (const delta of [0,90,180,270]) {
          const pl = { x, y, rot:(rot+delta)%360, side };
          const toPin = matchingPads.length
            ? Math.min(...matchingPads.map(([px,py])=>distance(M.toWorld(px,py,pl),pin)))
            : distance(pl,pin);
          const cost = distance(pl,target) + toPin + (delta ? 0.01 : 0);
          if (cost < bestCost && accepts(pl)) { best = pl; bestCost = cost; }
        }
      };
      const origins = distance(pin,target) > step ? [target,pin] : [target];
      for (const origin of origins) for (let i = -ring; i <= ring; i++) {
        trySite(origin,i,ring);
        if (ring) trySite(origin,i,-ring);
        if (Math.abs(i) < ring) { trySite(origin,ring,i); trySite(origin,-ring,i); }
      }
      if (best) return best;
    }
    return null;
  }

  function placeImported(p, core, previous) {
    const movable = M.placementChildren(p,core.ref).filter(x=>!x.locked);
    if (!movable.length) return [];
    if (!core.placed) { for (const child of movable) child.placed = null; return []; }
    p._safe = safeRect(p.board.outline);
    const moving = new Set(movable.map(x=>x.ref));
    const obstacles = buildObstacles(p).filter(o=>!moving.has(o.ref));
    for (const sat of p.satellites) if (sat.placed && (sat.pinned || sat.parent[0] !== core.ref))
      obstacles.push({rect:M.satFootprint(sat),side:sat.placed.side,ref:sat.ref,gap:true});
    const occupied = obstacles.filter(o=>o.gap).map(o=>({item:M.itemByRef(p,o.ref),rect:o.rect,side:o.side}));
    const group = movable.map(child=>({child,offset:seedOffset(child,previous),old:child.placed}));
    const fixedObstacles = obstacles.length, fixedOccupied = occupied.length;
    const reserve = child => {
      const rect = M.footprint(child), side = child.through?'both':child.placed.side;
      obstacles.push({rect,side,ref:child.ref,gap:true});
      occupied.push({item:child,rect,side});
    };
    const seat = ({child,offset},search) => {
      child.placed = findImportedSlot(p,core,child,offset,obstacles,occupied,search);
      if (child.placed) reserve(child);
      return !!child.placed;
    };
    const solve = entries => {
      // Reserve every usable design seed before a displaced sibling can consume it.
      const displaced = entries.filter(s=>!seat(s,false));
      displaced.sort((a,b)=>b.child.w*b.child.h-a.child.w*a.child.h);
      return displaced.filter(s=>!seat(s,true));
    };
    const pending = solve(group);
    const localRange = Math.max(core.w,core.h,...movable.map(s=>Math.max(s.w,s.h))) * 1.5;
    if (!pending.length || !previous || previous.side !== core.placed.side ||
        distance(previous,core.placed) > localRange) return pending.map(s=>s.child.ref);

    // A small owner move can displace a tightly packed power component. If the first
    // arrangement failed, preserve the group's still-legal sites, then improve them.
    const first = group.map(s=>s.child.placed);
    obstacles.length = fixedObstacles; occupied.length = fixedOccupied;
    const reserved = new Set();
    for (const entry of group) {
      const {child,old} = entry;
      if (!old) continue;
      const savedOffset = seedOffset({...child,placed:old},core.placed);
      if (seat({child,offset:savedOffset},false)) reserved.add(child.ref);
    }
    if (reserved.size) {
      const retry = solve(group.filter(entry=>!reserved.has(entry.child.ref)));
      if (retry.length < pending.length) {
        for (const entry of group.filter(s=>reserved.has(s.child.ref))) {
          const child = entry.child, old = child.placed;
          obstacles.splice(obstacles.findIndex(o=>o.ref===child.ref),1);
          occupied.splice(occupied.findIndex(o=>o.item===child),1);
          if (!seat(entry,false)) { child.placed=old; reserve(child); }
        }
        return retry.map(s=>s.child.ref);
      }
    }
    group.forEach((s,i)=>{ s.child.placed=first[i]; });
    return pending.map(s=>s.child.ref);
  }

  /** 卫星的锚点：父引脚组位置与朝外法向；BGA 中心出线的器件改为四边。 */
  function anchorOf(p, sat) {
    const part = M.partByRef(p, sat.parent[0]);
    const w = M.pinWorld(part, sat.parent[1]);
    const fp = M.footprint(part);
    if (!w) return null;
    if (Math.abs(w.nx) + Math.abs(w.ny) < 0.5) return { part, pin: w, rect: fp, edges: edgePointsOfRect(fp), P: { x: w.x, y: w.y } };
    return { part, pin: w, rect: fp, edges: [{ p: { x: w.x, y: w.y }, n: { x: w.nx, y: w.ny } }], P: { x: w.x, y: w.y } };
  }

  function chooseBest(p, sat, cands, obs, measure, extraCost, opts) {
    let best = null, bestAny = null;
    const limit = sat.max_dist;
    const K = M.SAT_KINDS[sat.kind];
    // 按代价下界排序；下界已超过当前最优时提前结束
    for (const c of cands) c.lb = CONFIG.w.tang * c.tang + CONFIG.w.ring * c.ring + (c.back ? K.back : 0);
    cands.sort((a, b) => a.lb - b.lb);
    for (const c of cands) {
      if (best && c.lb > best.cost) break;
      const rect = G.rectFromCenter(c.x, c.y, c.w, c.h);
      if (!feasible(p, rect, c.side, obs, opts)) continue;
      const d = measure(rect);
      const cost = CONFIG.w.dist * d + CONFIG.w.tang * c.tang + CONFIG.w.ring * c.ring + (extraCost ? extraCost(rect, c) : 0);
      const o = { ...c, rect, dist: d, cost };
      if (d <= limit + 1e-6 && (!best || cost < best.cost)) best = o;
      if (!bestAny || d < bestAny.dist - 1e-9 || (Math.abs(d - bestAny.dist) < 1e-9 && cost < bestAny.cost)) bestAny = o;
    }
    return { best, bestAny };
  }

  /** 找出挡在锚点前方的器件，并估算需要移开的距离。 */
  function findBlocker(p, sat, A, obs, parentSide) {
    const ed = A.edges[0], n = ed.n, t = { x: -n.y, y: n.x };
    const limit = sat.max_dist, d = Math.max(sat.w, sat.h);
    const depth = limit + d;
    const c = { x: ed.p.x + n.x * depth / 2, y: ed.p.y + n.y * depth / 2 };
    const hw = Math.abs(t.x) * limit + Math.abs(n.x) * depth / 2, hh = Math.abs(t.y) * limit + Math.abs(n.y) * depth / 2;
    const strip = { x0: c.x - hw, y0: c.y - hh, x1: c.x + hw, y1: c.y + hh };
    let top = null, area = 0;
    for (const o of obs) {
      if (o.ref === A.part.ref || o.kind === 'hole') continue;
      if (o.side !== 'both' && o.side !== parentSide) continue;
      const a = G.overlapArea(strip, o.rect);
      if (a > area) { area = a; top = o; }
    }
    if (!top) return null;
    // 锚点所在边到挡路器件近边的距离
    const gapNow = n.x > 0.5 ? top.rect.x0 - ed.p.x : n.x < -0.5 ? ed.p.x - top.rect.x1 : n.y > 0.5 ? top.rect.y0 - ed.p.y : ed.p.y - top.rect.y1;
    const needed = CONFIG.gap + Math.min(sat.w, sat.h) + CONFIG.gap;
    const move = Math.max(0.5, Math.ceil((needed - Math.max(0, gapNow)) * 2) / 2);
    return { ref: top.ref, kind: top.kind, move, sibling: top.kind === 'sat' };
  }

  function rfChain(p, sat) {
    const net = p.nets.find((n) => n.class === 'rf' && n.pins.some((q) => q[0] === sat.parent[0] && q[1] === sat.parent[1]));
    if (!net) return null;
    const other = net.pins.find((q) => !(q[0] === sat.parent[0] && q[1] === sat.parent[1]));
    if (!other) return null;
    return { ref: other[0], pin: other[1] };
  }

  /** 射频匹配：沿"射频引脚 → 天线馈点"的连线排成一串，靠天线一端。 */
  function placeRfChain(p, chain, obs, results) {
    const first = chain[0];
    const A0 = anchorOf(p, first);
    const end = rfChain(p, first);
    const ant = end && M.partByRef(p, end.ref);
    if (!ant || !ant.placed) {
      for (const s of chain) results[s.ref] = { considered: true, placed: false, ok: false, reason: 'antenna_unplaced', parentRef: first.parent[0], pin: first.parent[1], limit: s.max_dist, dist: Infinity };
      return;
    }
    const Pw = A0.P, Aw0 = M.pinWorld(ant, end.pin);
    const Aw = { x: Aw0.x, y: Aw0.y };
    const u = unit({ x: Aw.x - Pw.x, y: Aw.y - Pw.y });
    const horiz = Math.abs(u.x) >= Math.abs(u.y);
    const perp = { x: -u.y, y: u.x };
    let cursor = 0.3; // 距馈点的距离
    for (let i = chain.length - 1; i >= 0; i--) {
      const s = chain[i];
      const rot = horiz ? (s.w >= s.h ? 0 : 90) : (s.w >= s.h ? 90 : 0);
      const [w, h] = M.dims(s.w, s.h, rot);
      const ext = horiz ? w : h;
      let placed = null;
      outer:
      for (const along of [0, 0.3, 0.6, 1.0]) for (const off of [0, 0.3, -0.3, 0.6, -0.6, 1.0, -1.0]) {
        const dd = cursor + ext / 2 + along;
        const c = { x: Aw.x - u.x * dd + perp.x * off, y: Aw.y - u.y * dd + perp.y * off };
        const rect = G.rectFromCenter(c.x, c.y, w, h);
        if (feasible(p, rect, A0.part.placed.side, obs, { allowAntennaZone: true })) { placed = { c, rect, along }; break outer; }
      }
      if (placed) {
        s.placed = { x: placed.c.x, y: placed.c.y, rot, side: A0.part.placed.side };
        s._active = true;
        obs.push({ rect: placed.rect, side: s.placed.side, ref: s.ref, kind: 'sat', gap: true, parent: s.parent[0] });
        cursor += ext + placed.along + 0.3;
        const d = G.pointSegDist(placed.c, Pw, Aw);
        const ok = d <= s.max_dist + 1e-6;
        results[s.ref] = { considered: true, placed: true, ok, dist: d, limit: s.max_dist, parentRef: s.parent[0], pin: s.parent[1],
          msg: ok ? '' : LP.t('sat.rf_offline', { a: s.ref, d: f1(d) }), fix: ok ? '' : LP.t('sat.rf_offline_fix', {}) };
      } else {
        placeGeneric(p, s, obs, results, { allowAntennaZone: true });
      }
    }
  }

  function placeGeneric(p, sat, obs, results, opts) {
    const K = M.SAT_KINDS[sat.kind];
    const A = anchorOf(p, sat);
    const parentSide = A.part.placed.side;
    const back = p.board.two_sided && Number.isFinite(K.back) ? (parentSide === 'top' ? 'bottom' : 'top') : null;
    const near = sat.near ? M.satByRef(p, sat.near) : null;
    const nearRect = near && near.placed && near._active ? M.satFootprint(near) : null;
    let cands, measure;
    if (nearRect) {
      cands = candidates(nearRect, edgePointsOfRect(nearRect), sat, { front: near.placed.side, back: null });
      measure = (r) => G.rectDist(r, nearRect);
    } else {
      cands = candidates(A.rect, A.edges, sat, { front: parentSide, back });
      measure = (r) => G.pointRectDist(A.P, r);
    }
    const strips = escapeStrips(A.part, sat.parent[1]);
    const avoid = avoidList(p, K, sat.ref);
    const extra = (rect, c) => {
      let cost = 0;
      if (c.back) cost += K.back;
      if (!c.back) for (const s of strips) cost += CONFIG.w.block * G.overlapArea(rect, s) / Math.max(G.area(rect), 1e-6);
      if (avoid.length) cost += CONFIG.w.avoid * avoidPenalty(rect, avoid, K.avoid.r);
      if (nearRect) cost += CONFIG.w.nearParent * G.pointRectDist(A.P, rect);
      return cost;
    };
    const { best, bestAny } = chooseBest(p, sat, cands, obs, measure, extra, opts);
    const pick = best || bestAny;
    const res = { considered: true, parentRef: sat.parent[0], pin: sat.parent[1], limit: sat.max_dist };
    if (!pick) {
      sat.placed = null; sat._active = false;
      results[sat.ref] = { ...res, placed: false, ok: false, dist: Infinity };
      return;
    }
    sat.placed = { x: pick.x, y: pick.y, rot: pick.rot, side: pick.side };
    sat._active = true;
    obs.push({ rect: pick.rect, side: pick.side, ref: sat.ref, kind: 'sat', gap: true, parent: sat.parent[0] });
    const ok = !!best;
    const r = { ...res, placed: true, ok, dist: pick.dist, backside: pick.back };
    if (!ok) {
      const side = LP.S.sideCN[sideOfNormal(A.edges[0].n)];
      const base = { a: sat.ref, parent: sat.parent[0], pin: sat.parent[1], d: f1(pick.dist), limit: sat.max_dist, side };
      if (nearRect) {
        r.msg = LP.t('sat.near_far', { a: sat.ref, near: sat.near, d: f1(pick.dist), limit: sat.max_dist });
        r.fix = LP.t('sat.near_far_fix', { near: sat.near });
      } else {
        const bl = findBlocker(p, sat, A, obs.filter((o) => o.ref !== sat.ref), parentSide);
        if (bl && !bl.sibling) {
          r.blocker = bl.ref;
          r.msg = LP.t('sat.far_blocked', { ...base, blocker: bl.ref });
          r.fix = LP.t('sat.far_blocked_fix', { blocker: bl.ref, move: bl.move.toFixed(1) });
        } else if (bl) {
          r.msg = LP.t('sat.far_crowded', base);
          r.fix = LP.t('sat.far_crowded_fix', base);
        } else {
          r.msg = LP.t('sat.far_plain', base);
          r.fix = LP.t('sat.far_plain_fix', base);
        }
      }
    }
    results[sat.ref] = r;
  }

  function measurePinned(p, s) {
    const A = anchorOf(p, s);
    const rect = M.satFootprint(s);
    let d;
    if (s.near) {
      const nr = M.satByRef(p, s.near);
      d = nr && nr.placed && nr._active ? G.rectDist(rect, M.satFootprint(nr)) : G.pointRectDist(A.P, rect);
    } else if (s.kind === 'rf_match') {
      const end = rfChain(p, s);
      const ant = end && M.partByRef(p, end.ref);
      d = ant && ant.placed ? G.pointSegDist(G.center(rect), A.P, M.pinWorld(ant, end.pin)) : G.pointRectDist(A.P, rect);
    } else d = G.pointRectDist(A.P, rect);
    const ok = d <= s.max_dist + 1e-6;
    const base = { a: s.ref, parent: s.parent[0], pin: s.parent[1], d: f1(d), limit: s.max_dist, side: LP.S.sideCN[sideOfNormal(A.edges[0].n)] };
    return { considered: true, placed: true, pinned: true, ok, dist: d, limit: s.max_dist, parentRef: s.parent[0], pin: s.parent[1],
      msg: ok ? '' : LP.t('sat.far_plain', base), fix: ok ? '' : LP.t('sat.far_plain_fix', base) };
  }

  /**
   * 重算所有未固定卫星的位置（就地写入 sat.placed），返回每个卫星的结果：
   * {considered, placed, ok, dist, limit, parentRef, pin, msg, fix, blocker}
   */
  function placeAll(p) {
    const results = {};
    p._safe = undefined;
    for (const s of p.satellites) {
      const parent = M.partByRef(p, s.parent[0]);
      const active = !!(parent && parent.placed);
      if (!s.pinned) s.placed = null;
      s._active = active && !!s.placed;
      if (!active) results[s.ref] = { considered: false, placed: false, ok: true, parentRef: s.parent[0], pin: s.parent[1] };
    }
    const obs = buildObstacles(p);
    for (const s of p.satellites) if (s._active && s.pinned) obs.push({ rect: M.satFootprint(s), side: s.placed.side, ref: s.ref, kind: 'sat', gap: true, parent: s.parent[0] });

    const order = p.satellites
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !s.pinned && M.partByRef(p, s.parent[0])?.placed)
      .sort((a, b) => {
        const ka = M.SAT_KINDS[a.s.kind], kb = M.SAT_KINDS[b.s.kind];
        if (ka.prio !== kb.prio) return ka.prio - kb.prio;
        if (a.s.kind === 'decoupling' && b.s.kind === 'decoupling') {
          const d = M.parseCap(a.s.value) - M.parseCap(b.s.value);
          if (d !== 0 && Number.isFinite(d)) return d;
        }
        return a.i - b.i;
      })
      .map((x) => x.s);

    const doneChains = new Set();
    for (const s of order) {
      if (results[s.ref]) continue;
      if (s.kind === 'rf_match') {
        const key = s.parent.join('.');
        if (doneChains.has(key)) continue;
        doneChains.add(key);
        const chain = p.satellites.filter((x) => x.kind === 'rf_match' && !x.pinned && x.parent.join('.') === key);
        placeRfChain(p, chain, obs, results);
        continue;
      }
      placeGeneric(p, s, obs, results);
    }
    for (const s of p.satellites) if (s.pinned && s._active) results[s.ref] = measurePinned(p, s);
    return results;
  }

  /** 外晕：主器件与其卫星所占区域的外包矩形。 */
  function halos(p) {
    const out = [];
    for (const pt of p.parts) {
      if (!pt.placed) continue;
      let r = M.footprint(pt);
      let n = 0;
      for (const s of satsOf(p, pt.ref)) if (s.placed && s._active) { r = G.union(r, M.satFootprint(s)); n++; }
      if (n) out.push({ ref: pt.ref, rect: G.expand(r, 0.3) });
    }
    return out;
  }

  LP.satellites = { CONFIG, satsOf, placeAll, placeImported, halos, anchorOf, candidates };
})(globalThis.LP = globalThis.LP || {});
