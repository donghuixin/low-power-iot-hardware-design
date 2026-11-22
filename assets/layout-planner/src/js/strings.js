/*
 * strings.js — 界面与规则文案（简体中文）。所有用户可见文字集中在这里，便于日后增加英文。
 * 模板中的 {name} 由 LP.t(key, params) 替换。
 */
(function (LP) {
  'use strict';

  const S = {
    // ---------- 规则：问题文案与改法 ----------
    rule: {
      overlap:        { msg: '{a} 与 {b} 重叠', fix: '把其中一个移开，器件之间至少留出装配间距。' },
      outside_board:  { msg: '{a} 超出板框', fix: '把 {a} 移回板内。' },
      in_keepout:     { msg: '{a} 进入禁布区（{reason}）', fix: '把 {a} 移出禁布区。' },
      on_hole:        { msg: '{a} 压在固定孔上', fix: '把 {a} 移开固定孔，留出螺丝头和垫片的位置。' },
      edge_min_all:   { msg: '{a} 距板边 {d} mm，小于 {min} mm：分板和装配时容易损伤', fix: '把 {a} 往板内移约 {need} mm。' },
      antenna_edge:   { msg: '{a} 距板边 {d} mm，没有贴板边：天线被地平面和器件包围，辐射效率下降', fix: '把 {a} 移到板边或板角，馈点朝向板内。' },
      connector_edge: { msg: '{a} 没有贴板边或开口没有朝外：线缆插不进外壳开孔', fix: '把 {a} 移到板边，开口一侧朝外（R 键旋转）。' },
      temp_edge:      { msg: '{a} 距板边 {d} mm：远离板边时更容易受板上热量影响', fix: '把 {a} 放到板边 3 mm 以内，周围可开隔热槽。' },
      antenna_keepout:{ msg: '{b} 进入 {a} 的天线净空区：净空区内所有层都不应有铜和器件', fix: '把 {b} 移出青色区域。' },
      antenna_metal:  { msg: '{b} 距天线 {a} {d} mm，小于 {min} mm：大块金属会使天线失谐', fix: '把 {b} 移到离天线至少 {min} mm 的位置，或把天线移到另一侧板边。' },
      rf_feed_len:    { msg: '射频馈线 {net} 约 {len} mm，超过 {limit} mm：馈线损耗和失配增加', fix: '把主控的射频引脚一侧靠近天线馈点。' },
      net_len:        { msg: '网络 {net} 约 {len} mm，超过 {limit} mm', fix: '缩短 {net} 两端器件的距离。' },
      imu_edge:       { msg: '{a} 距板边 {d} mm，小于 {min} mm：板边应力会使零偏漂移', fix: '把 {a} 往板内移约 {need} mm。' },
      imu_stress:     { msg: '{a} 距 {b} {d} mm，小于 {min} mm：螺丝、连接器和按键的受力会传到 IMU', fix: '把 {a} 移开 {b} 约 {need} mm。' },
      imu_heat:       { msg: '{a} 距热源 {b} {d} mm，小于 {min} mm：温度梯度使零偏漂移', fix: '把 {a} 远离 {b} 约 {need} mm。' },
      temp_heat:      { msg: '{a} 距热源 {b} {d} mm，小于 {min} mm：测到的是板上的热而不是环境温度', fix: '把 {a} 移到远离 {b} 的板边。' },
      xtal_heat:      { msg: '{a} 距热源 {b} {d} mm，小于 {min} mm：温度变化会引起频偏', fix: '把主控的晶体一侧转离 {b}，或移开 {b}。' },
      mag_sources:    { msg: '{a} 距 {b} {d} mm，小于 {min} mm：电流和磁性材料会干扰磁场测量', fix: '把 {a} 移开 {b} 约 {need} mm。' },
      inductor_antenna:{ msg: '{a} 距天线 {b} {d} mm，小于 {min} mm：电感的开关噪声会降低接收灵敏度', fix: '把电源链或主控的电感一侧移到板子另一端。' },
      inductor_sensitive:{ msg: '{a} 距 {b} {d} mm，小于 {min} mm：电感漏磁会耦合到敏感器件', fix: '把 {a} 与 {b} 拉开约 {need} mm。' },
      xtal_noise:     { msg: '晶体 {a} 距 {b} {d} mm，小于 {min} mm：噪声会耦合进振荡回路', fix: '把主控转个方向，让晶体一侧远离 {b}。' },
      heat_battery:   { msg: '热源 {a} 距电池 {b} {d} mm，小于 {min} mm：电池温升影响安全和寿命', fix: '把 {a} 移开电池约 {need} mm。' },
      power_flow:     { msg: '电源链顺序不顺：{reg} 比 {chg} 离 {main} 更远', fix: '沿电流方向排列：输入 → {chg} → {reg} → {main}。' },
      sat_unplaced:   { msg: '{a}（{kind}）在板上找不到位置', fix: '在 {parent} 周围腾出空间，或允许双面贴装。' },
      sat_far:        { msg: '{text}', fix: '{fix}' },
      antenna_unplaced:{ msg: '{a}（射频匹配）等待天线摆放', fix: '先摆放天线。' },
    },

    // ---------- 卫星贴放说明 ----------
    sat: {
      far_blocked: '{a} 距 {parent} 的 {pin} 引脚 {d} mm，超过 {limit} mm；{parent} {side}侧被 {blocker} 占用',
      far_blocked_fix: '把 {blocker} 移开约 {move} mm。',
      far_crowded: '{a} 距 {parent} 的 {pin} 引脚 {d} mm，超过 {limit} mm；{parent} {side}侧已被其他卫星器件占满',
      far_crowded_fix: '把 {parent} 周围的主器件移开一些，或允许双面贴装。',
      far_plain: '{a} 距 {parent} 的 {pin} 引脚 {d} mm，超过 {limit} mm',
      far_plain_fix: '在 {parent} 的 {pin} 引脚附近腾出空间。',
      rf_offline: '{a} 偏离射频馈线 {d} mm：匹配网络应沿主控射频引脚到天线馈点排成一串',
      rf_offline_fix: '在主控与天线之间留出一条直通的空间。',
      near_far: '{a} 距 {near} {d} mm，超过 {limit} mm',
      near_far_fix: '在 {near} 周围腾出空间。',
    },

    sideCN: { N: '上', S: '下', E: '右', W: '左' },
  };

  function t(key, params) {
    const parts = key.split('.');
    let v = S;
    for (const k of parts) { v = v && v[k]; }
    if (typeof v !== 'string') return key;
    return v.replace(/\{(\w+)\}/g, (m, k) => (params && params[k] !== undefined ? String(params[k]) : m));
  }

  LP.S = S;
  LP.t = t;
})(globalThis.LP = globalThis.LP || {});
