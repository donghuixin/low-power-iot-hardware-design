/*
 * engine.js — 把卫星贴放、规则、指标串成一次完整评估；定义八个引导步骤。不依赖 DOM。
 */
(function (LP) {
  'use strict';
  const M = LP.model;

  /** 步骤顺序与 references/07-layout.md 第 2 节一致。 */
  const STEPS = [
    { id: 1, key: 'board', title: '板框', roles: [], hint: '设定外形、尺寸、固定孔和禁布区。外形由外壳决定，先定下来再放器件。' },
    { id: 2, key: 'structure', title: '结构定位件', roles: ['connector', 'button', 'led', 'battery'], hint: '连接器、按键、LED、电池的位置由外壳开孔决定，先放它们；放好后按 L 锁定。' },
    { id: 3, key: 'antenna', title: '天线', roles: ['antenna', 'rf_module'], hint: '放在板边或板角，馈点朝向板内。青色净空区内所有层都不能有铜和器件。' },
    { id: 4, key: 'sensors', title: '受物理约束的传感器', roles: M.SENSOR_ROLES, hint: 'IMU 远离板边、螺丝、连接器和热源；温湿度放板边并远离热源；磁力计远离电感和电池。' },
    { id: 5, key: 'mcu', title: '主控', roles: ['soc_rf', 'mcu'], hint: '靠近天线让馈线最短，再旋转到各接口朝向对应外设。晶体和去耦电容会自动跟随。' },
    { id: 6, key: 'power', title: '电源链', roles: ['dcdc', 'ldo', 'charger', 'inductor'], hint: '沿电流方向排开：输入 → 充电 → 稳压 → 负载。电感和开关稳压器远离天线、晶体和敏感传感器。' },
    { id: 7, key: 'others', title: '其余主器件', roles: ['flash', 'motor_driver', 'other'], hint: '存储器、驱动等放在所连接口附近，不要挡住主控的出线。' },
    { id: 8, key: 'check', title: '检查与导出', roles: [], hint: '逐条处理剩余问题，看层数建议，然后导出布局 JSON 交回 skill 评审。' },
  ];
  function stepOfRole(role) { return (STEPS.find((s) => s.roles.includes(role)) || STEPS[6]).id; }

  function stepStatus(p, issues, opts) {
    const bad = (refs) => issues.some((i) => ['P0', 'P1', 'P2'].includes(i.severity) && i.refs.some((r) => refs.includes(r)));
    const allPlaced = p.parts.every((x) => x.placed);
    return STEPS.map((s) => {
      if (s.key === 'board') return { id: s.id, state: opts && opts.boardConfirmed ? 'done' : 'todo', parts: [] };
      if (s.key === 'check') {
        const blocking = issues.filter((i) => i.severity === 'P0' || i.severity === 'P1').length;
        return { id: s.id, state: allPlaced && !blocking ? 'done' : 'todo', parts: [], blocking };
      }
      const parts = p.parts.filter((x) => s.roles.includes(x.role)).map((x) => x.ref);
      if (!parts.length) return { id: s.id, state: 'skip', parts };
      const placed = parts.every((r) => M.partByRef(p, r).placed);
      return { id: s.id, state: placed && !bad(parts) ? 'done' : placed ? 'issues' : 'todo', parts };
    });
  }

  /** 完整评估。会就地更新未固定卫星的位置。 */
  function evaluate(p, opts) {
    const satResults = LP.satellites.placeAll(p);
    const zones = LP.rules.zones(p);
    const issues = LP.rules.check(p, satResults);
    const metrics = LP.metrics.evaluate(p, satResults, zones);
    const halos = LP.satellites.halos(p);
    return {
      satResults, zones, issues, metrics, halos,
      unplacedParts: p.parts.filter((x) => !x.placed).map((x) => x.ref),
      unplacedSats: Object.entries(satResults).filter(([, r]) => r.considered && !r.placed).map(([k]) => k),
      steps: stepStatus(p, issues, opts),
    };
  }

  LP.engine = { STEPS, stepOfRole, stepStatus, evaluate };
})(globalThis.LP = globalThis.LP || {});
