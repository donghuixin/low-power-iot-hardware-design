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

    // ---------- 界面 ----------
    ui: {
      title: 'PCB 布局规划',
      zone_antenna: '天线净空区',
      undo: '撤销', redo: '重做',
      op_place: '摆放', op_rotate: '旋转', op_flip: '换面', op_move: '移动', op_lock: '锁定', op_unlock: '解锁',
      op_unplace: '放回托盘', op_pin_sat: '手动摆放卫星', op_unpin_sat: '卫星恢复自动', op_unpin_all: '全部卫星恢复自动',
      op_board: '修改板框', op_reset: '重置布局',
      toast_locked: '{ref} 已锁定，按 L 解锁后再移动',
      toast_illegal_outside: '{ref} 会超出板框',
      toast_illegal_overlap: '{ref} 会与 {with} 重叠',
      toast_illegal_keepout: '{ref} 会进入禁布区（{with}）',
      toast_illegal_hole: '{ref} 会压在固定孔上',
      toast_reverted: '，已回到上一个合法位置',
      toast_single_sided: '当前板子只允许单面贴装，不能换面',
      toast_side_not_allowed: '{ref} 不能放在{side}',
      toast_halo: '挤占了 {with} 的{kind}位置，卫星器件已重新贴放',
      toast_no_room: '板上找不到能放下 {ref} 的位置',
      side_top: '正面', side_bottom: '背面',
      drag_warn_halo: '会挤占 {with} 的{kind}位置',
      drag_warn_antenna: '会进入 {with} 的天线净空区',

      m_length: '总线长', m_length_desc: '走线总量；越短越好布、寄生越小',
      m_length_top: '最长的网络是 {net}，约 {len} mm（{w} 根线）',
      m_crossings: '交叉', m_crossings_desc: '约等于换层次数；双层板上每个交叉都要一对过孔',
      m_crossings_none: '没有交叉',
      m_congestion: '拥挤度峰值', m_congestion_desc: '哪里走不出线', m_congestion_over: '超过容量的区域占 {p}；点击查看热力图',
      m_critical: '关键网络', m_critical_desc: '射频馈线、晶体、去耦、电源回路是否够短',
      m_critical_ok: '{n} 项均达标', m_critical_bad: '{n} 项超限', m_critical_all_ok: '关键网络全部达标',
      m_exit: '出线压力', m_exit_desc: '多引脚器件的某一侧是否被堵住', m_exit_where: '{ref} {side}侧：{need} 根线，约 {ch} 条通道',
      m_layers: '层数建议', m_layers_desc: '成本影响；点击查看理由', m_layers_value: '{n} 层',
      status_good: '良好', status_warn: '留意', status_bad: '需处理',
      metrics: '布线复杂度', delta: '本次移动', issues: '问题',
      delta_none: '放下或旋转器件后，这里会说明指标的变化和原因。',
      delta_nochange: '指标没有明显变化。',
      issues_none: '没有发现问题。',
      disclaimer: '启发式估计，用于比较方案，不等于实际布线结果。',
      dc_length: '线长 {v} mm', dc_cross: '交叉 {v}', dc_cong: '拥挤 {v}',

      steps: '布局步骤', step_free_order: '可以随时拖任何器件，不必按顺序。',
      step_parts: '要放的器件', step_missing: '还差什么', step_unplaced: '未摆放：{refs}', step_more: '另有 {n} 条，见右侧问题列表',
      step_skip: '本项目没有这类器件，可跳过。', step_done: '本步所有规则通过',
      step_state_todo: '未完成', step_state_issues: '有问题', step_state_done: '已完成', step_state_skip: '不适用',
      board_shape: '外形', board_rect: '矩形', board_circle: '圆形', board_polygon: '多边形（来自项目数据）',
      board_w: '宽 (mm)', board_h: '高 (mm)', board_r: '圆角 (mm)', board_d: '直径 (mm)',
      board_layers: '层数', board_thickness: '板厚 (mm)', board_two_sided: '允许双面贴装', board_mask: '阻焊颜色',
      board_confirm: '确认板框，开始摆放', board_reconfirm: '完成修改',
      board_edit_hint: '也可以拖动板子右边、上边或右上角的圆点直接改尺寸。',
      board_holes: '固定孔 {n} 个、禁布区 {m} 个（在项目数据中编辑）',
      mask_green: '墨绿', mask_blue: '深蓝', mask_black: '哑黑', mask_white: '白色',
      check_unplaced: '还有 {n} 个主器件未摆放：{refs}',
      check_ready: '没有 P0/P1 问题，可以导出。',
      check_blocking: '还有 {n} 条 P0/P1 问题，建议先处理。',
      check_layers: '层数建议：{n} 层',
      check_handback: '把导出的布局 JSON 发回给 Claude，它会按 Layout 评审的格式给出意见。',

      export: '导出', import: '导入项目 JSON…',
      export_json: '布局 JSON（交回 skill 评审）', export_csv: '位置表 CSV', export_png: '2D 快照 PNG',
      export_json_short: '导出布局 JSON', export_csv_short: '位置表 CSV', export_png_short: '快照 PNG',
      import_parse_error: '无法解析这个文件，请确认是 JSON 格式', import_error: '项目数据有 {n} 处问题', import_ok: '已导入 {name}',

      view2d: '2D', view3d: '3D', view3d_loading: '3D…', view3d_nowebgl: '当前浏览器不支持 WebGL，3D 视图不可用', view3d_failed: '3D 视图加载失败，已保留 2D 视图',
      flip: '翻板', flip_on: '看背面', layers: '图层', more: '更多',
      layer_keepout: '天线净空区', layer_edge: '板边应力带', layer_heat: '热源影响圈', layer_magnetic: '电感磁场圈',
      layer_congestion: '拥挤热力图', layer_sats: '卫星器件', layer_halo: '外晕', layer_grid: '网格',
      edit_sats: '编辑卫星（手动拖动小件）', unpin_all: '全部卫星恢复自动',
      reset: '重置布局', reset_confirm: '清空所有摆放？可以用撤销恢复。',
      theme: '主题', theme_light: '浅色', theme_dark: '深色',
      help: '帮助', star: 'Star', star_title: '在 GitHub 上 Star 或 Fork 这个 skill，获取后续更新',
      anim_off: '动效', anim_on: '动效开',
      anim_title_off: '开启动画效果：拾取时卫星环绕、落地回弹与飞落、波纹等',
      anim_title_on: '关闭动画效果（卫星仍静止排在器件周围）',
      anim_title_system: '系统已开启"减少动态效果"，动画不会播放',
      storage_off: '未自动保存，请手动导出', restored: '已恢复上次的摆放',
      panel_steps: '步骤', panel_eval: '评估',

      tray: '器件托盘', tray_hint: '拖到板上；当前步骤要放的器件已高亮', tray_count: '待放 {n} / {total}',
      tray_placed: '已摆放', tray_unplaced_sats: '未能放置的卫星器件',

      act_toolbar: '选中器件的操作', act_rotate: '旋转', act_flip: '换面', act_lock: '锁定', act_unlock: '解锁',
      act_unplace: '放回', act_unpin: '恢复自动', act_sat_hint: '自动贴放；在"更多"中开启编辑卫星可手动拖动',
      suggest: '转 {turn}° 可少 {n} 个交叉', suggest_len: '转 {turn}° 线长可短 {pct}%', suggest_accept: 'Enter 采纳',
      tip_part: '{ref} · {label} · {w}×{h} mm', tip_backside: '（另一面）',
      tip_sat: '{ref} · {kind} {value} → {parent}.{pin} · 距 {d} mm', tip_pinned: ' · 手动固定',
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
