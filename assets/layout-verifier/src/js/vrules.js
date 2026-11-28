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
    'VF-15': { name: '绕线过长', sev: 'P3', max_ratio: 1.3, slack_mm: 2, check: 'RT-05' },
    // 布线几何与质量（scripts/route_lint.py 计算，结果在铜皮数据包 checks.routing；规则见 references/16-routing-constraints.md）
    'VF-16': { name: '任意角度走线', sev: 'P1', weight: 15, check: 'RTG-01' },
    'VF-17': { name: '锐角与直角', sev: 'P1', weight: 10, check: 'RTG-02' },
    'VF-18': { name: '短段、抖动与出线', sev: 'P2', weight: 8, check: 'RTG-05' },
    'VF-19': { name: '多余拐弯', sev: 'P3', weight: 8, check: 'RTG-06' },
    'VF-20': { name: '过孔预算', sev: 'P2', weight: 10, check: 'RTV-01' },
    'VF-21': { name: '地平面完整性', sev: 'P1', weight: 12, check: 'RTY-05' },
    'VF-22': { name: '绕行率', sev: 'P2', weight: 8, check: 'RTL-01' },
    'VF-23': { name: '成束整齐度', sev: 'P3', weight: 7, check: 'RTS-03' },
    'VF-24': { name: '层方向与层使用', sev: 'P2', weight: 6, check: 'RTY-02' },
    'VF-25': { name: '走线密度', sev: 'P3', weight: 6, check: 'RTS-05' },
    'VF-26': { name: '网络类约束', sev: 'P1', weight: 10, check: 'RTW-01' },
    'VF-27': { name: '布线质量总分', sev: 'P3', min_score: 75, check: 'RT-08' },
    // 走线原则（scripts/route_principles.py；references/17-routing-principles.md）
    'VF-28': { name: '差分对', sev: 'P1', weight: 8, check: 'RTD-02' },
    'VF-29': { name: '就近', sev: 'P1', weight: 8, check: 'RTP-01' },
    'VF-30': { name: '优先级与隔离', sev: 'P2', weight: 6, check: 'RTO-01' },
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
