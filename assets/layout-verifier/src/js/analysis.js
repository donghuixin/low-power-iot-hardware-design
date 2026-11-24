// 分析入口：Worker 与 Node 测试都通过这里调用。保存当前项目状态，按"输入 + 参数"缓存结果。
(function (LP) {
  'use strict';
  const V = LP.vmodel, F = LP.vrules;
  let st = null, pack = null, cache = new Map();

  function key(op, args) { return op + ':' + JSON.stringify(args || {}); }
  function memo(op, args, fn) {
    const k = key(op, args);
    if (cache.has(k)) return cache.get(k);
    const r = fn();
    cache.set(k, r);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return r;
  }

  /** 读入项目和（可选的）铜皮数据包。返回给界面的摘要。 */
  function init(raw, copper) {
    cache = new Map();
    pack = copper && LP.copper ? LP.copper.load(copper) : null;
    // 阶段 R：板框和器件位置以实际布板为准，网格与数据包逐格对齐
    const proj = pack ? LP.copper.alignProject(raw, pack) : raw;
    st = V.prepare(proj, { maxCells: 160, grid: pack ? pack.grid : null });
    st.stage = pack ? 'R' : 'P';
    st.pack = pack;
    return summary();
  }

  function summary() {
    const { p, v, g } = st;
    return {
      stage: st.stage, name: p.name || '', layers: st.layers, defaults: st.defaults,
      board: { outline: p.board.outline, holes: p.board.holes, keepouts: p.board.keepouts, w: g.w, h: g.h, x0: g.x0, y0: g.y0 },
      grid: { nx: g.nx, ny: g.ny, cell: g.cell, x0: g.x0, y0: g.y0 },
      items: st.items.map((it) => ({ ref: it.ref, kind: it.kind, role: it.role, satKind: it.satKind, side: it.side, rect: it.rect })),
      antRects: st.antRects,
      loads: v.loads.map((l, i) => ({ i, part: l.part, pin: l.pin, net: l.net, i_avg_ma: l.i_avg_ma, i_peak_ma: l.i_peak_ma, kind: l.kind, def: !!l._default })),
      sources: v.sources, thermal: v.thermal.map((t) => ({ part: t.part, p_w: t.p_w, def: !!t._default })),
      emitters: v.emitters, victims: v.victims, stackup: v.stackup, env: v.env, gnd: st.gnd,
      copper: pack ? { layers: pack.layers, source: pack.source, groups: Object.keys(pack.cov || {}), parts: pack.parts } : null,
    };
  }

  function current(i, opts = {}) {
    return memo('current', { i, ...opts }, () => {
      const r = st.stage === 'R' ? LP.copper.analyzeCurrent(st, i, opts) : LP.current.analyzeP(st, i, opts);
      if (r.findings) r.findings = F.forStage(r.findings, st.stage);
      return r;
    });
  }
  function thermal(opts = {}) {
    return memo('thermal', opts, () => {
      const o = { ...opts };
      if (st.stage === 'R') Object.assign(o, LP.copper.thermalInputs(st));
      const r = LP.thermal.analyze(st, o);
      r.findings = F.forStage(r.findings, st.stage);
      return r;
    });
  }
  function emi(opts = {}) {
    return memo('emi', opts, () => {
      const o = { ...opts };
      if (st.stage === 'R') o.netGeom = LP.copper.netGeom(st);
      const r = LP.emi.analyze(st, o);
      if (st.stage === 'R') r.findings = r.findings.concat(LP.copper.emiChecks(st));
      r.findings = F.forStage(r.findings, st.stage);
      return r;
    });
  }
  function modes(opts = {}) {
    return memo('modes', opts, () => {
      const o = { ...opts };
      if (st.stage === 'R') Object.assign(o, LP.copper.planeShape(st));
      const r = LP.emi.modes(st, o);
      if (r.findings) r.findings = F.forStage(r.findings, st.stage);
      return r;
    });
  }

  /** 导出报告：逐个负载跑电流，再跑温度、电磁、谐振，汇总结论与关键数值。 */
  function report(opts = {}) {
    const { v } = st;
    const loads = v.loads.map((l, i) => {
      const r = current(i, opts.current || {});
      return { part: l.part, net: l.net, kind: l.kind, i_avg_ma: l.i_avg_ma, error: r.error || null, loop_mm2: r.loopArea != null ? +r.loopArea.toFixed(1) : null, drop_mv: r.dropV != null ? +(r.dropV * 1000).toFixed(2) : null, ret: r.retMode || null, corridor_mm: r.corridor != null ? +r.corridor.toFixed(2) : null, findings: r.findings || [] };
    });
    const th = thermal(opts.thermal || {});
    const em = emi(opts.emi || {});
    const md = modes({});
    let all = [];
    for (const l of loads) all = all.concat(l.findings);
    all = all.concat(th.findings, em.findings, md.findings || []);
    const seen = new Set();
    all = all.filter((f) => { const k = f.rule + '|' + f.title; if (seen.has(k)) return false; seen.add(k); return true; });
    return {
      tool: 'layout-verifier', version: '1.0.0', stage: st.stage, name: st.p.name || '', defaults: st.defaults,
      assumptions: assumptions(),
      findings: F.sortFindings(all),
      loads: loads.map(({ findings, ...x }) => x),
      thermal: { ta: th.ta, tmax: +th.tmax.toFixed(1), p_total_w: +th.P.toFixed(3), parts: th.parts },
      emi: { victims: em.victims.map((x) => ({ label: x.label, level_db: x.level, grade: x.grade, top: x.top })) },
      modes: md.na ? { na: md.na } : md.modes.map((m, k) => ({ mode: k + 1, f_ghz: +(m.f / 1e9).toFixed(3), near: m.near })),
    };
  }
  function assumptions() {
    const { v } = st;
    const a = [
      `叠层：${st.layers} 层；平面 ${v.stackup.planes.map((q) => `L${q.layer + 1}=${q.net}`).join('，') || '无'}；参考平面距离 ${v.stackup.h_mm} mm`,
      `环境 ${v.env.ta_c} °C，${v.env.airflow_m_s ? `风速 ${v.env.airflow_m_s} m/s` : '自然对流'}${v.env.sealed_k_per_w ? `，密闭外壳 ${v.env.sealed_k_per_w} K/W` : ''}`,
    ];
    if (st.stage === 'P') a.push('布线前：电流路径按引脚朝向和可走通道的概率估计，铜覆盖率按平面层 90%、信号层 30% 假设');
    else a.push(`布线后：铜皮来自 ${st.pack.source}，求解网格 ${st.g.cell.toFixed(2)} mm`);
    if (st.defaults.length) a.push('使用默认值的字段：' + st.defaults.join('、'));
    return a;
  }

  function copperLayer(group, layer) { return LP.copper.layerImage(st, group, layer); }

  LP.analysis = { init, summary, current, thermal, emi, modes, report, copperLayer, get state() { return st; } };
})(globalThis.LP = globalThis.LP || {});
