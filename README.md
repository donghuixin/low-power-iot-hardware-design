# low-power-iot-hardware-design

[![GitHub stars](https://img.shields.io/github/stars/donghuixin/low-power-iot-hardware-design?style=social)](https://github.com/donghuixin/low-power-iot-hardware-design/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/donghuixin/low-power-iot-hardware-design?style=social)](https://github.com/donghuixin/low-power-iot-hardware-design/fork)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

一个面向**低功耗物联网硬件**的 Skill：从需求挖掘到原理图、交互式布局规划、Layout、bring-up 的完整设计与评审流程。

A Claude and Codex skill for designing and reviewing low-power IoT hardware: requirements elicitation, wireless and part selection, sensor placement, schematic reliability review, power budgeting, an interactive 2D/3D PCB placement planner, PCB layout review, and bring-up.

> **觉得有用？请点右上角 ⭐ Star，或 Fork 一份自己的副本。** 规则、参考资料和布局规划器会持续更新，Star 方便你收到更新，Fork 方便你保存自己的定制并同步上游。欢迎通过 Issue 和 Pull Request 提交改进。

![交互式布局规划器](docs/images/overview-2d.png)

## 它做什么

| 阶段 | 内容 |
|---|---|
| 1. 需求明确 | 把功能描述变成量化指标；主动提出用户没想到的需求（峰值电流、电池末期、OTA、运输模式、认证、产测……）；把需求映射到硬件形态；无线选型按数据率、吞吐、距离、峰值电流、平均功耗比较；传感器放置约束（例如 IMU 是否需要靠近转动中心） |
| 2. 原理图可靠性 | 逐状态检查每个网络：上拉下拉、开漏/推挽/三态、电平域匹配、断电域反灌；驱动电压与驱动电流；睡眠电流逐项清点与峰值电流压降；电源树、充电、保护、去耦与储能；绘制流程与可读性规范（同页直连、跨页与标准接口用标号/端口、网络命名、文字不重叠、设计意图注释） |
| 2½. 交互式布局规划 | [2D/3D 布局规划器](#交互式布局规划器)：摆放主器件，卫星器件自动贴放，实时估计布线复杂度并按规则给出问题，导出结果交回评审 |
| 2¾. 布局布线验证 | [验证器](#布局布线验证器)：电流与回流、EMI 受扰与平面谐振、温度与散热片对比；布线前按概率估计，布线后从 KiCad / Gerber 提取实际铜皮复核 |
| 3. Layout | 叠层与阻抗、布局顺序、天线与射频、电源完整性、信号完整性、晶体、高阻节点、传感器应力与热隔离、EMC/ESD、热、DFM/DFA/DFT；[布线约束与质量评分](#布线约束与质量评分)：八方向几何、线宽线长过孔层约束、自动检查与修复、写入 EDA 前的闸门；布线实操：逐网顺序、升级阶梯、换层与过孔、绕线判据、自动布线器预期（取自 [CADET](https://github.com/LGAI-Research/CADET) 对 283 块开源 2 层板的统计与实测） |
| 4. Bring-up 与量产 | 上电顺序、功耗实测、常见故障排查（睡眠电流大、射频距离短、偶发复位）、认证与产测 |
| 5. 交互式引导 | 根据使用场景分轮追问，把用户确认的目标转成带单位、工况和验收方法的电路指标，并随反馈更新预算。 |
| 6. 设计资料管理 | 按设计问题请用户提供对应型号的数据手册、参考设计或原理图，记录版本与页码，让关键参数可追溯。 |
| 7. EDA 工具接入 | [设计开始时主动引导安装并验证嘉立创 EDA 或 KiCad 的 MCP](references/11-eda-mcp-setup.md)，在 Codex 或 Claude Code 中读取当前工程。 |

每个阶段输出带严重度分级（P0–P3）的问题列表，每条包含位置、后果和修改建议。

**扩展模块：高性能混合信号与医疗手持。** 设计满足任一门槛（持续功耗 >1 W、>50 MHz 或 LVDS、>50 V、FPGA、ADC ≥10 MSPS、接触人体的医疗用途）时自动启用，例如手持超声。启用后按"高压 / 漏电 / 温升 → 电源噪声 → 时钟 → 高速接口"的顺序评审，在原理图冻结前闭合功耗-热、数据率-存储、噪声-纹波、时钟抖动四项预算，并按混合信号顺序 bring-up。内容见 [`references/20`–`25`](references/20-hv-pulser-tr-safety.md) 和清单 E 段。

## 原理图绘制流程

画原理图时按 [`references/09-schematic-readability.md`](references/09-schematic-readability.md) 的十步走：先框图后分页 → 确认符号 → 按手册典型电路列出卫星器件 → 按信号流向摆放、卫星贴所服务的引脚 → 同页近处直连 → 跨页用标号与端口 → 整理文字互不重叠 → 写设计意图注释 → ERC 清零 → 导出 PDF 通读。下面用 BLE IMU 节点的"主控最小系统"一页演示前八步：

![原理图绘制流程：从框图到设计意图注释](docs/images/schematic-drawing.gif)

## 交互式布局规划器

一个可以离线打开的单文件网页（[`assets/layout-planner.html`](assets/layout-planner.html)，内置示例项目，下载后双击即可试用）。用户只摆核心器件——主控、传感器、天线、连接器、电池和板框；去耦电容、晶体、匹配网络这些小件由算法按最优策略自动贴放。每一步都告诉你这样摆对布线难度有什么影响。

### 单击拾取，卫星跟着环绕

单击托盘或板上的器件把它拿起来，光标由器件本身代替。它的卫星器件——主控周围的去耦电容、晶体及负载电容、射频匹配、DCDC 电感——跟着悬浮起来，沿两条倾斜的轨道环绕。再次单击放下，卫星从轨道飞落，按"离所属引脚最近、不挡出线、远离噪声源"的原则贴到板上最合适的位置。

| 2D | 3D |
|---|---|
| ![2D：单击拾取、卫星环绕、落地贴放](docs/images/planner-satellites.gif) | ![3D：拾取后卫星在立体轨道上环绕，放下时飞落贴放](docs/images/planner-satellites-3d.gif) |

摆到差的位置时，右侧立即给出线长、交叉和拥挤的变化与原因；3D 视图里拾取、旋转、放下的操作与 2D 相同。

拾取中按 `R` 或右键旋转 90°，点托盘放回，`Esc` 取消；习惯拖放的话，按住拖动同样可以。

动画默认关闭，卫星静止跟随被拾取的器件。点工具条上的 **✦ 动效** 即可看到上图的环绕、落地回弹和飞落。两种状态都会在放下主件时计算并保存周边件的实际位置。浏览器记住通常的动效偏好。系统启用“减少动态效果”时，页面初始静止，主动点击可在当前页临时播放，刷新后恢复静止。

### 2D 默认，一键切到 3D

默认是 2D 俯视，用 Canvas 绘制、不依赖 WebGL，打开即可交互。工具条正中醒目的 **2D | 3D** 按钮（快捷键 `T`）切到轻量的 3D 视图：右键拖动旋转视角、滚轮缩放、`B` 翻板看背面。Three.js 只在第一次切换时加载，不影响打开速度。两种视图共用同一份数据和交互，在 3D 里也能拾取、旋转、放下。

| 3D 视图 | 3D 中拾取主控 |
|---|---|
| ![3D 视图](docs/images/view-3d.png) | ![3D 中拾取](docs/images/pick-3d.png) |

### 每一步都有反馈

- **布线复杂度**：总线长、交叉数、拥挤度峰值、关键网络、出线压力、层数建议，每项都有"良好 / 留意 / 需处理"三档和一句含义；点一下指标，画面里高亮对应的器件。规划合格的卫星器件不计入拥挤度，把挤在一起的器件移开，峰值会回落；射频馈线等关键网络按 45° 走线估计长度，"关键网络"一行直接列出超限的是哪几项。
- **本次移动说明原因**：放下或旋转后，器件旁浮起一张小卡片（如"线长 −15.0 mm、交叉 −3"），右侧写明原因，例如"交叉 +2：SPI_IMU 与 VDD 互相穿过"。
- **朝向建议**：选中器件时试算另外三个朝向，明显更好时显示半透明的幽灵朝向，按 `Enter` 采纳。

![朝向建议与移动差值](docs/images/orientation-suggestion.png)

- **规则检查**：天线贴边与净空区、天线远离电池和连接器、射频馈线长度、IMU 远离板边/螺丝/热源、温湿度隔热、磁力计远离电感、电感远离天线与晶体、去耦与晶体距离、连接器开口朝外等。每条问题带 P0–P3 级别、[核对清单](references/checklists.md)编号和改法，点击即定位，并显示相关的规则区域。

![规则反馈：电池压进天线净空区](docs/images/rule-feedback.png)

- **拥挤热力图**：哪里走不出线一目了然（2D 为色块，3D 为柱高）。

![拥挤热力图：Flash 紧贴主控](docs/images/congestion-heatmap.png)

### 其他细节

- **板框形状可改**：矩形/圆角矩形、胶囊形、倒角矩形、L 形、圆形，以及自定义多边形——在板上拖动顶点改形状，双击边加点、双击顶点删点；改形状后固定孔压到板边会提示。**这里的板框只用于摆放规划，布局完成后建议导出板框 DXF 和位置表，导入嘉立创 EDA 再按外壳图纸绘制最终板框。**
- **开场选定板子尺寸**：先在预设（项目原始尺寸、紧凑、常用、宽松、圆形）或自定义尺寸里选好板框，页面按器件总面积提示是否够大，同时决定固定孔：保留项目中的、四角各放一个 M2，或暂不放置；之后仍可在第 1 步或拖动板边修改。
- **固定孔可增删、可拖动**：第 1 步按 M2/M2.5/M3 添加固定孔，自动放到四角或离板边最近的空位；可以逐个改坐标和孔径，展开第 1 步时在板上直接拖动，双击孔或点 × 删除。离板边、器件或其它孔太近时会提示。
- **八步引导**：板框 → 结构定位件 → 天线 → 受物理约束的传感器 → 主控 → 电源链 → 其余主器件 → 检查与导出；步骤不强制，规则通过时打勾。
- **落点反馈**：合法为青绿，挤占别人的卫星位置或进入天线净空区为琥珀，重叠、出板、压孔为红色并抖动；松手后回到最后一个合法位置。
- **吸附与对齐**：0.5 mm 网格（按住 `Alt` 关闭），贴边器件优先吸到距板边 0.3 mm，与其他器件对齐时显示参考线。
- **不画飞线**：连接关系只参与计算，选中器件时相连器件的轮廓按网络类别着色提亮，画面保持干净。
- **导出**：布局 JSON（交回 Claude 做 Layout 评审）、位置表 CSV（EDA 摆放起点）、板框 DXF（导入嘉立创 EDA 作为初始板框）、2D 快照 PNG。
- 撤销/重做、锁定、方向键微调、动效开关（默认关闭）、深浅主题与阻焊颜色、窄屏抽屉、触屏手势、本地自动保存；画面里只有电路板和器件。

### 怎么用

在对话里让 Claude 帮你规划布局（例如"原理图画完了，帮我规划一下 PCB 上器件怎么摆"）。Claude 会：

1. 按 [`references/12-layout-planner.md`](references/12-layout-planner.md) 从原理图整理出项目数据（板框、主器件外形与引脚组、网络、卫星器件、规则参数）；
2. 运行 `python scripts/make_layout_project.py project.json` 生成该项目专用的页面交给你；
3. 你摆好后从"导出 → 布局 JSON"导出发回，Claude 按 Layout 评审的格式给出意见。
4. 把位置表 CSV 和板框 DXF 导入嘉立创 EDA 作为摆放起点，在其中按外壳图纸绘制最终板框、完成布线（Claude 可通过[嘉立创 EDA 的 MCP](references/11-eda-mcp-setup.md)协助操作）。

指标是启发式估计，用于比较不同摆法，不等于实际布线结果；默认规则参数是典型值，器件手册给出具体数值时在项目数据里覆盖。

## 布局布线验证器

和规划器分开的另一个单文件网页（[`assets/layout-verifier.html`](assets/layout-verifier.html)，内置示例，双击即可试用），专门回答"这样摆、这样布，电流怎么走、会不会互相干扰、热不热"。它在布局之后和布线之后各用一次：

- **布线前（估计）**：读入规划器导出的布局 JSON，按引脚朝向和可走通道做概率估计，告诉你供电和回流大概怎么走、哪里会挤、哪个敏感器件离干扰源太近、热点在哪，用来改摆放、指导布线。
- **布线后（简化求解）**：从 KiCad 的 `.kicad_pcb`，或 Gerber + IPC-D-356 网表（嘉立创 EDA、Altium 等）提取真实铜皮，按电源 / 模拟 / 数字 / 射频分组，只解相关的那部分铜皮，查出瓶颈、压降、过孔电流、射频参考平面缺口、并行耦合和地铜孤岛。

计算在后台 Worker 里做，求解器带多重网格预条件，一次分析在几百毫秒内完成；动效可以关，帧耗时高时自动降级。

工具条上的 **2D | 3D** 按钮（快捷键 `T`）把同一份结果搬到立体视图里：左键拖动旋转、右键平移、滚轮缩放、双击复位。Three.js 只在第一次切换时载入，不影响打开速度；"动效"按钮同样控制 3D 里的动画。下面每项功能左边是 2D、右边是 3D。

### 电流与回流

选一个负载，供电从电源起点流过来（暖色），回流从它的地脚流回去（冷色），粒子越亮电流密度越大。高频负载的回流贴着去程走，地平面有缺口时会看到它绕路；右侧给出回路面积、建议线宽、压降和最近的去耦电容。

| 2D | 3D |
|---|---|
| ![2D 电流与回流](docs/images/verifier-current.gif) | ![3D 电流与回流](docs/images/verifier3d-current.gif) |

2D 演示切换负载，以及把叠层假设成 2 层后回流从贴着去程变成走线；3D 里板子半透明，下方分开画出地平面，去程光点在板上流、回流光点在地平面上流。

### 电磁：受扰地图与平面谐振

天线、射频线、开关节点、电感、时钟各自向外扩散，叠加成受扰地图，IMU、晶体、模拟网络等敏感对象按"高 / 中 / 低"脉动提示。切到"平面谐振"，看电源/地平面对的各阶模态起伏的振型、节线和频率，接近射频频段或时钟谐波时标出来。

| 受扰地图 · 2D | 受扰地图 · 3D |
|---|---|
| ![2D 受扰地图](docs/images/verifier-emi.gif) | ![3D 受扰地图](docs/images/verifier3d-emi.gif) |
| **平面谐振 · 2D** | **平面谐振 · 3D** |
| ![2D 平面谐振](docs/images/verifier-plane-modes.gif) | ![3D 平面谐振](docs/images/verifier3d-modes.gif) |

3D 里受扰电平做成起伏的地形，天线处隆起成峰，波纹从干扰源向外扩散；平面谐振是上下起伏的振型曲面，节线固定不动。

### 温度：加散热片前后对比

逐个器件选散热片、改风速、改环境温度、打开密闭外壳，左右分屏对比改动前后，分割线可以拖动，标注直接写出"结温 102 °C → 39 °C"。

| 2D | 3D |
|---|---|
| ![2D 温度对比](docs/images/verifier-thermal.gif) | ![3D 温度对比](docs/images/verifier3d-thermal.gif) |

给 0.9 W 的主控逐级加大散热片：2D 拖动分割线对比；3D 里温度做成高度，加了散热器的器件上会长出散热片，热点上方飘起热气。

### 布线后：从实际铜皮复核

下图是一块布完线的板子：射频线下方的地平面开了槽、两侧地孔围栏太稀、模拟线贴着数字线走了 8 mm、顶层有一块没打孔的地铜，四条都被查出来并在板上定位。

![布线后：实际铜皮上的电流，逐条点开结论在板上定位](docs/images/verifier-routed.gif)

### 怎么用

1. 布局摆好后，让 Claude 生成验证页面：`python scripts/make_layout_project.py 布局.json --verifier`。Claude 会先按 [`references/13-layout-verifier.md`](references/13-layout-verifier.md) 在 `verify` 块里填好负载电流和功耗。
2. 布线完成后，提供 `.kicad_pcb`（铺铜已填充）或 Gerber + 板框 + IPC 网表，Claude 用 `python scripts/extract_copper.py ... -o copper-pack.json` 提取铜皮，再加 `--copper copper-pack.json` 生成页面；也可以直接把数据包拖进页面。
3. "导出报告"得到验证报告 JSON，Claude 把其中的结论（规则 VF-01…VF-27，其中 VF-16…27 是布线几何与质量）并入 Layout 评审。

所有结果都是简化模型的定性结论，相对比较（改动前后、方案 A 与 B）比绝对数值更可靠；不替代 SI/PI/EMC 仿真和实测。

## 设计规则与板厂工艺

线宽画到多细要加钱？0.2 mm 的孔算不算特殊工艺？`scripts/fab_rules.py` 把这些问题变成一次对照：

- **内置嘉立创工艺档案**（[`assets/fab-profiles/jlcpcb.json`](assets/fab-profiles/jlcpcb.json)，检索日期 2026-11-24）：按线宽、线距、过孔归纳成"经济 / 标准 / 加价 / 极限"四档，另有焊环、孔距、板边距、阻焊桥等下限，以及带日期和来源的价格参考。
- **支持自己的板厂**：把工艺表（CSV、Markdown 表格、xlsx 或键值文本）交给 `import`，中英文参数名和 mil / mm 单位自动识别，没认出来的行会列出来。
- **读取设计**：从 KiCad 的 `.kicad_pro`、`.kicad_pcb` 读出网络类、全局下限和板上实际用到的最小线宽、每种过孔规格。
- **对照**：告诉你板子落在哪个价格档、是哪个参数决定的、把哪个数改到多少就能降一档，以及超出能力或自相矛盾的规则。
- **生成**：按目标档位输出 KiCad 自定义规则和四个网络类的建议表。

```text
$ python scripts/fab_rules.py check demo.kicad_pro demo.kicad_pcb
- 按 4 层、1 oz 铜对照
- 价格档位：加价 — 孔 < 0.3 mm 且外径 ≤ 0.4 mm，或 0.15 mm 孔，下单系统加收费用
- 决定档位的参数：过孔 0.25/0.4（孔径/外径）
- 降档办法：改成不小于 0.2/0.45 可回到「标准」档
```

怎么把规则写好（三层规则、成组的网络类、带范围的特例、严格口径验收等八条做法）见 [`references/15-design-rules-and-process.md`](references/15-design-rules-and-process.md)。工艺和价格会调整，下单前以板厂下单系统的实时报价为准。

## 布线约束与质量评分

DRC 只保证走线合法，不保证有序。任意角度的斜线、锐角、锯齿、斜着出焊盘、底层乱穿切碎地，都是把飞线直接画成铜皮的结果。[`references/16-routing-constraints.md`](references/16-routing-constraints.md) 把“布得整齐、可靠”写成了可检查的约束：

- **约束表**：几何 RTG（只许 0/45/90/135°、禁止锐角、最小段长、沿焊盘长轴出线）、线宽 RTW、线长 RTL（绕行率、晶振 ≤ 5 mm、USB 长度差）、过孔 RTV（每网预算、换层回流过孔、禁止盘中孔）、间距 RTS、层 RTY（2 层板底层是地、4 层板地层不走线、地破碎度）。每条带默认值、严重度和出处。
- **检查与评分**：`route_lint.py` 读 `.kicad_pcb` 或铜皮数据包，给出 11 项指标（VF-16…26）和总分，任一 P0 即不通过；结果同时显示在验证器阶段 R。
- **自动修复**：`route_fix.py` 把有问题的走线在原锚点之间重建成八方向折线（肘形、三段式，不行再局部 A*），删掉悬空线头和重叠线段，保持连通关系和间距不变，修不了的标出来交给人。
- **写入闸门**：Claude 通过嘉立创 EDA 或 KiCad 落线时，每批线段先写成 `plan.json` 过 `route_lint.py gate`，有任意角度或锐角就拒绝写入。

```text
$ python scripts/route_lint.py lint tests/fixtures/route-bad.kicad_pcb
得分 52.4 / 100 · 不通过（有 P0）   任意角度 9、锐角 4、晶振线打过孔、底层长跳线 …
$ python scripts/route_fix.py tests/fixtures/route-bad.kicad_pcb -o fixed.kicad_pcb
已写入 fixed.kicad_pcb：修复 9 段走线，删除 22 条、新增 18 条线段
$ python scripts/route_lint.py lint fixed.kicad_pcb
得分 91.8 / 100   任意角度 0、锐角 0；剩下晶振过孔和底层跳线是拓扑问题，要人决定
```

整网自动布线器、全局通道规划和 EDA 写入适配器还没有实现，路线图见该文件第 11 节。

## 目录结构

```
SKILL.md                         主流程（触发后加载）
references/
  01-requirements.md             需求维度、隐性需求、需求→硬件形态
  02-wireless-selection.md       BLE / WiFi / Thread / LoRa / 蜂窝选型
  03-sensor-placement.md         IMU、磁力计、温湿度、气压、麦克风、光学、天线的放置
  04-schematic-signals.md        信号与驱动层面
  05-power-architecture.md       电池、稳压、充电、保护、去耦
  06-power-budget.md             静态电流、峰值电流、续航
  07-layout.md                   布局布线
  08-bringup-production.md       可测试性、调试、认证、量产
  09-schematic-readability.md    原理图绘制流程与可读性规范
  10-easyeda-execution.md        嘉立创EDA 实施、器件标准化、资料归档与保存验收
  11-eda-mcp-setup.md            嘉立创 EDA 与 KiCad 的 MCP 安装、连接与排错
  12-layout-planner.md           交互式布局规划器：项目数据、功能、指标与规则、解读导出
  13-layout-verifier.md          布局布线验证器：verify 块、提取铜皮、规则 VF-01…27、解读验证报告
  14-routing-practice.md         布线实操（取自 CADET）：规则与密度基准、逐网顺序、升级阶梯、换层、绕线判据、自动布线器预期
  15-design-rules-and-process.md 设计规则与板厂工艺：写规则的八条做法、嘉立创价格档位、导入自有工艺、对照与生成
  16-routing-constraints.md      布线约束与质量评分：八方向几何、线宽线长过孔层约束、检查器与修复器、写入闸门、AI 布线规程
  20-hv-pulser-tr-safety.md      扩展：高压脉冲、T/R、高压电源与联锁、间距
  21-ultrasound-afe-clock.md     扩展：超声 AFE、采样与 IQ、时钟抖动
  22-low-noise-power-thermal.md  扩展：持续功耗模型、纹波与开关同步、手持热设计
  23-highspeed-lvds-fpga.md      扩展：LVDS、FPGA 核心板载板、数据率与 Wi-Fi 吞吐
  24-medical-handheld-safety.md  扩展：漏电、隔离、声输出、接触温度、探头头
  25-mixed-signal-bringup.md     扩展：混合信号板分级上电与测试
  checklists.md                  各阶段逐项核对清单
scripts/
  power_budget.py                功耗预算与峰值压降检查
  hw_calc.py                     I2C 上拉、储能电容、分压器、晶体负载电容、续航；抖动、纹波、高压储能、数据率
  make_layout_project.py         校验项目数据，生成布局规划页面或验证页面（--verifier / --copper）
  build_layout_planner.py        把规划器源码构建为单文件
  build_layout_verifier.py       把验证器源码构建为单文件
  extract_copper.py              从 KiCad 或 Gerber + IPC-D-356 提取铜皮，生成铜皮数据包
  fab_rules.py                   读取板厂工艺与设计规则，对照价格档位，生成 KiCad 规则和网络类建议
  route_lint.py                  布线几何检查与评分、写入 EDA 前的闸门、生成布线约束文件
  route_fix.py                   把任意角度、锐角、抖动、斜出焊盘的走线修成八方向折线
assets/
  layout-planner.html            布局规划器（单文件，内置示例）
  layout-planner/                规划器源码与 Three.js（MIT）
  layout-project-example.json    规划器示例项目
  layout-verifier.html           布局布线验证器（单文件，内置示例）
  layout-verifier/               验证器源码
  layout-verify-example.json     验证器示例（布局 + verify 块）
  routing/                       布线约束文件的 schema 与示例（lpiot-routing/1.0）
  fab-profiles/jlcpcb.json       嘉立创工艺档案：价格档位、各项下限、价格参考与来源
  requirements-template.md       需求与架构文档模板
  power-budget-example.json      功耗预算配置示例
tests/                           规划器与验证器的单元测试、铜皮提取测试与合成板
docs/images/                     README 配图与动图
docs/record/                     动图的录制脚本（虚拟时钟逐帧截图）与原理图流程演示页
```

## 安装

**推荐：先 Fork，再安装你自己的副本。** 这样你对规则和参考资料的定制有地方保存，也能随时同步上游的更新。

```bash
# 1. 在 GitHub 页面右上角点 Fork，然后克隆你的副本
git clone https://github.com/<你的用户名>/low-power-iot-hardware-design.git \
  ~/.claude/skills/low-power-iot-hardware-design

# 2. 关联上游，以后用 git pull upstream main 获取更新
cd ~/.claude/skills/low-power-iot-hardware-design
git remote add upstream https://github.com/donghuixin/low-power-iot-hardware-design.git
```

只想直接使用的话：

```bash
git clone https://github.com/donghuixin/low-power-iot-hardware-design.git \
  ~/.claude/skills/low-power-iot-hardware-design
```

项目级安装则克隆到项目的 `.claude/skills/` 目录下。

**Claude 应用（claude.ai / 桌面端）**：把本仓库打包成 zip（根目录包含 `SKILL.md`），在应用的 Skills 设置中上传。

## 使用示例

- "我想做一个戴在手腕上的动作记录器，CR2032 供电，蓝牙连手机，帮我梳理硬件方案。"
- "这是我的 nRF52840 原理图，睡眠电流要做到 5 µA 以内，帮我审一下。"
- "原理图画完了，帮我规划一下 PCB 上的器件怎么摆，天线放哪里。"
- "板子回来后睡眠电流有 300 µA，预期是 4 µA，怎么查？"
- "帮我看看这个 2.4 GHz 板载天线的 layout 有没有问题。"

## 脚本

```bash
python scripts/power_budget.py assets/power-budget-example.json
python scripts/hw_calc.py i2c-pullup --vdd 1.8 --cb-pf 40 --speed 400k
python scripts/hw_calc.py bulk-cap --ipeak-ma 15 --pulse-ms 5 --dv 0.2
python scripts/hw_calc.py divider --vin 4.2 --r1 2e6 --r2 1e6
python scripts/hw_calc.py xtal --cl-pf 9 --cstray-pf 3
python scripts/hw_calc.py jitter --fin-mhz 10 --snr-db 74
python scripts/hw_calc.py hvcap --cel-pf 100 --channels 32 --dv 60 --tr-ns 20 --droop-v 1 --cycles 8 --prf-khz 10
python scripts/make_layout_project.py assets/layout-project-example.json --check
python scripts/make_layout_project.py assets/layout-verify-example.json --verifier
python scripts/fab_rules.py show --layers 4
python scripts/fab_rules.py check board.kicad_pro board.kicad_pcb
python scripts/extract_copper.py board.kicad_pcb --project 布局.json -o copper-pack.json
python scripts/route_lint.py lint board.kicad_pcb -o 布线报告.md
python scripts/route_fix.py board.kicad_pcb -o board-fixed.kicad_pcb
```

除 `extract_copper.py` 和 `route_fix.py`（需要 numpy、scipy、Pillow；`route_lint.py` 读 `.kicad_pcb` 时也会用到）外只依赖 Python 3 标准库（`fab_rules.py` 导入 xlsx 时需要 openpyxl）。规划器与验证器的单元测试：`node --test tests/*.test.js`（Node 18+，无第三方依赖）；铜皮提取、工艺规则与布线检查修复：`python -m unittest tests/test_extract_copper.py tests/test_fab_rules.py tests/test_routing.py`。

## 参与改进

- 发现规则或参考资料有误、想补充某类器件的放置规则：提交 [Issue](https://github.com/donghuixin/low-power-iot-hardware-design/issues)。
- 想直接改：Fork 后在分支上修改，提交 Pull Request。规划器改动请附上 `node --test tests/*.test.js` 的结果和截图。
- 喜欢这个项目，请点 ⭐ Star，让更多做低功耗硬件的人看到它。

## 说明

文档中的数值均为典型量级，用于判断方向和发现问题；具体设计请以所选器件的 datasheet、参考设计和硬件设计指南为准，并以实测验证。

## License

[MIT](LICENSE)。布局规划器内置的 Three.js 同为 MIT 许可，见 [`assets/layout-planner/vendor/three.LICENSE`](assets/layout-planner/vendor/three.LICENSE)。
