/*
 * model.js — 项目数据：常量表、校验、默认值、坐标变换、撤销快照、导出。
 * 数据格式见 references/12-layout-planner.md。不依赖 DOM。
 */
(function (LP) {
  'use strict';
  const G = LP.geometry;

  const TOOL_VERSION = '1.0.0';

  /** 主器件角色：label 界面名称；step 所属引导步骤；shape 默认造型；z 默认高度(mm)；edge 默认须贴板边。 */
  const ROLES = {
    soc_rf:        { label: '射频 SoC', step: 5, shape: 'qfn', z: 0.85 },
    mcu:           { label: '主控 MCU', step: 5, shape: 'qfn', z: 0.85 },
    rf_module:     { label: '射频模组', step: 3, shape: 'module', z: 2.2, edge: true },
    antenna:       { label: '天线', step: 3, shape: 'chip_antenna', z: 1.1, edge: true },
    imu:           { label: 'IMU', step: 4, shape: 'lga', z: 0.9 },
    magnetometer:  { label: '磁力计', step: 4, shape: 'lga', z: 0.8 },
    temp_humidity: { label: '温湿度', step: 4, shape: 'dfn', z: 0.8 },
    barometer:     { label: '气压计', step: 4, shape: 'lga', z: 0.9 },
    microphone:    { label: '麦克风', step: 4, shape: 'mic', z: 1.0 },
    optical:       { label: '光学传感器', step: 4, shape: 'optical', z: 1.2 },
    dcdc:          { label: 'DCDC', step: 6, shape: 'dfn', z: 0.8 },
    ldo:           { label: 'LDO', step: 6, shape: 'sot', z: 1.0 },
    charger:       { label: '充电芯片', step: 6, shape: 'dfn', z: 0.8 },
    inductor:      { label: '功率电感', step: 6, shape: 'inductor', z: 1.2 },
    battery:       { label: '电池', step: 2, shape: 'coin', z: 4.0 },
    connector:     { label: '连接器', step: 2, shape: 'usb_c', z: 3.2, edge: true },
    button:        { label: '按键', step: 2, shape: 'button', z: 1.5 },
    led:           { label: 'LED', step: 2, shape: 'led', z: 0.6 },
    flash:         { label: 'Flash', step: 7, shape: 'uson', z: 0.6 },
    motor_driver:  { label: '电机驱动', step: 7, shape: 'dfn', z: 0.8 },
    other:         { label: '其他', step: 7, shape: 'soic', z: 1.4 },
  };

  /** 卫星器件类别：prio 贴放优先级；max 默认最大距离(mm)；sev/check 超限时的级别与清单编号；back 背面代价；avoid 远离对象。 */
  const SAT_KINDS = {
    decoupling:    { label: '去耦电容', prio: 1, max: 2, sev: 'P1', check: 'PI-04', shape: 'cap', back: 1 },
    crystal:       { label: '晶体', prio: 2, max: 4, sev: 'P1', check: 'SI-04', shape: 'crystal', back: 6, avoid: { tags: ['antenna', 'switching', 'inductor'], r: 4 } },
    xtal_load:     { label: '晶体负载电容', prio: 3, max: 2, sev: 'P2', check: 'SI-04', shape: 'cap', back: 6 },
    rf_match:      { label: '射频匹配', prio: 4, max: 1, sev: 'P2', check: 'RF-05', shape: 'cap', back: Infinity },
    dcdc_inductor: { label: 'DCDC 电感', prio: 5, max: 3, sev: 'P1', check: 'PI-01', shape: 'inductor', back: 8, avoid: { tags: ['antenna', 'magnetometer', 'crystal'], r: 8 } },
    dcdc_cap:      { label: 'DCDC 电容', prio: 6, max: 2, sev: 'P1', check: 'PI-01', shape: 'cap', back: 4 },
    series_r:      { label: '串联电阻', prio: 7, max: 3, sev: 'P3', check: 'SI-02', shape: 'res', back: 2 },
    esd:           { label: 'ESD 保护', prio: 8, max: 3, sev: 'P1', check: 'EMC-01', shape: 'esd', back: 4 },
    bulk:          { label: '储能电容', prio: 9, max: 5, sev: 'P2', check: 'PI-06', shape: 'cap', back: 2 },
    pull:          { label: '上下拉', prio: 10, max: 6, sev: 'P3', check: 'SI-05', shape: 'res', back: 1 },
    divider:       { label: '分压电阻', prio: 10, max: 6, sev: 'P3', check: 'SI-05', shape: 'res', back: 1 },
  };

  const NET_CLASSES = {
    rf:          { label: '射频', color: '#22d3ee' },
    power:       { label: '电源', color: '#fb923c' },
    switch_node: { label: '开关节点', color: '#f43f5e' },
    high_speed:  { label: '高速', color: '#a78bfa' },
    analog:      { label: '敏感模拟', color: '#34d399' },
    clock:       { label: '时钟', color: '#facc15' },
    bus:         { label: '总线', color: '#60a5fa' },
    misc:        { label: '普通', color: '#94a3b8' },
  };

  const SIDES = ['N', 'E', 'S', 'W', 'C'];
  const ROTS = [0, 90, 180, 270];
  const SENSOR_ROLES = ['imu', 'magnetometer', 'barometer', 'microphone', 'optical', 'temp_humidity'];

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isPos = (v) => isNum(v) && v > 0;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- 校验 ----------
  /** 校验原始项目数据，返回 [{path, msg}]；空数组表示通过。与 scripts/make_layout_project.py 的规则一致。 */
  function validate(p) {
    const errs = [];
    const err = (path, msg) => errs.push({ path, msg });
    if (!p || typeof p !== 'object' || Array.isArray(p)) { err('', '项目数据必须是 JSON 对象'); return errs; }
    if (p.version !== 1) err('version', '必须为 1');
    if (typeof p.name !== 'string' || !p.name.trim()) err('name', '必须是非空字符串');

    const b = p.board;
    if (!b || typeof b !== 'object') err('board', '缺少 board');
    else {
      const o = b.outline;
      if (!o || typeof o !== 'object') err('board.outline', '缺少板框');
      else if (o.type === 'rect') {
        if (!isPos(o.w)) err('board.outline.w', '必须为正数');
        if (!isPos(o.h)) err('board.outline.h', '必须为正数');
        if (o.corner_r !== undefined && !(isNum(o.corner_r) && o.corner_r >= 0)) err('board.outline.corner_r', '必须为非负数');
      } else if (o.type === 'circle') {
        if (!isPos(o.d)) err('board.outline.d', '必须为正数');
      } else if (o.type === 'polygon') {
        if (!Array.isArray(o.points) || o.points.length < 3) err('board.outline.points', '至少需要 3 个顶点');
        else o.points.forEach((q, i) => { if (!Array.isArray(q) || q.length !== 2 || !isNum(q[0]) || !isNum(q[1])) err(`board.outline.points[${i}]`, '必须是 [x, y]'); });
      } else err('board.outline.type', '必须是 rect、circle 或 polygon');
      if (b.layers !== undefined && ![1, 2, 4, 6, 8].includes(b.layers)) err('board.layers', '必须是 1、2、4、6 或 8');
      for (const k of ['thickness', 'track', 'space', 'via_d']) if (b[k] !== undefined && !isPos(b[k])) err(`board.${k}`, '必须为正数');
      if (b.two_sided !== undefined && typeof b.two_sided !== 'boolean') err('board.two_sided', '必须是 true 或 false');
      (b.holes || []).forEach((h, i) => { if (!isNum(h.x) || !isNum(h.y) || !isPos(h.d)) err(`board.holes[${i}]`, '需要 x、y 和正数 d'); });
      (b.keepouts || []).forEach((k, i) => { if (!isNum(k.x) || !isNum(k.y) || !isPos(k.w) || !isPos(k.h)) err(`board.keepouts[${i}]`, '需要 x、y 和正数 w、h'); });
    }

    const refs = new Set();
    const pinsOf = {};
    if (!Array.isArray(p.parts) || !p.parts.length) err('parts', '至少需要一个主器件');
    else p.parts.forEach((pt, i) => {
      const at = `parts[${i}]`;
      if (typeof pt.ref !== 'string' || !pt.ref) err(`${at}.ref`, '必须是非空字符串');
      else if (refs.has(pt.ref)) err(`${at}.ref`, `位号 ${pt.ref} 重复`);
      else refs.add(pt.ref);
      if (!ROLES[pt.role]) err(`${at}.role`, `未知角色 "${pt.role}"`);
      if (!isPos(pt.w)) err(`${at}.w`, '必须为正数');
      if (!isPos(pt.h)) err(`${at}.h`, '必须为正数');
      if (pt.z !== undefined && !isPos(pt.z)) err(`${at}.z`, '必须为正数');
      if (pt.sides !== undefined && (!Array.isArray(pt.sides) || !pt.sides.length || pt.sides.some((s) => s !== 'top' && s !== 'bottom'))) err(`${at}.sides`, '只能包含 "top" 或 "bottom"');
      const ids = new Set();
      if (!Array.isArray(pt.pins)) err(`${at}.pins`, '必须是数组');
      else pt.pins.forEach((pn, j) => {
        const pa = `${at}.pins[${j}]`;
        if (typeof pn.id !== 'string' || !pn.id) err(`${pa}.id`, '必须是非空字符串');
        else if (ids.has(pn.id)) err(`${pa}.id`, `引脚组 ${pn.id} 重复`);
        else ids.add(pn.id);
        if (!SIDES.includes(pn.side)) err(`${pa}.side`, '必须是 N、E、S、W 或 C');
        if (pn.side !== 'C' && !(isNum(pn.pos) && pn.pos >= 0 && pn.pos <= 1)) err(`${pa}.pos`, '必须在 0 到 1 之间');
        if (pn.count !== undefined && !(Number.isInteger(pn.count) && pn.count >= 1)) err(`${pa}.count`, '必须是正整数');
      });
      if (pt.ref) pinsOf[pt.ref] = ids;
      if (pt.edge_face !== undefined && !['N', 'E', 'S', 'W'].includes(pt.edge_face)) err(`${at}.edge_face`, '必须是 N、E、S 或 W');
      checkPlaced(pt.placed, `${at}.placed`, err);
    });

    const netNames = new Set();
    (p.nets || []).forEach((n, i) => {
      const at = `nets[${i}]`;
      if (typeof n.name !== 'string' || !n.name) err(`${at}.name`, '必须是非空字符串');
      else if (netNames.has(n.name)) err(`${at}.name`, `网络 ${n.name} 重复`);
      else netNames.add(n.name);
      if (!NET_CLASSES[n.class]) err(`${at}.class`, `未知类别 "${n.class}"`);
      if (n.width !== undefined && !(Number.isInteger(n.width) && n.width >= 1)) err(`${at}.width`, '必须是正整数');
      if (n.max_len !== undefined && !isPos(n.max_len)) err(`${at}.max_len`, '必须为正数');
      if (!Array.isArray(n.pins) || n.pins.length < 2) err(`${at}.pins`, '至少连接两个引脚组');
      else n.pins.forEach((q, j) => {
        if (!Array.isArray(q) || q.length !== 2) { err(`${at}.pins[${j}]`, '必须是 [位号, 引脚组]'); return; }
        if (!pinsOf[q[0]]) err(`${at}.pins[${j}]`, `位号 ${q[0]} 不存在`);
        else if (!pinsOf[q[0]].has(q[1])) err(`${at}.pins[${j}]`, `${q[0]} 没有引脚组 ${q[1]}`);
      });
    });

    const satRefs = new Set();
    (p.satellites || []).forEach((s) => { if (typeof s.ref === 'string') satRefs.add(s.ref); });
    const seenSat = new Set();
    (p.satellites || []).forEach((s, i) => {
      const at = `satellites[${i}]`;
      if (typeof s.ref !== 'string' || !s.ref) err(`${at}.ref`, '必须是非空字符串');
      else if (refs.has(s.ref) || seenSat.has(s.ref)) err(`${at}.ref`, `位号 ${s.ref} 重复`);
      else seenSat.add(s.ref);
      if (!SAT_KINDS[s.kind]) err(`${at}.kind`, `未知类别 "${s.kind}"`);
      if (!Array.isArray(s.parent) || s.parent.length !== 2) err(`${at}.parent`, '必须是 [位号, 引脚组]');
      else if (!pinsOf[s.parent[0]]) err(`${at}.parent`, `位号 ${s.parent[0]} 不存在`);
      else if (!pinsOf[s.parent[0]].has(s.parent[1])) err(`${at}.parent`, `${s.parent[0]} 没有引脚组 ${s.parent[1]}`);
      if (!isPos(s.w)) err(`${at}.w`, '必须为正数');
      if (!isPos(s.h)) err(`${at}.h`, '必须为正数');
      if (s.max_dist !== undefined && !isPos(s.max_dist)) err(`${at}.max_dist`, '必须为正数');
      if (s.near !== undefined && (s.near === s.ref || !satRefs.has(s.near))) err(`${at}.near`, `卫星 ${s.near} 不存在`);
      checkPlaced(s.placed, `${at}.placed`, err);
    });

    if (p.rules !== undefined && !Array.isArray(p.rules)) err('rules', '必须是数组');
    else (p.rules || []).forEach((r, i) => { if (!r || (typeof r.id !== 'string' && typeof r.type !== 'string')) err(`rules[${i}]`, '需要 id（覆盖默认规则）或 type（新增规则）'); });
    return errs;
  }
  function checkPlaced(pl, at, err) {
    if (pl === undefined || pl === null) return;
    if (typeof pl !== 'object') { err(at, '必须是对象或 null'); return; }
    if (!isNum(pl.x) || !isNum(pl.y)) err(at, '需要数值 x、y');
    if (pl.rot !== undefined && !ROTS.includes(pl.rot)) err(`${at}.rot`, '必须是 0、90、180 或 270');
    if (pl.side !== undefined && pl.side !== 'top' && pl.side !== 'bottom') err(`${at}.side`, '必须是 "top" 或 "bottom"');
  }

  // ---------- 默认值 ----------
  function normalize(raw) {
    const p = clone(raw);
    const b = p.board;
    b.outline = { corner_r: 0, ...b.outline };
    b.layers = b.layers || 4;
    b.thickness = b.thickness || 1.0;
    b.track = b.track || 0.15;
    b.space = b.space || 0.15;
    b.via_d = b.via_d || 0.45;
    b.two_sided = b.two_sided !== false;
    b.holes = b.holes || [];
    b.keepouts = b.keepouts || [];
    b.mask = b.mask || 'green';
    for (const pt of p.parts) {
      const R = ROLES[pt.role];
      pt.label = pt.label || R.label;
      pt.shape = pt.shape || R.shape;
      pt.z = pt.z || R.z;
      pt.sides = pt.sides || ['top'];
      pt.pins = pt.pins || [];
      for (const pn of pt.pins) { pn.count = pn.count || 1; if (pn.side === 'C') pn.pos = 0.5; }
      pt.locked = !!pt.locked;
      pt.heat_mw = pt.heat_mw || 0;
      if (pt.edge === undefined) pt.edge = !!R.edge || (pt.edge_face !== undefined);
      pt.placed = pt.placed ? { rot: 0, side: pt.sides[0], ...pt.placed } : null;
    }
    p.nets = (p.nets || []).map((n) => ({ width: 1, ...n }));
    p.satellites = (p.satellites || []).map((s) => {
      const K = SAT_KINDS[s.kind];
      const o = { label: K.label, max_dist: K.max, pinned: false, ...s };
      o.placed = s.placed ? { rot: 0, side: 'top', ...s.placed } : null;
      return o;
    });
    p.rules = p.rules || [];
    return p;
  }

  /** Viewed names may change; reference designators remain the electrical identity. */
  function faceName(item) {
    const passive = !!item.kind || /^(?:R|C|L|FB|RT)\d/i.test(item.ref);
    const candidates = [item.display_name, passive && item.value, item.name, item.mpn,
      item.model, item.label, item.value, (SAT_KINDS[item.kind] || ROLES[item.role] || {}).label];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      let name = candidate.trim();
      if (name.startsWith(item.ref)) {
        const suffix = name.slice(item.ref.length);
        if (/^(?:\s+|[·:：|—–-])/.test(suffix)) name = suffix.replace(/^[\s·:：|—–-]+/, '');
      }
      if (name && name !== item.ref) return name.trim();
    }
    return '器件';
  }

  const CHIP_KINDS = { res: 'resistor', cap: 'capacitor', ferrite: 'ferrite', thermistor: 'thermistor' };
  // Nominal package bodies for older EasyEDA exports (imperial chip codes). The footprint envelope includes land overhang.
  const CHIP_BODIES = { '0201': [0.6, 0.3], '0402': [1.0, 0.5], '0603': [1.6, 0.8], '0805': [2.0, 1.25],
    '1206': [3.2, 1.6], '1210': [3.2, 2.5], '2010': [5.0, 2.5], '2512': [6.3, 3.2] };

  /** Board-local mm. Keep land, visible body and terminations separate from the placement envelope. */
  function passiveGeometry(item) {
    const spec = item.visualPackage;
    const shape = item.shape || SAT_KINDS[item.kind]?.shape;
    const footprint = typeof item.footprint === 'string' ? item.footprint : '';
    const chip = /^(?:[^:]+:)?([RCL])_?(\d{4})(?:_\d{4}Metric)?$/i.exec(footprint);
    const family = chip && ({R:'resistor', C:'capacitor'})[chip[1].toUpperCase()];
    let kind = spec?.kind || CHIP_KINDS[shape] || family;
    if (!kind) return null;
    const nativeBody = spec?.body;
    const pads = Array.isArray(spec?.pads) ? spec.pads.filter(p => p && isNum(p.x) && isNum(p.y) && isPos(p.w) && isPos(p.h)) : [];
    const centers = pads.length ? pads : (item.physicalPads || []).flatMap(p =>
      (p.xy || []).filter(q => Array.isArray(q) && isNum(q[0]) && isNum(q[1])).map(([x,y]) => ({x,y})));
    const special = item.through || item.polarized || /(?:array|network|electroly|tantal|radial|axial|polar|^CP[_-]|排阻|排容|钽|电解)/i.test(footprint);
    if (!Object.values(CHIP_KINDS).includes(kind) || special || (spec && pads.length !== 2) ||
        (centers.length && centers.length !== 2) || (item.pins?.length > 2)) kind = 'generic';
    const horizontal = centers.length === 2
      ? Math.abs(centers[1].x - centers[0].x) >= Math.abs(centers[1].y - centers[0].y)
      : (nativeBody?.w || item.w) >= (nativeBody?.h || item.h);
    let body = {x: 0, y: 0, w: item.w, h: item.h};
    if (isPos(nativeBody?.w) && isPos(nativeBody?.h)) {
      body = {x: isNum(nativeBody.x) ? nativeBody.x : 0, y: isNum(nativeBody.y) ? nativeBody.y : 0, w: nativeBody.w, h: nativeBody.h};
    } else if (!spec && kind !== 'generic' && centers.length === 2) {
      const size = chip && CHIP_BODIES[chip[2]];
      if (size) {
        const [w,h] = horizontal ? size : [size[1], size[0]];
        if (w <= item.w * 1.05 && h <= item.h * 1.05) {
          body = {x: (centers[0].x + centers[1].x) / 2, y: (centers[0].y + centers[1].y) / 2, w, h};
        }
      }
    }
    const width = horizontal ? body.h : body.w;
    // Imported 2D footprints have an envelope and no measured thickness. A role's default IC height is unsuitable.
    const visualHeight = kind === 'resistor' ? Math.min(width * 0.48, 0.65) : width * 0.75;
    const height = isPos(nativeBody?.z) ? nativeBody.z : (!spec && !footprint && item.z) || visualHeight;
    const terminals = [];
    if (kind !== 'generic') {
      const length = horizontal ? body.w : body.h;
      const end = Math.min(length * 0.21, width * 0.43);
      const orderedPads = pads.slice().sort((a, b) => horizontal ? a.x - b.x : a.y - b.y);
      for (const sign of [-1, 1]) {
        const offset = sign * (length - end) / 2;
        const index = sign < 0 ? 0 : 1;
        terminals.push({n: orderedPads[index]?.n ?? index + 1, x: body.x + (horizontal ? offset : 0), y: body.y + (horizontal ? 0 : offset),
          w: horizontal ? end : body.w, h: horizontal ? body.h : end});
      }
    }
    return {kind, body, pads, terminals, height};
  }

  function faceRect(item, pl = item.placed) {
    const pkg = passiveGeometry(item);
    if (!pkg) return footprint(item, pl);
    const {body} = pkg, center = toWorld(body.x, body.y, pl);
    const [w,h] = dims(body.w, body.h, pl.rot || 0);
    return G.rectFromCenter(center.x, center.y, w, h);
  }

  /** A mounted BGA exposes the package index on top; its solder balls face the board. */
  function bgaMark(item) {
    const footprint = typeof item.footprint === 'string' ? item.footprint.split(':').pop() : '';
    if (item.shape !== 'bga' && !/^[A-Z]*BGA(?=[\d_\s-]|$)/i.test(footprint)) return null;
    const a1 = item.physicalPads?.find(p => p.n === 'A1')?.xy?.[0];
    const corner = /[-_](TL|TR|BL|BR)$/i.exec(footprint)?.[1].toUpperCase();
    const sx = isNum(a1?.[0]) && a1[0] !== 0 ? Math.sign(a1[0]) : corner?.endsWith('R') ? 1 : -1;
    const sy = isNum(a1?.[1]) && a1[1] !== 0 ? Math.sign(a1[1]) : corner?.startsWith('B') ? -1 : 1;
    const r = Math.min(0.28, Math.min(item.w, item.h) * 0.08);
    return {x: sx * (item.w / 2 - 2.4 * r), y: sy * (item.h / 2 - 2.4 * r), r};
  }

  // ---------- 坐标变换 ----------
  function dims(w, h, rot) { return rot === 90 || rot === 270 ? [h, w] : [w, h]; }
  function footprint(part, pl) {
    pl = pl || part.placed;
    if (!pl) return null;
    const [w, h] = dims(part.w, part.h, pl.rot || 0);
    return G.rectFromCenter(pl.x, pl.y, w, h);
  }
  /** 局部坐标（器件中心为原点、未旋转、正面视角）→ 世界坐标。背面器件从正面看是镜像的。 */
  function toWorld(lx, ly, pl) {
    if (pl.side === 'bottom') lx = -lx;
    const a = ((pl.rot || 0) * Math.PI) / 180;
    const c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
    return { x: pl.x + lx * c - ly * s, y: pl.y + lx * s + ly * c };
  }
  function dirToWorld(nx, ny, pl) {
    if (pl.side === 'bottom') nx = -nx;
    const a = ((pl.rot || 0) * Math.PI) / 180;
    const c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
    return { x: nx * c - ny * s, y: nx * s + ny * c };
  }
  const SIDE_NORMAL = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0], C: [0, 0] };
  function pinLocal(part, pin) {
    const w = part.w, h = part.h, t = pin.pos;
    switch (pin.side) {
      case 'N': return { x: -w / 2 + t * w, y: h / 2 };
      case 'S': return { x: -w / 2 + t * w, y: -h / 2 };
      case 'E': return { x: w / 2, y: h / 2 - t * h };
      case 'W': return { x: -w / 2, y: h / 2 - t * h };
      default: return { x: 0, y: 0 };
    }
  }
  /** 引脚组的世界坐标与朝外法向。 */
  function pinWorld(part, pinId, pl) {
    pl = pl || part.placed;
    const pin = part.pins.find((q) => q.id === pinId);
    if (!pin || !pl) return null;
    const l = pinLocal(part, pin);
    const p = toWorld(l.x, l.y, pl);
    const [nx, ny] = SIDE_NORMAL[pin.side];
    const n = dirToWorld(nx, ny, pl);
    return { x: p.x, y: p.y, nx: n.x, ny: n.y, count: pin.count, side: pin.side };
  }
  /** 局部的边（N/E/S/W）在世界坐标中朝向哪一边。 */
  function worldSide(localSide, pl) {
    const [nx, ny] = SIDE_NORMAL[localSide];
    const n = dirToWorld(nx, ny, pl);
    if (n.x > 0.5) return 'E';
    if (n.x < -0.5) return 'W';
    if (n.y > 0.5) return 'N';
    return 'S';
  }
  function satFootprint(sat, pl) {
    pl = pl || sat.placed;
    if (!pl) return null;
    const [w, h] = dims(sat.w, sat.h, pl.rot || 0);
    return G.rectFromCenter(pl.x, pl.y, w, h);
  }

  // ---------- 查询 ----------
  function partByRef(p, ref) { return p.parts.find((x) => x.ref === ref) || null; }
  function satByRef(p, ref) { return p.satellites.find((x) => x.ref === ref) || null; }
  function itemByRef(p, ref) { return partByRef(p, ref) || satByRef(p, ref); }
  function placedParts(p) { return p.parts.filter((x) => x.placed); }
  function partTags(pt) {
    const t = new Set([pt.role, 'part']);
    if (pt.heat_mw > 50 || pt.role === 'charger' || pt.role === 'ldo') t.add('heat');
    if (pt.role === 'dcdc') t.add('switching');
    if (pt.role === 'inductor') { t.add('inductor'); t.add('switching'); }
    if (['inductor', 'battery', 'motor_driver'].includes(pt.role)) t.add('magnetic_source');
    if (SENSOR_ROLES.includes(pt.role)) t.add('sensor');
    if (pt.role === 'rf_module') t.add('shield');
    return t;
  }
  function satTags(s) {
    const t = new Set([s.kind, 'sat']);
    if (s.kind === 'crystal') t.add('crystal');
    if (s.kind === 'dcdc_inductor') { t.add('inductor'); t.add('switching'); t.add('magnetic_source'); }
    return t;
  }
  /** 器件之间是否有网络相连。返回 Map<ref, Set<netClass>>。 */
  function connectedParts(p, ref) {
    const out = new Map();
    for (const n of p.nets) {
      if (!n.pins.some((q) => q[0] === ref)) continue;
      for (const q of n.pins) {
        if (q[0] === ref) continue;
        if (!out.has(q[0])) out.set(q[0], new Set());
        out.get(q[0]).add(n.class);
      }
    }
    return out;
  }
  /** 解析电容值文本（如 "100nF"、"4.7uF"）为法拉，解析失败返回 Infinity。 */
  function parseCap(v) {
    if (typeof v !== 'string') return Infinity;
    const m = v.trim().match(/^([\d.]+)\s*([pnuµm]?)F?/i);
    if (!m) return Infinity;
    const mul = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, '': 1 }[m[2].toLowerCase()] ?? 1;
    return parseFloat(m[1]) * mul;
  }

  // ---------- 板框形状 ----------
  /** 可选的板框形状。rect/stadium/circle 用解析形状；chamfer/lshape/custom 存为多边形，并记下 shape 与参数以便再次编辑。 */
  const BOARD_SHAPES = ['rect', 'stadium', 'chamfer', 'lshape', 'circle', 'custom'];
  /** 由形状和参数生成板框。参数：w、h、r（圆角）、c（倒角）、nw/nh（L 形右上角缺口）、d（直径）、points（自定义）。 */
  function outlineFromShape(shape, q) {
    const w = q.w, h = q.h;
    switch (shape) {
      case 'circle': return { type: 'circle', d: q.d };
      case 'stadium': return { type: 'rect', w, h, corner_r: Math.min(w, h) / 2, shape: 'stadium' };
      case 'chamfer': {
        const c = Math.max(0.5, Math.min(q.c ?? 3, w / 2 - 0.5, h / 2 - 0.5));
        return { type: 'polygon', shape: 'chamfer', w, h, c, points: [[c, 0], [w - c, 0], [w, c], [w, h - c], [w - c, h], [c, h], [0, h - c], [0, c]] };
      }
      case 'lshape': {
        const nw = Math.max(1, Math.min(q.nw ?? w * 0.4, w - 2)), nh = Math.max(1, Math.min(q.nh ?? h * 0.4, h - 2));
        return { type: 'polygon', shape: 'lshape', w, h, nw, nh, points: [[0, 0], [w, 0], [w, h - nh], [w - nw, h - nh], [w - nw, h], [0, h]] };
      }
      case 'custom': return { type: 'polygon', shape: 'custom', points: q.points.map((pt) => [r2(pt[0]), r2(pt[1])]) };
      case 'rect': default: return { type: 'rect', w, h, corner_r: Math.max(0, q.r ?? 0) };
    }
  }
  /** 当前板框属于哪种形状（供界面回显）。 */
  function shapeOf(o) {
    if (o.type === 'circle') return 'circle';
    if (o.type === 'rect') return o.shape === 'stadium' ? 'stadium' : 'rect';
    return ['chamfer', 'lshape'].includes(o.shape) ? o.shape : 'custom';
  }
  /** 转为可逐点编辑的多边形：只保留形状的特征顶点（圆角忽略，圆形取 16 边形）。 */
  function toEditablePolygon(o) {
    if (o.type === 'polygon') return { type: 'polygon', shape: 'custom', points: o.points.map((pt) => [...pt]) };
    if (o.type === 'circle') {
      const r = o.d / 2;
      return { type: 'polygon', shape: 'custom', points: Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return [r2(r + r * Math.cos(a)), r2(r + r * Math.sin(a))]; }) };
    }
    return { type: 'polygon', shape: 'custom', points: [[0, 0], [o.w, 0], [o.w, o.h], [0, o.h]] };
  }
  /** 板框 DXF（R12，毫米）：外框为 BOARD 层线段，固定孔为 HOLES 层圆。可导入嘉立创 EDA 作为初始板框。 */
  function exportDXF(p) {
    const out = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
    const f = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
    const o = p.board.outline;
    if (o.type === 'circle') out.push('0', 'CIRCLE', '8', 'BOARD', '10', f(o.d / 2), '20', f(o.d / 2), '30', '0', '40', f(o.d / 2));
    else {
      const pts = G.outlinePolygon(o);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        out.push('0', 'LINE', '8', 'BOARD', '10', f(a.x), '20', f(a.y), '30', '0', '11', f(b.x), '21', f(b.y), '31', '0');
      }
    }
    for (const h of p.board.holes || []) out.push('0', 'CIRCLE', '8', 'HOLES', '10', f(h.x), '20', f(h.y), '30', '0', '40', f(h.d / 2));
    out.push('0', 'ENDSEC', '0', 'EOF');
    return out.join('\r\n') + '\r\n';
  }

  // ---------- 改板框时同步固定孔与禁布区 ----------
  /**
   * 板框尺寸改变后，固定孔和禁布区保持到最近板角（按外包矩形）或板边（圆形之间）的相对位置，
   * 避免缩小板子后它们落到板外。
   */
  function remapBoardFeatures(board, oldO, newO) {
    const ob = G.outlineBBox(oldO), nb = G.outlineBBox(newO);
    const mapPoint = (x, y) => {
      if (oldO.type === 'circle' && newO.type === 'circle') {
        const oc = G.center(ob), nc = G.center(nb), r0 = oldO.d / 2, r1 = newO.d / 2;
        const dx = x - oc.x, dy = y - oc.y, d = Math.hypot(dx, dy) || 1;
        const inset = r0 - d;
        const nd = Math.max(0, r1 - inset);
        return { x: nc.x + (dx / d) * nd, y: nc.y + (dy / d) * nd };
      }
      const fx = (x - ob.x0) / Math.max(ob.x1 - ob.x0, 1e-9), fy = (y - ob.y0) / Math.max(ob.y1 - ob.y0, 1e-9);
      const nx = fx < 0.5 ? nb.x0 + (x - ob.x0) : nb.x1 - (ob.x1 - x);
      const ny = fy < 0.5 ? nb.y0 + (y - ob.y0) : nb.y1 - (ob.y1 - y);
      return { x: nx, y: ny };
    };
    for (const h of board.holes || []) { const q = mapPoint(h.x, h.y); h.x = r2(q.x); h.y = r2(q.y); }
    for (const k of board.keepouts || []) {
      const c = mapPoint(k.x + k.w / 2, k.y + k.h / 2);
      // 贴边的禁布区保持贴边
      const q = mapPoint(k.x, k.y);
      const fx = (k.x + k.w / 2 - ob.x0) / Math.max(ob.x1 - ob.x0, 1e-9), fy = (k.y + k.h / 2 - ob.y0) / Math.max(ob.y1 - ob.y0, 1e-9);
      k.x = r2(fx < 0.5 ? q.x : c.x - k.w / 2);
      k.y = r2(fy < 0.5 ? q.y : c.y - k.h / 2);
    }
  }
  /** 主器件占地面积（mm²），分正反面；用于提示板子是否够大。 */
  function partsArea(p) {
    let top = 0, bottom = 0, maxDim = 0;
    for (const x of p.parts) {
      const a = x.w * x.h;
      if (x.sides.includes('top')) top += a; else bottom += a;
      maxDim = Math.max(maxDim, Math.min(x.w, x.h));
    }
    for (const s of p.satellites) top += s.w * s.h;
    return { top, bottom, maxDim };
  }

  // ---------- 撤销快照与持久化 ----------
  function snapshot(p) {
    const parts = {}, sats = {};
    for (const x of p.parts) parts[x.ref] = x.placed ? { ...x.placed } : null;
    for (const x of p.satellites) sats[x.ref] = x.pinned && x.placed ? { ...x.placed } : null;
    return JSON.stringify({ board: p.board, parts, sats, locked: p.parts.filter((x) => x.locked).map((x) => x.ref) });
  }
  function restore(p, snap) {
    const s = JSON.parse(snap);
    p.board = s.board;
    const locked = new Set(s.locked || []);
    for (const x of p.parts) { x.placed = s.parts[x.ref] ? { ...s.parts[x.ref] } : null; x.locked = locked.has(x.ref); }
    for (const x of p.satellites) {
      const v = s.sats[x.ref];
      x.pinned = !!v;
      if (v) x.placed = { ...v };
    }
  }
  function stableStringify(v) {
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).filter((k) => k[0] !== '_').sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  /** 项目定义（不含摆放结果）的指纹，用于判断本地自动保存的状态是否属于同一个项目。 */
  function definitionHash(p) {
    const d = clone(p);
    delete d.result;
    delete d.orbitFocus;
    for (const x of d.parts || []) { delete x.placed; delete x.locked; delete x.orbitParent; delete x.visualPackage; }
    for (const x of d.satellites || []) { delete x.placed; delete x.pinned; delete x.visualPackage; }
    if (d.board) { delete d.board.outline; delete d.board.mask; delete d.board.holes; }
    const s = stableStringify(d);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  // ---------- 导出 ----------
  const r2 = (v) => Math.round(v * 100) / 100;
  function exportLayout(p, ev) {
    const out = clone(p);
    for (const x of out.parts) if (x.placed) x.placed = { x: r2(x.placed.x), y: r2(x.placed.y), rot: x.placed.rot, side: x.placed.side };
    for (const x of out.satellites) if (x.placed) x.placed = { x: r2(x.placed.x), y: r2(x.placed.y), rot: x.placed.rot, side: x.placed.side };
    if (ev) out.result = resultObject(ev);
    return out;
  }
  function resultObject(ev) {
    const m = ev.metrics;
    return {
      tool_version: TOOL_VERSION,
      exported_at: new Date().toISOString(),
      note: '启发式估计，用于比较方案，不等于实际布线结果。',
      metrics: {
        total_length_mm: r2(m.length.value),
        crossings: m.crossings.value,
        congestion_peak: r2(m.congestion.peak),
        congestion_over_fraction: r2(m.congestion.overFrac),
        critical_violations: m.critical.violations,
        exit_pressure_max: r2(m.exit.max),
        statuses: Object.fromEntries(Object.entries(m).filter(([, v]) => v && v.status).map(([k, v]) => [k, v.status])),
        details: {
          nets: m.length.perNet.map((n) => ({ net: n.net, length_mm: r2(n.len) })),
          crossing_pairs: m.crossings.pairs.map((c) => ({ a: c.a, b: c.b, count: c.n })),
          critical: m.critical.items.map((c) => ({ name: c.name, value_mm: r2(c.value), limit_mm: c.limit, ok: c.ok })),
          exit_pressure: m.exit.list.map((e) => ({ ref: e.ref, side: e.side, need: e.need, channels: r2(e.channels), ratio: r2(e.ratio) })),
        },
      },
      layer_suggestion: m.layers ? { layers: m.layers.layers, reasons: m.layers.reasons } : null,
      issues: ev.issues.map((i) => ({ severity: i.severity, check: i.check, refs: i.refs, message: i.msg, fix: i.fix })),
      unplaced_parts: ev.unplacedParts,
      unplaced_satellites: ev.unplacedSats,
    };
  }
  function exportCSV(p) {
    const lines = ['# 坐标单位 mm，原点为板框左下角，x 向右、y 向上；角度为逆时针度数；side 为 top/bottom。',
      '# 启发式布局规划结果，用作 EDA 摆放起点。', 'ref,type,x,y,rot,side'];
    for (const x of p.parts) if (x.placed) lines.push([x.ref, 'part', r2(x.placed.x), r2(x.placed.y), x.placed.rot, x.placed.side].join(','));
    for (const x of p.satellites) if (x.placed) lines.push([x.ref, x.kind, r2(x.placed.x), r2(x.placed.y), x.placed.rot, x.placed.side].join(','));
    return lines.join('\n') + '\n';
  }


  // ---------- 固定孔 ----------
  /** 常用固定孔：孔径取螺丝的常用过孔尺寸。 */
  const HOLE_SIZES = [{ id: 'M2', d: 2.2 }, { id: 'M2.5', d: 2.7 }, { id: 'M3', d: 3.2 }];
  const HOLE_EDGE = 1.5;   // 孔边到板边的推荐最小距离（留出焊环和铣边公差）
  const holeRectOf = (x, y, d) => G.rectFromCenter(x, y, d, d);
  /** 孔放在 (x, y) 是否合适：在板内且离边足够、不与其它孔、禁布区、已摆放器件冲突。ignore 为要跳过的孔序号。 */
  function holeFits(p, x, y, d, ignore) {
    const b = p.board, r = holeRectOf(x, y, d);
    if (!G.rectInBoard(b.outline, G.expand(r, HOLE_EDGE))) return false;
    for (let i = 0; i < (b.holes || []).length; i++) {
      if (i === ignore) continue;
      const h = b.holes[i];
      if (Math.hypot(h.x - x, h.y - y) < (h.d + d) / 2 + 2) return false;
    }
    for (const k of b.keepouts || []) if (G.overlaps(r, { x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h })) return false;
    const rr = G.expand(r, 0.8);
    for (const x2 of p.parts) if (x2.placed && G.overlaps(rr, footprint(x2))) return false;
    for (const s of p.satellites) if (s.placed && s._active && G.overlaps(rr, satFootprint(s))) return false;
    return true;
  }
  /** 从板框外接矩形的四个角沿对角线向中心找第一个合适的孔位（适用于各种板框形状）。 */
  function cornerHolePositions(outline, d) {
    const bb = G.outlineBBox(outline);
    const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
    const out = [];
    for (const [x0, y0] of [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]]) {
      const L = Math.hypot(cx - x0, cy - y0), ux = (cx - x0) / L, uy = (cy - y0) / L;
      for (let t = 0; t < L; t += 0.25) {
        const x = Math.round((x0 + ux * t) * 2) / 2, y = Math.round((y0 + uy * t) * 2) / 2;
        if (G.rectInBoard(outline, G.expand(holeRectOf(x, y, d), HOLE_EDGE))) { out.push({ x, y }); break; }
      }
    }
    return out;
  }
  /** 四角各放一个孔（开场选尺寸时用）。 */
  function cornerHoles(outline, d) { return cornerHolePositions(outline, d).map((q) => ({ x: q.x, y: q.y, d })); }
  /** 为新孔找空位：先试四角，再按离板边由近到远扫描整板。找不到返回 null。 */
  function suggestHole(p, d) {
    for (const q of cornerHolePositions(p.board.outline, d)) if (holeFits(p, q.x, q.y, d)) return q;
    const bb = G.outlineBBox(p.board.outline), cand = [];
    for (let x = bb.x0; x <= bb.x1; x += 0.5) for (let y = bb.y0; y <= bb.y1; y += 0.5) {
      if (!G.pointInPolygon({ x, y }, G.outlinePolygon(p.board.outline))) continue;
      cand.push({ x, y, e: G.distToBoardEdge(p.board.outline, { x, y }) });
    }
    cand.sort((a, b) => a.e - b.e);
    for (const q of cand) if (holeFits(p, q.x, q.y, d)) return { x: q.x, y: q.y };
    return null;
  }

  LP.model = {
    TOOL_VERSION, ROLES, SAT_KINDS, NET_CLASSES, SIDES, ROTS, SENSOR_ROLES,
    validate, normalize, clone, dims, footprint, toWorld, dirToWorld, pinLocal, pinWorld, worldSide, satFootprint, faceName, faceRect, passiveGeometry, bgaMark,
    partByRef, satByRef, itemByRef, placedParts, partTags, satTags, connectedParts, parseCap,
    snapshot, restore, definitionHash, exportLayout, resultObject, exportCSV, r2, remapBoardFeatures, partsArea, BOARD_SHAPES, outlineFromShape, shapeOf, toEditablePolygon, exportDXF,
    HOLE_SIZES, HOLE_EDGE, holeFits, cornerHoles, suggestHole,
  };
})(globalThis.LP = globalThis.LP || {});
