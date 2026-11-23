# 混合信号板的分级上电与测试

**适用范围**：扩展模块。含高压发射、高速 ADC / AFE、LVDS、FPGA 和无线的板子打样回来后阅读。本文件扩展 `08-bringup-production.md` 第 2 节：不上电检查、限流上电、逐路测压、"关闭 DCDC 逐项验证"等通用步骤照常执行，这里只补混合信号与高压特有的阶段。原则不变：每一级通过后再进入下一级，高压最后打开。

## 目录
1. 仪器与夹具
2. 分级上电顺序
3. 记录项
4. 故障排查
5. 审查要点

## 1. 仪器与夹具

| 用途 | 仪器 / 夹具 | 要点 |
|---|---|---|
| 供电 | 双路限流可调电源或电池模拟器 | 模拟 1S 末期（3.0 V）与满电（4.2 V），可设 1.5 A 以上限流 |
| 电源与时序 | 示波器 + 短地弹簧探头 | 测纹波时用短地；带宽按最高被测信号选 |
| 高压 | 额定电压足够的高压探头或差分探头、绝缘测试线 | 普通 10× 探头的额定电压先核对 |
| 杂散与噪声 | 频谱仪，或用 ADC 自身采样做 FFT | 对照开关频率表 |
| 时钟 | 相位噪声分析仪（有条件时）；或用 ADC 在低 / 高 f_in 下的 SNR 差值反推抖动 | — |
| 模拟输入 | 低噪声信号源 + 衰减器 | 单音测试 AFE 增益与 SNR |
| LVDS | FPGA 内嵌逻辑分析仪；高带宽示波器看眼图（有条件时） | — |
| 发射负载 | 假负载：2 kΩ ‖ 120 pF（TX7332 手册的测试负载） | 每通道一个，或可切换的一组 |
| 声学 | 水槽、组织仿体、多普勒流动仿体或旋转盘 / 弦线仿体、已知体积的膀胱仿体 | — |
| 声输出 | 水听器（人体实验前） | 见 `24-medical-handheld-safety.md` 第 4 节 |
| 热 | 热像仪、热电偶、33 °C 热仿体 | 见 `22-low-noise-power-thermal.md` 第 7 节 |
| 漏电 | 隔离变压器、漏电流测试仪（人体实验前） | — |

## 2. 分级上电顺序

| 级 | 内容 | 通过条件 |
|---|---|---|
| 0 不上电 | 目检与 X-ray 报告（BGA）；各电源对地电阻；HV 网络对地、HV+ 对 HV− 电阻；HV 间距与测试点绝缘目检 | 无短路，阻值与同类板一致 |
| 1 禁发上电 | 硬件断开 HV 变换器（拆跳线 / DNP），脉冲器置掉电；限流上电；测各路电压、上电顺序与斜率（含 FPGA VCCIO 斜率 0.06–15 mV/µs）；FPGA 未配置、复位时测 HV_EN 与发射输入 | 各轨在范围内；未配置、复位时 HV_EN 为"关" |
| 2 电源纹波与杂散 | 逐个模拟轨测 fsw 处纹波，与 `22-low-noise-power-thermal.md` 第 4 节的目标比较；确认各变换器已锁定到同步时钟；同步开 / 关对比 | 实测纹波低于目标；同步锁定 |
| 3 时钟 | 频率、幅度、相位噪声或抖动；PLL 锁定；发射触发相对 ADC 时钟的位置在多个 PRI 上保持不变 | 抖动低于 `21-ultrasound-afe-clock.md` 第 6 节的上限；触发相位确定 |
| 4 AFE 配置与测试码 | SPI 写读回寄存器；打开测试码（斜坡 / 同步码） | 寄存器读回一致；测试码可在 FPGA 中解出 |
| 5 LVDS 训练与误码 | 位 / 字对齐；扫描延时得到眼宽并取中心；长时间误码测试；用热风枪做高低温复核 | 0 误码。无误码运行 3/BER 位可在约 95% 置信度下声明误码率低于 BER（例：证明 <10⁻¹² 需约 3×10¹² 位，16 lane × 1 Gbps 约 3 min） |
| 6 接收噪声底（HV 关） | 输入端接 / 不接探头；测每通道噪声，与手册输入参考噪声 × 增益比较；频谱中的杂散对照开关频率表；多普勒链路在 HV 关时做慢时间 FFT 看谱线 | 噪声接近预算；无未解释的杂散或谱线 |
| 7 假负载发射 | HV 从低压起步（如 ±5–10 V），接假负载；测每通道波形、延时、burst 内 HV 下垂（与 `hw_calc.py hvcap` 对比）、HV 恢复；T/R 毛刺与接收恢复；逐级升压到工作电压 | 波形与时序正确；下垂在目标内 |
| 7a 联锁验证 | 拔探头 / 断在位信号、FPGA 复位、欠压、超温（加热 NTC）、看门狗停喂、插入 USB（未隔离时） | 每项都使 HV 在规定时间内关断，记录关断时间 |
| 8 接阵列 | 低压，水槽或仿体；逐阵元脉冲回波，找死阵元、串扰；读探头 ID | 阵元一致性在要求内；ID 正确 |
| 9 仿体 | B 模式（分辨率、深度）；多普勒（旋转盘 / 流动仿体的速度准确度）；膀胱仿体（已知体积，如 250 / 500 mL） | 指标达到需求 |
| 10 热与声输出 | 最坏模式下 20 min 探头面温度（33 °C 仿体与 23 °C 静止空气）；水听器测 ISPTA.3 / MI | 低于限值并有余量 |
| 11 系统 | 真实环境 Wi-Fi 吞吐（对照约 20 Mbit/s TCP）；Wi-Fi 发射期间接收杂散；1S 末期满负载；边充边用的温升 | 余量 ≥2×；无发射耦合杂散 |

第 7 级之前，所有接收测试都在 HV 物理断开的状态下完成，这样噪声和杂散可以确定来自低压部分。

## 3. 记录项

每块板一份记录，随固件版本和硬件版本存档：

- 板号、硬件版本、贴装批次、X-ray 结论
- 各电源轨电压、纹波（fsw 处 µV）、同步状态
- 时钟频率、抖动或相位噪声、PLL 锁定
- LVDS 训练抽头值、眼宽、误码测试位数与结果、测试温度
- 每通道噪声底、增益、主要杂散频率与幅度
- HV 档位、下垂、恢复时间、各联锁的关断时间
- 每种模式的功耗、电池电流、20 min 温度
- 声输出测量值（如已测）
- 与预算的差异和处理

## 4. 故障排查

| 症状 | 先查 |
|---|---|
| B 图像有固定条纹，或多普勒谱上有固定谱线 | 开关频率表与同步锁定；扩频或 PFM 是否在接收期间开着；充电器是否在工作；Wi-Fi 发射是否与接收重叠 |
| 静止组织在多普勒谱上展开成宽带噪声 | 发射触发与采样时钟不同源或跨时钟域；PRF 不是时钟的整数分频；时钟近端相噪 |
| LVDS 偶发错位或误码 | 训练抽头是否在眼中心；温度漂移；终端位置；对间偏斜；VCCIO 与 IO 标准；连接器接触 |
| 近场盲区比预期大 | T/R 切换时间、脉冲器与换能器振铃、LNA 过载恢复、消隐设置 |
| burst 后段幅度下降 | 储能有效容量（偏压降额）、HV 变换器补能速度、走线电感 |
| 某通道噪声大 | 复用开关 Ron、限幅 / TVS 器件漏电、焊接、阵元或电缆 |
| 温升超预期 | 按功耗-热表逐模式实测，查 FPGA 与 Wi-Fi 的实际功耗、HV 发射功率 |
| 插 USB 后噪声变大 | 地环路；按 `24-medical-handheld-safety.md` 第 3 节处理 |

定位到设计问题后，回到对应的扩展参考文件（20–24）和清单 E 段核对。

## 5. 审查要点

1. 板上留有：HV 物理断开点、各模拟轨纹波测试点、时钟测试点、HV 测试点（绝缘）、每轨电流测量位置。
2. FPGA 有 AFE 测试码解码、LVDS 训练和误码计数逻辑。
3. 假负载夹具和低压起步方案。
4. 联锁逐项验证并记录关断时间。
5. 热与声输出测试在人体实验之前完成。

## 资料

- TI TX7332 数据手册（测试负载 2 kΩ ‖ 120 pF）：https://www.ti.com/document-viewer/TX7332/datasheet
- TI AFE5832LP 数据手册：https://www.ti.com/document-viewer/AFE5832LP/datasheet
- ADI FAQ《Using the ADC SNR method》：https://www.analog.com/en/resources/faqs/faq_using_the_adc_snrmethod_what_is_the_equivalent
- ADI Analog Dialogue《Optimizing Power Systems for the Signal Chain — Part 1》：https://www.analog.com/en/resources/analog-dialogue/articles/optimizing-power-systems-for-the-signal-chain-part-1.html
- GE HealthCare Vscan Air《Maximum probe temperature》：https://vscanair-support.gehealthcare.com/support/solutions/articles/47001169693-maximum-probe-temperature
- ESP-IDF《Wi-Fi Performance and Power Save》（ESP32-S3）：https://docs.espressif.com/projects/esp-idf/en/v6.0/esp32s3/api-guides/wifi-driver/wifi-performance-and-power-save.html
- 嘉立创 PCBA 工艺能力（X-ray）：https://jlcpcb.com/capabilities/pcb-assembly-capabilities
