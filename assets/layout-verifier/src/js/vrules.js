// 验证结论：规则表（默认阈值，可被项目 verify.rules 覆盖）与结论对象。
(function (LP) {
  'use strict';
  const RULES = {
    'VF-01': { name: '电流瓶颈', sev: 'P1', check: 'PI-05' },
    'VF-02': { name: '直流压降', sev: 'P1', max_pct: 2, check: 'PI-05' },
    'VF-03': { name: '过孔电流', sev: 'P2', max_a: 0.5, check: 'PI-05' },
    'VF-04': { name: '回路面积', sev: 'P1', max_mm2: 20, max_decap_mm: 3, check: 'PI-04' },
    'VF-05': { name: '回流绕路', sev: 'P1', max_ratio: 1.5, check: 'SI-01' },
    'VF-06': { name: '共用回流', sev: 'P2', max_overlap: 0.3, check: 'PI-07' },
    'VF-07': { name: '受扰等级', sev: 'P1', high_db: -20, mid_db: -35, check: 'SI-06' },
    'VF-08': { name: '射频参考平面', sev: 'P1', min_ref: 0.95, fence_frac: 1 / 20, check: 'RF-06' },
    'VF-09': { name: '并行耦合', sev: 'P2', max_ratio: 20, check: 'SI-06' },
    'VF-10': { name: '平面谐振', sev: 'P2', band: 0.1, antinode: 0.7, check: 'PI-08' },
    'VF-11': { name: '结温', sev: 'P1', warn_frac: 0.9, check: 'THM-01' },
    'VF-12': { name: '怕热器件', sev: 'P2', max_rise: 20, max_grad: 5, check: 'SEN-02' },
    'VF-13': { name: '表面温度', sev: 'P0', check: 'THM-01' },
    'VF-14': { name: '地铜孤岛', sev: 'P2', check: 'PI-08' },
  };
  function rule(v, id) { return { ...RULES[id], ...((v && v.rules && v.rules[id]) || {}) }; }
  /**
   * 结论对象。where: {x, y} 或 {x0, y0, x1, y1}；assume：所依据的假设（一句话）。
   */
  function finding(v, id, o) {
    const r = rule(v, id);
    return { rule: id, name: r.name, check: r.check, sev: o.sev || r.sev, obj: o.obj || null, title: o.title, advice: o.advice || '', value: o.value ?? null, where: o.where || null, assume: o.assume || '' };
  }
  const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
  /** 阶段 P 的结论：文字前加"估计："，等级最高到 P1。 */
  function forStage(list, stage) {
    if (stage !== 'P') return list;
    return list.map((f) => ({ ...f, sev: f.sev === 'P0' ? 'P1' : f.sev, title: f.title.startsWith('估计：') ? f.title : '估计：' + f.title }));
  }
  function sortFindings(list) { return list.slice().sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || a.rule.localeCompare(b.rule)); }
  LP.vrules = { RULES, rule, finding, forStage, sortFindings, SEV_ORDER };
})(globalThis.LP = globalThis.LP || {});
