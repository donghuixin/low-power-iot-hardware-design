/*
 * rules.js — 规则引擎。规则是数据：类型、参数、级别、核对清单编号；文案在 strings.js。
 * 默认参数是典型值，器件手册给出具体数值时在项目 JSON 的 rules 中覆盖。
 */
(function (LP) {
  'use strict';
  const G = LP.geometry, M = LP.model;

  /** select / a / b：{roles:[…], tags:[…]}，命中任一即选中。 */
  const DEFAULT_RULES = [
    { id: 'overlap', type: 'overlap', severity: 'P0', check: 'DFM-06' },
    { id: 'inside_board', type: 'inside_board', severity: 'P0', check: 'DFM-06' },
    { id: 'edge_min_all', type: 'edge_min', select: { tags: ['part'] }, exceptEdge: true, min: 0.5, severity: 'P1', check: 'DFM-06' },
    { id: 'antenna_edge', type: 'edge_required', select: { roles: ['antenna', 'rf_module'] }, tol: 0.5, severity: 'P1', check: 'RF-01' },
    { id: 'connector_edge', type: 'edge_required', select: { roles: ['connector', 'button'] }, onlyEdgeFlag: true, tol: 0.5, severity: 'P0', check: 'ASM-02' },
    { id: 'temp_edge', type: 'edge_required', select: { roles: ['temp_humidity'] }, tol: 3, severity: 'P3', check: 'SEN-02' },
    { id: 'antenna_keepout', type: 'keepout_zone', select: { roles: ['antenna'] }, clearance: 3, severity: 'P1', check: 'RF-01' },
    { id: 'antenna_metal', type: 'min_distance', a: { roles: ['antenna', 'rf_module'] }, b: { roles: ['battery', 'connector'], tags: ['shield'] }, min: 5, severity: 'P1', check: 'RF-03' },
    { id: 'rf_feed_len', type: 'max_net_length', classes: ['rf'], def: 10, severity: 'P2', check: 'RF-04' },
    { id: 'imu_edge', type: 'edge_min', select: { roles: ['imu'] }, min: 3, severity: 'P2', check: 'SEN-01' },
    { id: 'imu_stress', type: 'min_distance', a: { roles: ['imu'] }, b: { tags: ['hole'], roles: ['connector', 'button'] }, min: 5, severity: 'P2', check: 'SEN-01' },
    { id: 'imu_heat', type: 'min_distance', a: { roles: ['imu'] }, b: { tags: ['heat'] }, min: 5, severity: 'P2', check: 'SEN-01' },
    { id: 'temp_heat', type: 'min_distance', a: { roles: ['temp_humidity'] }, b: { tags: ['heat'] }, min: 8, severity: 'P2', check: 'SEN-02' },
    { id: 'xtal_heat', type: 'min_distance', a: { tags: ['crystal'] }, b: { tags: ['heat'] }, min: 4, severity: 'P2', check: 'SI-04' },
    { id: 'mag_sources', type: 'min_distance', a: { roles: ['magnetometer'] }, b: { tags: ['magnetic_source'] }, min: 10, severity: 'P1', check: 'SEN-03' },
    { id: 'inductor_antenna', type: 'min_distance', a: { tags: ['inductor'] }, b: { roles: ['antenna', 'rf_module'] }, min: 8, severity: 'P1', check: 'PI-03' },
    { id: 'inductor_sensitive', type: 'min_distance', a: { tags: ['inductor'] }, b: { tags: ['crystal'], roles: ['microphone', 'optical', 'barometer', 'temp_humidity', 'imu'] }, min: 4, severity: 'P2', check: 'PI-03' },
    { id: 'xtal_noise', type: 'min_distance', a: { tags: ['crystal'] }, b: { roles: ['antenna', 'dcdc'] }, min: 4, severity: 'P2', check: 'SI-04' },
    { id: 'heat_battery', type: 'min_distance', a: { tags: ['heat'] }, b: { roles: ['battery'] }, min: 5, severity: 'P2', check: 'THM-01' },
    { id: 'satellite_distance', type: 'satellite_distance' },
    { id: 'power_flow', type: 'flow_order', severity: 'P3', check: 'LAY-03' },
  ];

  /** 合并默认规则与项目覆盖：{id, disabled:true} 关闭；{id, ...} 覆盖参数；{type, ...} 新增。 */
  function effectiveRules(p) {
    const list = DEFAULT_RULES.map((r) => ({ ...r }));
    for (const o of p.rules || []) {
      if (o.id) {
        const i = list.findIndex((r) => r.id === o.id);
        if (i >= 0) {
          if (o.disabled) list.splice(i, 1);
          else list[i] = { ...list[i], ...o, ...(o.params || {}) };
          continue;
        }
      }
      if (o.type) list.push({ severity: 'P2', check: '', ...o, ...(o.params || {}), id: o.id || `custom_${list.length}` });
    }
    return list;
  }

  // ---------- 实体 ----------
  function holeRect(h) { return G.rectFromCenter(h.x, h.y, h.d, h.d); }
  /** 已摆放的器件、卫星和固定孔，统一为 {ref, kind, role, tags, rect, side, label}。 */
  function entities(p) {
    const out = [];
    for (const pt of p.parts) {
      if (!pt.placed) continue;
      out.push({ ref: pt.ref, kind: 'part', role: pt.role, tags: M.partTags(pt), rect: M.footprint(pt), side: pt.through ? 'both' : pt.placed.side, item: pt });
    }
    for (const s of p.satellites) {
      if (!s.placed || !s._active) continue;
      out.push({ ref: s.ref, kind: 'sat', role: s.kind, tags: M.satTags(s), rect: M.satFootprint(s), side: s.placed.side, item: s, parent: s.parent[0] });
    }
    (p.board.holes || []).forEach((h, i) => out.push({ ref: `孔${i + 1}`, kind: 'hole', role: 'hole', tags: new Set(['hole']), rect: holeRect(h), side: 'both' }));
    return out;
  }
  function matches(e, sel) {
    if (!sel) return false;
    if (sel.roles && sel.roles.includes(e.role)) return true;
    if (sel.tags && sel.tags.some((t) => e.tags.has(t))) return true;
    return false;
  }

  // ---------- 区域 ----------
  /** 天线净空区（世界坐标矩形）。默认馈点一侧为 0，其余三侧为 clearance；器件可用 keepout:{N,E,S,W}（局部方向）覆盖。 */
  function antennaKeepout(pt, clearance) {
    const fp = M.footprint(pt);
    let local = pt.keepout;
    if (!local) {
      const c = clearance ?? 3;
      local = { N: c, E: c, S: c, W: c };
      const feed = pt.pins.find((q) => /feed/i.test(q.id)) || pt.pins[0];
      if (feed && feed.side !== 'C') local[feed.side] = 0;
    }
    const world = { N: 0, E: 0, S: 0, W: 0 };
    for (const s of ['N', 'E', 'S', 'W']) world[M.worldSide(s, pt.placed)] = local[s] || 0;
    return G.expandSides(fp, world);
  }
  /** 用于显示和计算的区域列表。related：哪些角色被拖动时需要显示该区域。 */
  function zones(p) {
    const out = [];
    const rules = effectiveRules(p);
    const kr = rules.find((r) => r.id === 'antenna_keepout');
    for (const pt of p.parts) {
      if (!pt.placed) continue;
      if (pt.role === 'antenna' && kr) out.push({ type: 'antenna_keepout', ref: pt.ref, rect: antennaKeepout(pt, kr.clearance), blocksRouting: true, related: 'all' });
      const tags = M.partTags(pt);
      const fp = M.footprint(pt), c = G.center(fp), half = Math.max(G.width(fp), G.height(fp)) / 2;
      if (tags.has('heat')) out.push({ type: 'heat', ref: pt.ref, cx: c.x, cy: c.y, r: half + 8, related: ['imu', 'temp_humidity', 'crystal', 'battery', 'soc_rf', 'mcu'] });
      if (tags.has('inductor')) out.push({ type: 'magnetic', ref: pt.ref, cx: c.x, cy: c.y, r: half + 8, related: ['antenna', 'rf_module', 'magnetometer', 'imu', 'microphone', 'optical', 'barometer', 'temp_humidity'] });
    }
    for (const s of p.satellites) {
      if (!s.placed || !s._active || s.kind !== 'dcdc_inductor') continue;
      const fp = M.satFootprint(s), c = G.center(fp);
      out.push({ type: 'magnetic', ref: s.ref, cx: c.x, cy: c.y, r: Math.max(G.width(fp), G.height(fp)) / 2 + 8, related: ['antenna', 'rf_module', 'magnetometer', 'soc_rf', 'mcu'] });
    }
    (p.board.keepouts || []).forEach((k, i) => out.push({ type: 'keepout', ref: `禁布区${i + 1}`, reason: k.reason || '禁布区', rect: { x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h }, blocksRouting: true, related: 'all' }));
    out.push({ type: 'edge_band', width: 3, related: ['imu'] });
    return out;
  }

  // ---------- 合法性（拖动时用） ----------
  /** 硬约束：在板内、不入禁布区、不压固定孔、不与同面器件重叠。 */
  function quickLegal(p, part, pl) {
    const r = M.footprint(part, pl);
    const o = p.board.outline;
    if (!G.rectInBoard(o, r)) return { ok: false, reason: 'outside' };
    for (const k of p.board.keepouts || []) if (G.overlaps(r, { x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h })) return { ok: false, reason: 'keepout', with: k.reason || '禁布区' };
    for (const h of p.board.holes || []) if (G.overlaps(r, G.expand(holeRect(h), 0.3))) return { ok: false, reason: 'hole' };
    const side = part.through ? 'both' : pl.side;
    for (const q of p.parts) {
      if (q === part || !q.placed) continue;
      const qs = q.through ? 'both' : q.placed.side;
      if (side !== 'both' && qs !== 'both' && qs !== side) continue;
      if (G.overlaps(r, M.footprint(q))) return { ok: false, reason: 'overlap', with: q.ref };
    }
    return { ok: true };
  }
  /** 拖动反馈：bad 不可放；warn 可放但会挤占卫星位置或进入天线净空区。 */
  function dragStatus(p, part, pl) {
    const q = quickLegal(p, part, pl);
    if (!q.ok) return { level: 'bad', ...q };
    const r = M.footprint(part, pl);
    for (const s of p.satellites) {
      if (!s.placed || !s._active || s.parent[0] === part.ref) continue;
      if (s.placed.side !== pl.side && !part.through) continue;
      if (G.overlaps(r, M.satFootprint(s))) return { level: 'warn', reason: 'halo', with: s.parent[0], kind: M.SAT_KINDS[s.kind].label };
    }
    for (const z of zones(p)) {
      if (z.type !== 'antenna_keepout' || z.ref === part.ref) continue;
      if (G.overlaps(r, z.rect)) return { level: 'warn', reason: 'antenna', with: z.ref };
    }
    return { level: 'ok' };
  }

  // ---------- 检查 ----------
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  function issue(rule, key, refs, params, extra) {
    return { id: `${rule.id}:${refs.join(',')}`, rule: rule.id, severity: rule.severity, check: rule.check, refs, msg: LP.t(`rule.${key}.msg`, params), fix: LP.t(`rule.${key}.fix`, params), ...(extra || {}) };
  }

  /** 运行全部规则，返回按级别排序的问题列表。satResults 来自 LP.satellites.placeAll。 */
  function check(p, satResults) {
    const rules = effectiveRules(p);
    const ents = entities(p);
    const parts = ents.filter((e) => e.kind === 'part');
    const o = p.board.outline;
    const issues = [];
    for (const rule of rules) {
      switch (rule.type) {
        case 'overlap': {
          const solid = ents.filter((e) => e.kind === 'part' || (e.kind === 'sat' && e.item.pinned));
          for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
            const a = solid[i], b = solid[j];
            if (a.side !== 'both' && b.side !== 'both' && a.side !== b.side) continue;
            if (a.kind === 'sat' && b.kind === 'sat') continue;
            if (G.overlaps(a.rect, b.rect)) issues.push(issue(rule, 'overlap', [a.ref, b.ref], { a: a.ref, b: b.ref }));
          }
          break;
        }
        case 'inside_board': {
          for (const e of parts) {
            if (!G.rectInBoard(o, e.rect)) { issues.push(issue(rule, 'outside_board', [e.ref], { a: e.ref })); continue; }
            for (const k of p.board.keepouts || []) if (G.overlaps(e.rect, { x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h })) issues.push(issue(rule, 'in_keepout', [e.ref], { a: e.ref, reason: k.reason || '禁布区' }));
            for (const h of p.board.holes || []) if (G.overlaps(e.rect, G.expand(holeRect(h), 0.3))) issues.push(issue(rule, 'on_hole', [e.ref], { a: e.ref }));
          }
          break;
        }
        case 'edge_min': {
          for (const e of parts) {
            if (!matches(e, rule.select)) continue;
            if (rule.exceptEdge && (e.item.edge || e.role === 'antenna' || e.role === 'rf_module')) continue;
            if (!G.rectInBoard(o, e.rect)) continue;
            const d = G.rectEdgeDistance(o, e.rect);
            if (d < rule.min - 1e-6) issues.push(issue(rule, rule.id === 'imu_edge' ? 'imu_edge' : 'edge_min_all', [e.ref], { a: e.ref, d: f1(d), min: rule.min, need: f1(rule.min - d) }, { zone: 'edge_band' }));
          }
          break;
        }
        case 'edge_required': {
          for (const e of parts) {
            if (!matches(e, rule.select)) continue;
            if (rule.onlyEdgeFlag && !e.item.edge) continue;
            if (!G.rectInBoard(o, e.rect)) continue;
            const d = G.rectEdgeDistance(o, e.rect);
            let ok = d <= rule.tol + 1e-6;
            if (ok && e.item.edge_face) ok = G.faceOutside(o, e.rect, M.worldSide(e.item.edge_face, e.item.placed), rule.tol + 0.3);
            if (!ok) issues.push(issue(rule, rule.id, [e.ref], { a: e.ref, d: f1(d), tol: rule.tol }));
          }
          break;
        }
        case 'keepout_zone': {
          for (const e of parts) {
            if (!matches(e, rule.select)) continue;
            const z = antennaKeepout(e.item, rule.clearance);
            for (const x of ents) {
              if (x.ref === e.ref || x.kind === 'hole') continue;
              if (x.kind === 'sat' && x.item.kind === 'rf_match') continue;
              if (G.overlapArea(x.rect, z) > 1e-4) issues.push(issue(rule, 'antenna_keepout', [e.ref, x.ref], { a: e.ref, b: x.ref }, { zone: 'antenna_keepout' }));
            }
          }
          break;
        }
        case 'min_distance': {
          const A = ents.filter((e) => matches(e, rule.a));
          const B = ents.filter((e) => matches(e, rule.b));
          const seen = new Set();
          for (const a of A) for (const b of B) {
            if (a.ref === b.ref) continue;
            if (a.parent && a.parent === b.ref) continue;
            if (b.parent && b.parent === a.ref) continue;
            const key = [a.ref, b.ref].sort().join('|');
            if (seen.has(key)) continue;
            const d = G.rectDist(a.rect, b.rect);
            if (d < rule.min - 1e-6) {
              seen.add(key);
              issues.push(issue(rule, rule.id, [a.ref, b.ref], { a: a.ref, b: b.ref, d: f1(d), min: rule.min, need: f1(rule.min - d) }));
            }
          }
          break;
        }
        case 'max_net_length': {
          const per = new Map();
          for (const e of LP.metrics.netEdges(p)) per.set(e.net, (per.get(e.net) || 0) + e.len);
          for (const net of p.nets) {
            const isClass = (rule.classes || []).includes(net.class);
            const limit = net.max_len || (isClass ? rule.def : null);
            if (!limit || !per.has(net.name)) continue;
            const len = per.get(net.name);
            if (len <= limit) continue;
            const rr = isClass ? rule : { ...rule, check: 'SI-01' };
            issues.push(issue(rr, isClass ? 'rf_feed_len' : 'net_len', net.pins.map((q) => q[0]), { net: net.name, len: f1(len), limit }));
          }
          break;
        }
        case 'satellite_distance': {
          for (const [ref, r] of Object.entries(satResults || {})) {
            if (!r.considered || r.ok) continue;
            const s = M.satByRef(p, ref);
            const K = M.SAT_KINDS[s.kind];
            const rr = { id: rule.id, severity: r.placed ? K.sev : 'P1', check: K.check };
            if (r.reason === 'antenna_unplaced') issues.push(issue({ ...rr, severity: 'P3' }, 'antenna_unplaced', [ref], { a: ref }));
            else if (!r.placed) issues.push(issue(rr, 'sat_unplaced', [ref, r.parentRef], { a: ref, kind: K.label, parent: r.parentRef }));
            else issues.push({ id: `${rule.id}:${ref}`, rule: rule.id, severity: rr.severity, check: rr.check, refs: [ref, r.parentRef].concat(r.blocker ? [r.blocker] : []), msg: r.msg, fix: r.fix });
          }
          break;
        }
        case 'flow_order': {
          const pick = (roles) => parts.find((e) => roles.includes(e.role));
          const chg = pick(['charger']), reg = pick(['dcdc', 'ldo']), main = pick(['soc_rf', 'mcu']);
          if (chg && reg && main) {
            const dc = G.rectDist(chg.rect, main.rect), dr = G.rectDist(reg.rect, main.rect);
            if (dr > dc + 1) issues.push(issue(rule, 'power_flow', [chg.ref, reg.ref, main.ref], { chg: chg.ref, reg: reg.ref, main: main.ref }));
          }
          break;
        }
        default: break;
      }
    }
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    issues.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check));
    return issues;
  }

  LP.rules = { DEFAULT_RULES, effectiveRules, entities, matches, antennaKeepout, zones, quickLegal, dragStatus, check, holeRect };
})(globalThis.LP = globalThis.LP || {});
