# 交互式布局规划器

布局规划器是一个可离线打开的单文件网页（`assets/layout-planner.html`）。用户在网页里摆放主器件，去耦电容、晶体、匹配网络等卫星器件自动贴放，页面实时给出布线复杂度估计和规则问题；摆好后导出布局 JSON，交回 skill 做阶段三的 Layout 评审。

它位于阶段二（原理图）之后、阶段三（Layout 评审）之前，闭环是：

1. skill 根据原理图写出项目 JSON，用 `scripts/make_layout_project.py` 生成该项目专用的页面，交给用户。
2. 用户在页面里摆放主器件、查看反馈，导出布局 JSON。
3. skill 读回布局 JSON，按阶段三的格式给出评审意见，并把摆放结果作为正式 layout 的起点。

## 目录
1. 何时使用
2. 生成页面
3. 从原理图写出项目 JSON
4. 项目 JSON 格式
5. 页面功能
6. 指标与阈值
7. 卫星器件的贴放策略
8. 默认规则
9. 解读导出结果
10. 局限
11. 开发与测试

## 1. 何时使用

适合：主器件在 5 个以上、板子空间紧、含射频或传感器放置约束、需要和用户一起比较几种摆法时。

可以跳过：器件很少；布局已完全由结构决定；用户已经在 EDA 里画完 layout（这时直接走阶段三评审）。

## 2. 生成页面

```bash
python scripts/make_layout_project.py my-project.json             # 生成 my-project-layout.html
python scripts/make_layout_project.py my-project.json --check     # 只校验
```

校验失败时逐条列出字段路径和原因（例如 `nets[3].pins[1]: 位号 U9 不存在`），改正后重新生成。生成的 HTML 是单文件，双击即可在浏览器中打开，运行时不访问网络。用 `SendUserFile` 或放进用户的项目目录交给用户，并告诉用户摆好后从"导出 → 布局 JSON"导出、发回来。

`assets/layout-planner.html` 本身内置示例项目，可以直接打开试用。修改页面源码（`assets/layout-planner/src/`）后需重新构建：`python scripts/build_layout_planner.py`。

## 3. 从原理图写出项目 JSON

这是工具的输入来源，按以下步骤从原理图和器件手册整理。

1. **板框**：外形尺寸、圆角、固定孔（位置与孔径）、外壳卡扣或电池仓等禁布区、层数、板厚、线宽线距（取板厂常规能力）、是否允许双面贴装。
2. **划分主器件与卫星器件**：
   - 主器件：用户需要决定位置的器件——主控/SoC、射频模组、天线、传感器、存储器、电源芯片、功率电感、电池、连接器、按键、LED。
   - 卫星器件：位置由所属引脚决定的小件——去耦与储能电容、晶体与负载电容、射频匹配元件、DCDC 的电感和输入输出电容、源端串阻、ESD 器件、上下拉和分压电阻。
   - 判断标准：如果答案是"放在某个引脚旁边越近越好"，它就是卫星。
3. **主器件的外形与引脚组**：从封装图取本体外形尺寸 `w × h`（mm，器件未旋转、正面朝上时 x 方向为 w）和高度 `z`。把引脚按功能归组（如 SPI 四根为一组），记下每组所在的边（N/E/S/W，以封装图正视方向为准）、沿边的相对位置 `pos`（N/S 边从左到右为 0→1，E/W 边从上到下为 0→1）和根数 `count`。BGA 等从底部中心出线的器件用 `side: "C"`。
4. **网络**：每个接口一组，`pins` 列出连接的 `[位号, 引脚组]`；`width` 是这组包含的线数；`class` 按信号性质选：`rf`、`power`、`switch_node`、`high_speed`、`analog`、`clock`、`bus`、`misc`。地网络不写（默认有完整地平面）。射频馈线写 `max_len`（默认 10 mm）。
5. **卫星器件**：`parent` 写 `[主器件位号, 引脚组]`；`kind` 按用途选；封装尺寸写 `w × h`；电容写 `value`（同一引脚组的去耦电容按容值从小到大贴放，小容值最近）。晶体的负载电容用 `near` 指向晶体，DCDC 输出电容用 `near` 指向电感。射频匹配元件按"主控 → 天线"的顺序列出。
6. **规则参数**：天线净空区按天线手册填在天线器件的 `keepout`（局部方向的四边距离）；去耦距离、馈线长度等需要按手册收紧或放宽时，在 `rules` 中覆盖（见第 8 节）。不确定的保留默认值，并告诉用户这是典型值。
7. 用 `--check` 校验，再生成页面。

## 4. 项目 JSON 格式

长度单位 mm，角度为度，坐标原点在板框左下角，x 向右、y 向上。完整示例见 `assets/layout-project-example.json`。

```json
{
  "version": 1,
  "name": "BLE IMU 节点",
  "board": {
    "outline": { "type": "rect", "w": 36, "h": 28, "corner_r": 3 },
    "layers": 4, "thickness": 1.0, "track": 0.15, "space": 0.15, "via_d": 0.45,
    "two_sided": true,
    "holes": [{ "x": 3.5, "y": 25, "d": 2.2 }],
    "keepouts": [{ "x": 0, "y": 18, "w": 6, "h": 4, "reason": "外壳卡扣" }],
    "mask": "green"
  },
  "parts": [
    { "ref": "U1", "role": "soc_rf", "label": "BLE SoC", "w": 6, "h": 6, "z": 0.85, "shape": "qfn",
      "sides": ["top"], "locked": false, "heat_mw": 0,
      "pins": [{ "id": "RF", "side": "N", "pos": 0.85, "count": 1 },
               { "id": "VDD", "side": "W", "pos": 0.9, "count": 4 }],
      "placed": null },
    { "ref": "ANT1", "role": "antenna", "w": 5, "h": 2,
      "pins": [{ "id": "FEED", "side": "W", "pos": 0.5 }],
      "keepout": { "N": 3, "S": 3, "E": 4, "W": 0 } }
  ],
  "nets": [
    { "name": "RF_FEED", "class": "rf", "max_len": 10, "pins": [["U1", "RF"], ["ANT1", "FEED"]] }
  ],
  "satellites": [
    { "ref": "C1", "kind": "decoupling", "parent": ["U1", "VDD"], "w": 1.0, "h": 0.5, "value": "100nF", "max_dist": 2.0 }
  ],
  "rules": []
}
```

| 字段 | 说明 |
|---|---|
| `board.outline` | `rect`（`w`、`h`、`corner_r`）、`circle`（`d`）或 `polygon`（`points: [[x, y], …]`）。矩形和圆形可在页面中拖动改尺寸 |
| `board.mask` | 阻焊颜色：`green`、`blue`、`black`、`white` |
| `parts[].role` | `soc_rf`、`mcu`、`rf_module`、`antenna`、`imu`、`magnetometer`、`temp_humidity`、`barometer`、`microphone`、`optical`、`dcdc`、`ldo`、`charger`、`inductor`、`battery`、`connector`、`button`、`led`、`flash`、`motor_driver`、`other`。决定造型、所属引导步骤和默认规则 |
| `parts[].shape` | 可选，覆盖默认造型：`qfn`、`bga`、`lga`、`dfn`、`uson`、`sot`、`soic`、`module`、`chip_antenna`、`pcb_antenna`、`coin`、`pouch`、`usb_c`、`header`、`fpc`、`inductor`、`button`、`led`、`mic`、`optical` |
| `parts[].sides` | 允许放置的面，默认 `["top"]`；只能放背面的写 `["bottom"]` |
| `parts[].edge` / `edge_face` | `edge: true` 表示必须贴板边（天线、连接器默认为真，调试口等可设为 `false`）；`edge_face` 指定开口所在的局部边，要求该边朝外 |
| `parts[].through` | 两面都占用的器件（通孔连接器等） |
| `parts[].heat_mw` | 发热功率；大于 50 mW 视为热源（充电芯片、LDO 默认是热源） |
| `parts[].keepout` | 天线净空区四边距离（局部方向），缺省为三边 3 mm、馈点一侧 0 |
| `nets[].class` | 见第 3 节；`width` 为线数；`max_len` 为长度上限 |
| `satellites[].kind` | `decoupling`、`bulk`、`crystal`、`xtal_load`、`rf_match`、`dcdc_inductor`、`dcdc_cap`、`series_r`、`esd`、`pull`、`divider` |
| `satellites[].near` | 贴近另一个卫星（负载电容贴晶体、输出电容贴电感） |
| `satellites[].max_dist` | 距离上限，缺省按类别：去耦 2、储能 5、晶体 4、负载电容 2、匹配偏离馈线 1、DCDC 电感 3、DCDC 电容 2、串阻 3、ESD 3、上下拉/分压 6 |
| `placed` | `null` 或 `{x, y, rot, side}`。卫星另有 `pinned: true` 表示用户手动固定 |

## 5. 页面功能

- **默认 2D 俯视**，Canvas 绘制、不依赖 WebGL，打开即可交互；工具条正中的"2D | 3D"按钮（快捷键 T）切换到 3D，Three.js 在第一次切换时才加载。两种视图共用数据和交互。
- **单击拾取**：单击托盘或板上的器件把它拿起来，光标隐藏、由器件本身代替；它的卫星器件跟着悬浮，沿两条倾斜的椭圆轨道环绕。再次单击落地，卫星从轨道飞落到自动贴放的位置。拾取中按 R 或右键旋转，点托盘放回，Esc 取消。也可以按住拖动。
- **吸附与对齐**：0.5 mm 网格，按住 Alt 关闭；靠近板边时优先吸到距板边 0.3 mm；与其他器件的边和中线对齐时显示参考线。
- **落点反馈**：合法为青绿色，会挤占其他器件的卫星位置或进入天线净空区为琥珀色，重叠、出板、压孔、进禁布区为红色并抖动；松手后回到拖动路径上最后一个合法位置。
- **不画飞线**：连接关系只用于计算。选中或拿起器件时，与它相连的器件轮廓按网络类别着色提亮；关键网络超长时两端器件轮廓琥珀色缓慢闪烁。
- **八步引导**：板框 → 结构定位件 → 天线 → 受物理约束的传感器 → 主控 → 电源链 → 其余主器件 → 检查与导出，顺序同 `07-layout.md` 第 2 节。步骤不强制，所有规则通过时步骤打勾。
- **评估面板**：六项指标（第 6 节），每项带状态、刻度条和一句含义，点击后在画面中高亮对应对象；"本次移动"说明每次操作前后的变化和原因；问题列表按 P0–P3 排序，带清单编号和改法，点击定位。
- **朝向建议**：选中器件时试算另外三个朝向，明显更好时显示半透明的幽灵朝向，Enter 采纳。
- **图层**：天线净空区、板边应力带、热源影响圈、电感磁场圈、拥挤热力图、卫星器件、外晕、网格。拖动相关器件时，相关区域会自动淡入。
- **其他**：翻板（B）查看背面；撤销/重做；锁定；方向键微调；深浅主题与阻焊颜色；窄屏下左右面板变为抽屉；触屏单指拖动、双指缩放平移；尊重系统的"减少动态效果"设置；状态自动保存在浏览器本地，存储不可用时提示手动导出。
- **导出**：布局 JSON（交回 skill）、位置表 CSV（EDA 摆放起点）、2D 快照 PNG（贴进评审报告）。

## 6. 指标与阈值

所有指标是启发式估计，用于比较两种摆法，不等于实际布线结果。阈值在 `metrics.js` 的 `CONFIG` 中。

| 指标 | 算法 | 良好 / 留意 / 需处理 |
|---|---|---|
| 总线长 | 每个网络在引脚组位置上求最小生成树（曼哈顿距离），边长 × 线数求和 | 归一化值 = 总线长 ÷ (总线数 × √板面积)：≤ 0.6 / ≤ 1.0 / 更大 |
| 交叉 | 生成树边两两求交，同网络不计，每处按两组线数的较小者计 | 每 cm² 交叉数：≤ 1.0 / ≤ 2.5 / 更大 |
| 拥挤度峰值 | 1 mm 网格；每条边的需求平摊到两条 L 形路径；格子容量 = 可用层数 × 1 mm ÷ (线宽 + 线距)，器件占用处该面容量按覆盖比例扣除（电池座、模组等大件本体下按一半），禁布区与天线净空区为零；引脚所在格子不计 | 峰值 ≤ 70% / ≤ 100% / 更大 |
| 关键网络 | 有 `max_len` 的网络（射频默认 10 mm）与全部卫星的距离上限 | 全部达标 / 超限均在 1.5 倍以内 / 其他 |
| 出线压力 | 引脚总数 ≥ 8 的器件，每条边需穿出的线数 ÷ 外侧 3 mm 内可用通道数（自身卫星按半占用，4 层以上 × 1.5） | ≤ 60% / ≤ 100% / 更大 |
| 层数建议 | 有射频网络、按 2 层估算的拥挤峰值 > 100% 或交叉密度 > 2.5 个/cm² 时建议 4 层；否则提示 2 层可行及其前提 | 建议层数不超过当前层数为良好 |

已知近似：引脚按组近似，多引脚器件的交叉数偏乐观；地网络不建模，默认有完整地平面——2 层板上这一假设不成立，层数建议里会提醒；拥挤度按平摊估算，反映相对松紧而不是能否布通。

## 7. 卫星器件的贴放策略

每次主器件放下、旋转或换面后重算；拖动过程中不重算。

1. 按优先级占位：去耦（同组内小容值优先）→ 晶体与负载电容 → 射频匹配 → DCDC 电感与电容 → 串阻 → ESD → 储能 → 上下拉与分压。
2. 候选位：所属引脚组外侧的三圈、沿边滑动、两种朝向；允许双面贴装时还有引脚正下方的背面位置。
3. 代价 = 到引脚的距离 + 沿边偏移 + 堵塞父器件其他引脚出线通道的面积 + 背面惩罚（去耦小、晶体大、射频匹配禁止）+ 远离对象惩罚（DCDC 电感远离天线、磁力计和晶体 8 mm，晶体远离天线和开关电源 4 mm）。与器件重叠、出板、进禁布区或天线净空区的位置不可用。取代价最小且在距离上限内的位置。
4. 射频匹配沿"射频引脚 → 天线馈点"的连线排成一串，靠天线一端。
5. 找不到距离上限内的位置时，放在最近的可用位置并标红，问题里写明挡路的器件和建议移开的距离，例如"C3 距 U1 的 VDD 引脚 3.4 mm，超过 2 mm；U1 左侧被 L10 占用"，改法"把 L10 移开约 2.0 mm"。完全无处可放时留在托盘并报 P1。
6. 用户在"更多 → 编辑卫星"里拖过的卫星标记为手动固定，不再自动移动，直到点"恢复自动"。

## 8. 默认规则

规则是数据（`rules.js` 的 `DEFAULT_RULES`），每条带级别和 `checklists.md` 编号。默认参数是典型值；器件手册给出具体数值时在项目 JSON 中覆盖：

```json
"rules": [
  { "id": "imu_edge", "min": 5 },
  { "id": "inductor_antenna", "min": 10 },
  { "id": "temp_edge", "disabled": true },
  { "type": "min_distance", "id": "mic_motor", "a": { "roles": ["microphone"] }, "b": { "roles": ["motor_driver"] }, "min": 8, "severity": "P2", "check": "SEN-04" }
]
```

| 规则 id | 内容 | 默认 | 级别 | 编号 |
|---|---|---|---|---|
| `overlap` / `inside_board` | 不重叠、不出板、不入禁布区、不压固定孔 | — | P0 | DFM-06 |
| `edge_min_all` | 器件距板边（贴边器件除外） | ≥ 0.5 mm | P1 | DFM-06 |
| `antenna_edge` | 天线贴板边或板角 | ≤ 0.5 mm | P1 | RF-01 |
| `antenna_keepout` | 天线净空区内无器件 | 三边 3 mm | P1 | RF-01 |
| `antenna_metal` | 天线距电池、连接器、屏蔽件 | ≥ 5 mm | P1 | RF-03 |
| `rf_feed_len` | 射频馈线长度 | ≤ 10 mm | P2 | RF-04 |
| `imu_edge` / `imu_stress` / `imu_heat` | IMU 距板边 / 孔、连接器、按键 / 热源 | ≥ 3 / 5 / 5 mm | P2 | SEN-01 |
| `temp_edge` / `temp_heat` | 温湿度贴边 / 远离热源 | ≤ 3 / ≥ 8 mm | P3 / P2 | SEN-02 |
| `xtal_heat` / `xtal_noise` | 晶体远离热源 / 天线与开关电源 | ≥ 4 mm | P2 | SI-04 |
| `mag_sources` | 磁力计远离电感、电池、电机驱动 | ≥ 10 mm | P1 | SEN-03 |
| `inductor_antenna` / `inductor_sensitive` | 电感远离天线 / 晶体与敏感传感器 | ≥ 8 / 4 mm | P1 / P2 | PI-03 |
| `connector_edge` | 连接器、侧按键贴边且开口朝外 | ≤ 0.5 mm | P0 | ASM-02 |
| `heat_battery` | 热源远离电池 | ≥ 5 mm | P2 | THM-01 |
| `satellite_distance` | 卫星距离上限（按类别） | 见第 4 节 | 按类别 | PI-04、SI-04、RF-05、PI-01、PI-06、EMC-01、SI-02、SI-05 |
| `power_flow` | 电源链沿电流方向排列 | — | P3 | LAY-03 |

## 9. 解读导出结果

导出的布局 JSON = 项目数据（每个器件和卫星都带 `placed`）+ `result`：

```json
"result": {
  "tool_version": "1.0.0",
  "metrics": { "total_length_mm": 205.1, "crossings": 6, "congestion_peak": 0.67, "critical_violations": 0,
               "exit_pressure_max": 0.42, "statuses": { "length": "good", "crossings": "good", "congestion": "good" },
               "details": { "nets": [], "crossing_pairs": [], "critical": [], "exit_pressure": [] } },
  "layer_suggestion": { "layers": 4, "reasons": ["有射频网络：50 Ω 走线和天线需要完整的参考地平面"] },
  "issues": [{ "severity": "P1", "check": "RF-01", "refs": ["ANT1"], "message": "…", "fix": "…" }],
  "unplaced_parts": [], "unplaced_satellites": []
}
```

读回后：

1. 用 `make_layout_project.py --check` 或直接读 JSON，确认 `unplaced_parts` 为空；不为空时先请用户摆完。
2. 把 `issues` 按阶段三报告的格式转写进问题列表（位置写位号，后果和改法沿用或补充），并核对规则参数是否用了手册值。
3. 用 `metrics` 写"布线可行性"一节：交叉对、拥挤峰值附近的器件、出线压力最大的边、层数建议及其理由；说明这些是估计值。
4. 页面不检查的项目照常按 `07-layout.md` 和清单评审：叠层与阻抗、地平面完整性、走线几何、DFM 细节、与外壳的 3D 干涉等。
5. 需要在 EDA 中落地时，把 `placed` 坐标（或用户导出的位置表 CSV）作为摆放起点；注意 EDA 的坐标原点和旋转方向可能不同。

## 10. 局限

- 不是布线器，不做 DRC，不替代 EDA 中的规则检查。
- 引脚按组近似，器件按矩形外形处理，旋转只支持 90° 的整数倍。
- 默认规则参数是典型值；天线净空、去耦距离等以器件手册为准。
- 地平面、叠层、阻抗、过孔和走线几何不在页面中建模。
- 后续方向：从 KiCad 或嘉立创 EDA（见 `11-eda-mcp-setup.md`）自动读取网表和封装生成项目数据；把摆放结果写回 EDA。

## 11. 开发与测试

源码在 `assets/layout-planner/src/`：`index.html`、`style.css` 与 `js/` 下的模块。计算模块不依赖 DOM：`geometry.js`、`model.js`、`rules.js`、`satellites.js`、`metrics.js`、`engine.js`；界面模块：`render2d.js`、`render3d.js`、`app.js`、`interaction.js`、`ui.js`、`main.js`；文案集中在 `strings.js`。Three.js r170 放在 `assets/layout-planner/vendor/`（MIT），构建时以不执行的文本内联，切到 3D 时才加载。

```bash
python scripts/build_layout_planner.py          # 构建单文件 assets/layout-planner.html
node --test tests/*.test.js                     # 计算模块的单元测试（Node 18+，无第三方依赖）
```

开发时可用 `python -m http.server` 打开 `assets/layout-planner/src/index.html`（直接用 `file://` 打开源码目录时无法读取示例数据与 Three.js，构建产物没有这个限制）。
