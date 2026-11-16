# low-power-iot-hardware-design

一个面向**低功耗物联网硬件**的 Claude Skill：从需求挖掘到原理图、Layout、bring-up 的完整设计与评审流程。

A Claude skill for designing and reviewing low-power IoT hardware: requirements elicitation, wireless and part selection, sensor placement, schematic reliability review, power budgeting, PCB layout review, and bring-up.

## 它做什么

| 阶段 | 内容 |
|---|---|
| 1. 需求明确 | 把功能描述变成量化指标；主动提出用户没想到的需求（峰值电流、电池末期、OTA、运输模式、认证、产测……）；把需求映射到硬件形态；无线选型按数据率、吞吐、距离、峰值电流、平均功耗比较；传感器放置约束（例如 IMU 是否需要靠近转动中心） |
| 2. 原理图可靠性 | 逐状态检查每个网络：上拉下拉、开漏/推挽/三态、电平域匹配、断电域反灌；驱动电压与驱动电流；睡眠电流逐项清点与峰值电流压降；电源树、充电、保护、去耦与储能；绘制流程与可读性规范（同页直连、跨页与标准接口用标号/端口、网络命名、文字不重叠、设计意图注释） |
| 3. Layout | 叠层与阻抗、布局顺序、天线与射频、电源完整性、信号完整性、晶体、高阻节点、传感器应力与热隔离、EMC/ESD、热、DFM/DFA/DFT |
| 4. Bring-up 与量产 | 上电顺序、功耗实测、常见故障排查（睡眠电流大、射频距离短、偶发复位）、认证与产测 |

每个阶段输出带严重度分级（P0–P3）的问题列表，每条包含位置、后果和修改建议。

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
  checklists.md                  各阶段逐项核对清单
scripts/
  power_budget.py                功耗预算与峰值压降检查
  hw_calc.py                     I2C 上拉、储能电容、分压器、晶体负载电容、续航
assets/
  requirements-template.md       需求与架构文档模板
  power-budget-example.json      功耗预算配置示例
```

## 安装

**Claude Code**

```bash
git clone https://github.com/donghuixin/low-power-iot-hardware-design.git \
  ~/.claude/skills/low-power-iot-hardware-design
```

项目级安装则克隆到项目的 `.claude/skills/` 目录下。

**Claude 应用（claude.ai / 桌面端）**

把本仓库打包成 zip（根目录包含 `SKILL.md`），在应用的 Skills 设置中上传。

## 使用示例

- "我想做一个戴在手腕上的动作记录器，CR2032 供电，蓝牙连手机，帮我梳理硬件方案。"
- "这是我的 nRF52840 原理图，睡眠电流要做到 5 µA 以内，帮我审一下。"
- "板子回来后睡眠电流有 300 µA，预期是 4 µA，怎么查？"
- "帮我看看这个 2.4 GHz 板载天线的 layout 有没有问题。"

## 脚本

```bash
python scripts/power_budget.py assets/power-budget-example.json
python scripts/hw_calc.py i2c-pullup --vdd 1.8 --cb-pf 40 --speed 400k
python scripts/hw_calc.py bulk-cap --ipeak-ma 15 --pulse-ms 5 --dv 0.2
python scripts/hw_calc.py divider --vin 4.2 --r1 2e6 --r2 1e6
python scripts/hw_calc.py xtal --cl-pf 9 --cstray-pf 3
```

只依赖 Python 3 标准库。

## 说明

文档中的数值均为典型量级，用于判断方向和发现问题；具体设计请以所选器件的 datasheet、参考设计和硬件设计指南为准，并以实测验证。
