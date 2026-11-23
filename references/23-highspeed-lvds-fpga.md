# LVDS 源同步采集、FPGA 核心板载板与数据率预算

**适用范围**：扩展模块。有 LVDS / 高速串行、信号或时钟 >50 MHz、或使用 FPGA 时阅读。本文件替代 `07-layout.md` 第 5 节"信号速率不高、不是传输线问题"的前提；回流路径、跨分割、串扰等通用规则仍按 07。偏斜数值由位周期推算，标注为估算，须用所选 AFE 的 LVDS 时序和 FPGA 输入时序复核。

## 目录
1. 叠层与阻抗
2. LVDS 走线规则
3. 偏斜预算
4. 位与字对齐（训练）
5. FPGA 核心板载板
6. 数据率与存储预算
7. FPGA → MCU 与 Wi-Fi 吞吐
8. 审查要点

## 1. 叠层与阻抗

- **层数**：LVDS 至少 4 层（LVDS / 地 / 电源 / 单端信号），LVDS 与单端信号分层并由平面隔开（TI）。有 0.8 mm 大 BGA（AFE、脉冲器）的前端板用 6 层：嘉立创 6 层及以上默认免费盘中孔（POFV）和 ENIG，地平面更完整。
- **阻抗**：LVDS 介质通常选 100 Ω 差分。线宽线距由板厂叠层决定：用嘉立创阻抗计算器（4–8 层按 NP-155F 芯板，差分可算 50–150 Ω），选它推荐的第一个叠层，并在加工文件中注明阻抗要求。标准公差 ±10%，本项目无需 ±5%。
- 不照搬参考设计的线宽，除非叠层相同。

## 2. LVDS 走线规则

| 项 | 规则 | 来源 |
|---|---|---|
| 差分阻抗 | 100 Ω，线宽线距全长一致 | TI LVDS Owner's Manual |
| 终端 | 90–130 Ω 跨接在接收端，到接收器 <10 mm（最大 12 mm） | TI DS90LV048A layout |
| FPGA 差分输入 | Gowin GW5A 需外接 100 Ω 终端，尽量靠近输入引脚；如器件支持内部终端，按手册确认后再省略（待核对） | GW5A 硬件设计指南 |
| 残桩 | <10 mm；过孔残桩增加寄生电容、降低带宽，少换层 | TI |
| 拐角 | 圆弧或 45°，不用 90° | TI |
| 对间 | 多对并行时对间偏斜最小化，保证正确解串 | TI |
| 参考平面 | 连续，不跨分割；换层处在信号过孔旁放地过孔 | 07 第 5 节 |
| 隔离 | 远离 HV 网络（间距按 `20-hv-pulser-tr-safety.md` 第 6 节）、DC/DC 开关节点和电感 | — |

## 3. 偏斜预算

以下为由位周期推导的工程估算，没有一手出处：

```
UI = 1 / 比特率
传播延迟 t_pd ≈ 6 ps/mm（FR-4 外层，εeff ≈ 3.3，估算）
允许走线偏斜(mm) = k × UI / t_pd，k 取 5%（估算）
```

| 比特率 | UI | 5% UI | 折合长度 |
|---|---|---|---|
| 1 Gbps | 1 ns | 50 ps | ≈8 mm |
| 480 Mbps | 2.08 ns | 104 ps | ≈17 mm |
| 360 Mbps | 2.78 ns | 139 ps | ≈23 mm |

- 建议 1 Gbps 时数据对对时钟对 ±2.5 mm（约 15 ps），对内 P/N ±0.15 mm（约 1 ps）（估算）。
- 预算还要扣除 AFE 输出偏斜、FPGA 输入建立 / 保持、连接器与核心板内部走线的长度差。核心板内部长度向供应商索取或从其 PCB 文件读取。
- FPGA 有逐位 IODELAY 和动态训练时可放宽；没有时必须收紧，并在评审报告中写明依据。

## 4. 位与字对齐（训练）

- 用 AFE 的测试码（斜坡、同步码、自定义码）做位对齐和字 / 帧对齐，不在真实回波上调试链路。
- FPGA 侧扫描输入延时，找出眼宽中心并记录抽头值；在高低温下复核。GW5A 的 IODELAY / 动态相位调整能力按手册核对（待核对）。
- 上电、换探头、换采样率后重新训练；训练失败时禁止发射并上报。

## 5. FPGA 核心板载板

外购核心板（如 Sipeed Tang Primer 25K）把 0.5 mm 节距 BGA 的扇出留给核心板厂家，载板只剩连接器。核对下列项目：

| 项 | 规则 |
|---|---|
| 资源 | GW5A-25：23,040 LUT4/FF；BSRAM 56 × 18 Kb = 1,008 Kb；DSP 28 个（每个含 27×18 与 12×12 乘法器）；PLL ≤6；LVDS RX 1.6 Gbps、TX 2.0 Gbps；解串比 1:2/4/7/8/10/14/16/32；MG121N 封装 36 对真 LVDS |
| IO bank 电压 | 每个 bank 独立 VCCIO；真 LVDS bank 用 VCCIO = 2.5 V；核心板上已焊定的 VCCIO 查其原理图，与 AFE 的 LVDS 输出共模和 IO 标准一致 |
| 差分引脚 | 只用真差分引脚对；从核心板原理图确认哪些对引到连接器、位于哪个 bank |
| 上电顺序 | VCCIO 在 VCC、VCC_REG、VCCX 之后上电，斜率 0.06–15 mV/µs；核心板自带稳压时，确认载板只提供输入电源 |
| 时钟输入 | AFE 的位时钟 / 帧时钟接到时钟专用输入（GCLK / PLL 输入）引脚，按 pinout 核对 |
| 连接器 | 差分对占相邻引脚，对与对之间插地针；连接器处的阻抗不连续计入预算；连接器类型和节距按核心板资料确认（待核对） |
| 配置与 JTAG | 引出 JTAG；配置模式脚默认态；DONE/READY 引出到 HV 联锁（`20-hv-pulser-tr-safety.md` 第 5 节） |
| 未配置时的 IO | 按手册确认未配置 IO 的上下拉状态；凡能触发发射或 HV 的信号，在载板上用外部电阻钉住"关" |
| 静态电流 | GW5A-25 典型：core 30 mA、VCCX 2 mA、I/O 1 mA；动态功耗无数据，按估算计入功耗表 |

载板上的 FPGA ↔ ESP32、FPGA ↔ AFE SPI 等单端信号，仍按 `04-schematic-signals.md` 逐状态检查（复位默认态、反灌、电平）。

## 6. 数据率与存储预算

逐级列表，每一级 ≥2× 余量（沿用 REQ-02）：

| 级 | 计算 | 例（路线 A：8 ch，30 MS/s，12 位，200 µs，4 发 / 线，80 线，5 帧/s） |
|---|---|---|
| ADC → FPGA（接收窗内） | 通道 × fs × 位 | 8 × 30 M × 12 = 2.88 Gbit/s |
| 原始数据（16 位容器） | 每发 = 通道 × fs × 窗 × 2 B | 96 kB/发；320 发/帧 = 30.7 MB/帧；154 MB/s ≈ 1.23 Gbit/s |
| FPGA 内波束形成 / IQ 抽取后 | 线 × 点 × 位 × fps | 80 × 512 × 8 bit ≈ 40 kB/帧，5 帧/s ≈ 1.6 Mbit/s |
| 多普勒门内 IQ | 2 × 16 bit × PRF | 10 kHz：0.32 Mbit/s；20 kHz：0.64 Mbit/s |
| FPGA → MCU 链路 | 实测 / 估算 | 见第 7 节 |
| Wi-Fi 空中 | 实测 | 约 20 Mbit/s TCP |

- 32 通道原始数据（32 × 30 MS/s × 12 位 = 11.52 Gbit/s）只能在 FPGA 内完成波束形成或解调抽取，不能外传。
- **存储深度**：一个接收窗 200 µs × 40 MS/s × 12 位 ≈ 96 Kb/通道，32 通道约 3 Mb，超过 GW5A-25 的 1,008 Kb。做流式延时求和，只缓存孔径内最大差分延时（9.6–16 mm 孔径约 6–10 µs，约 256 点/通道，约 1 块 BSRAM/通道）（估算）。合成孔径另加 1–2 条线的累加缓冲。BSRAM 不够时加外部 PSRAM / SDRAM，并把其带宽计入本表。
- **时序可行性**：接收窗占空比 = 每帧发射次数 × fps × 接收窗，必须 <100%（上例 32%）；还要加上发射、T/R 恢复和线间 SPI 重写时间。

用 `python scripts/hw_calc.py datarate --channels 8 --fs-msps 30 --bits 12 --window-us 200 --shots 4 --lines 80 --fps 5 --link-mbps 20` 复算。

## 7. FPGA → MCU 与 Wi-Fi 吞吐

- **ESP32-S3 SPI 从机**：设计上支持到 60 MHz，要求 50% 占空比；由 CPU 驱动，有延时。DMA 缓冲 4 字节对齐、长度为 4 的倍数；用 queue_trans + get_trans_result 比 transmit 响应率约高一倍；加握手 GPIO；SPI2 的 IOMUX 管脚为 GPIO 9–14。FPGA 作主机、20–40 MHz、4–8 KB 一包时实际约 2–4 MB/s（估算）。
- **Wi-Fi**：ESP32-S3 在屏蔽箱内 TCP TX 83 / RX 73 Mbit/s、UDP TX 98 / RX 88 Mbit/s；实验室空中环境约 TCP 20、UDP 30 Mbit/s。用 PSRAM 时 TCP 约 93 Mbit/s，但应用可用内存从约 134 KB 降到约 50 KB。**按空中数值设计**，留 2× 余量即应用层 ≤10 Mbit/s（TCP）。
- PSRAM（如 N8R8 的 8 MB）可作帧缓冲，平滑 Wi-Fi 抖动。
- USB FS（12 Mbit/s，实际约 1 MB/s，估算）可作有线后备。
- Wi-Fi 发射峰值叠加到电池电流（`22-low-noise-power-thermal.md` 第 1 节），发射突发对接收的干扰在 bring-up 时专项检查（`25-mixed-signal-bringup.md`）。

## 8. 审查要点

1. 叠层、100 Ω 差分已按板厂计算；LVDS 与单端分层。
2. 终端位置、残桩、拐角、参考平面连续。
3. 偏斜预算由 UI 推导并标注为估算，含核心板与连接器内部长度。
4. AFE 测试码训练流程与失败处理。
5. 核心板 bank VCCIO、真差分引脚、时钟输入脚、上电顺序与斜率。
6. 连接器差分引脚分配与地针；未配置 IO 不能触发 HV。
7. 逐级数据率 ≥2× 余量；存储深度与接收窗占空比。
8. FPGA → MCU 和 Wi-Fi 按实测 / 空中数值核算。

## 资料

- TI《LVDS Owner's Manual》第 4 版（SNLA187）：https://ti.com/lit/snla187
- TI DS90LV048A 数据手册 layout 节：https://www.ti.com/document-viewer/lit/html/SNLS045C/layout
- GW5A 系列硬件设计指南（镜像，原文为 Gowin 文档）：https://manuals.plus/gowin/gw5a-series-of-fpga-products-manual
- Gowin GW5A 数据手册 DS1103：https://www.mouser.com/datasheet/2/1033/DS1103E-3367000.pdf
- TI AFE5832LP 产品页：https://www.ti.com/product/AFE5832LP
- ESP-IDF《Wi-Fi Performance and Power Save》（ESP32-S3）：https://docs.espressif.com/projects/esp-idf/en/v6.0/esp32s3/api-guides/wifi-driver/wifi-performance-and-power-save.html
- ESP-IDF《SPI Slave Driver》（ESP32-S3）：https://docs.espressif.com/projects/esp-idf/en/v5.2.6/esp32s3/api-reference/peripherals/spi_slave.html
- 嘉立创 PCB 工艺能力：https://jlcpcb.com/capabilities/PCB-capabilities ；阻抗计算器说明：https://jlcpcb.com/help/article/User-Guide-to-the-JLCPCB-Impedance-Calculator ；6 层板：https://jlcpcb.com/resources/6-layer-pcbs
