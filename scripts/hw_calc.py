#!/usr/bin/env python3
"""硬件设计常用小计算。只依赖 Python 标准库。

子命令:
  i2c-pullup  I2C 上拉电阻取值范围
  bulk-cap    脉冲负载所需储能电容
  divider     分压器的输出电压、静态电流、输出阻抗
  xtal        晶体外接负载电容
  life        由容量与平均电流估算续航
  jitter      时钟抖动限制的 SNR, 或由目标 SNR 反算允许抖动        (扩展模块)
  ripple      由 ADC 满量程、位数、PSRR 反推电源纹波上限            (扩展模块)
  hvcap       高压脉冲器峰值电流、burst 储能电容与发射功率          (扩展模块)
  datarate    超声/高速采集的原始数据率、峰值速率与存储量          (扩展模块)

示例:
  python hw_calc.py i2c-pullup --vdd 1.8 --cb-pf 40 --speed 400k
  python hw_calc.py bulk-cap --ipeak-ma 15 --pulse-ms 5 --dv 0.2 --isupply-ma 3
  python hw_calc.py divider --vin 4.2 --r1 2e6 --r2 1e6
  python hw_calc.py xtal --cl-pf 9 --cstray-pf 3
  python hw_calc.py life --mah 225 --iavg-ua 12 --usable 0.8
  python hw_calc.py jitter --fin-mhz 10 --tj-ps 1.5 --adc-snr-db 70
  python hw_calc.py jitter --fin-mhz 10 --snr-db 74
  python hw_calc.py ripple --fs-vpp 2 --bits 12 --psrr-db 40 --margin-db 10
  python hw_calc.py hvcap --cel-pf 100 --channels 32 --dv 60 --tr-ns 20 --droop-v 1 --cycles 8 --prf-khz 10
  python hw_calc.py datarate --channels 8 --fs-msps 30 --bits 12 --window-us 200 --shots 4 --lines 80 --fps 5
"""
import argparse
import math

I2C_MODES = {
    # 速率: (最大上升时间 s, 灌电流 A)
    "100k": (1000e-9, 3e-3),
    "400k": (300e-9, 3e-3),
    "1m": (120e-9, 20e-3),
}


def fmt_r(ohm):
    if ohm >= 1e6:
        return f"{ohm / 1e6:.2f} MΩ"
    if ohm >= 1e3:
        return f"{ohm / 1e3:.2f} kΩ"
    return f"{ohm:.0f} Ω"


def i2c_pullup(a):
    tr, iol = I2C_MODES[a.speed.lower()]
    vol = 0.4 if a.vdd > 2.0 else 0.2 * a.vdd
    rmin = (a.vdd - vol) / iol
    rmax = tr / (0.8473 * a.cb_pf * 1e-12)
    print(f"I2C {a.speed}, VDD={a.vdd} V, 总线电容={a.cb_pf} pF")
    print(f"  Rp 下限 = (VDD − VOL)/IOL = {fmt_r(rmin)}")
    print(f"  Rp 上限 = tr/(0.8473·Cb)  = {fmt_r(rmax)}")
    if rmax < rmin:
        print("  无可行取值: 总线电容过大, 需降速、缩短总线或加缓冲器")
        return
    print(f"  低功耗设计在范围内取偏大值并留余量, 例如上限的 50–70%: 约 {fmt_r(rmax * 0.5)} – {fmt_r(rmax * 0.7)}")
    print(f"  总线为低时每个上拉的电流: {a.vdd / (rmax * 0.6) * 1e6:.0f} µA (按上限的 60% 计)")


def bulk_cap(a):
    i = max(a.ipeak_ma - a.isupply_ma, 0) / 1000.0
    c = i * (a.pulse_ms / 1000.0) / a.dv
    print(f"脉冲 {a.ipeak_ma} mA × {a.pulse_ms} ms, 电源同时可提供 {a.isupply_ma} mA, 允许压降 {a.dv} V")
    print(f"  所需有效容量 C ≥ {c * 1e6:.0f} µF")
    print("  注意: MLCC 按直流偏压降额后的有效容量选; 核对电容漏电流与 ESR 压降 (I × ESR)")


def divider(a):
    vout = a.vin * a.r2 / (a.r1 + a.r2)
    i = a.vin / (a.r1 + a.r2)
    rth = a.r1 * a.r2 / (a.r1 + a.r2)
    print(f"Vin={a.vin} V, R1(上)={fmt_r(a.r1)}, R2(下)={fmt_r(a.r2)}")
    print(f"  Vout = {vout:.3f} V")
    print(f"  静态电流 = {i * 1e6:.2f} µA (常通时计入睡眠电流)")
    print(f"  输出阻抗 = {fmt_r(rth)} (与 ADC 允许的源阻抗比较; 过高时并联电容或延长采样时间)")


def xtal(a):
    c = 2 * (a.cl_pf - a.cstray_pf)
    print(f"晶体 CL={a.cl_pf} pF, 杂散电容={a.cstray_pf} pF")
    if c <= 0:
        print("  杂散电容已不小于 CL, 无需外接电容或需选更大 CL 的晶体")
        return
    print(f"  C1 = C2 = 2 × (CL − C杂散) = {c:.1f} pF (取最接近的 C0G 标称值, 上板后测频偏微调)")


def life(a):
    hours = a.mah * a.usable / (a.iavg_ua / 1000.0)
    print(f"{a.mah} mAh × {a.usable} / {a.iavg_ua} µA = {hours:.0f} h = {hours / 24:.1f} 天 = {hours / 8760:.2f} 年")
    print("  多年续航需另计电池自放电, 可用 power_budget.py")


def fmt_bits(bps):
    for unit, k in (("Gbit", 1e9), ("Mbit", 1e6), ("kbit", 1e3)):
        if bps >= k:
            return f"{bps / k:.3g} {unit}"
    return f"{bps:.3g} bit"


def fmt_bytes(n):
    for unit, k in (("GB", 1e9), ("MB", 1e6), ("kB", 1e3)):
        if n >= k:
            return f"{n / k:.3g} {unit}"
    return f"{n:.3g} B"


def jitter(a):
    w = 2 * math.pi * a.fin_mhz * 1e6
    print(f"输入信号频率 f_in = {a.fin_mhz} MHz (取信号带宽上限, 不是采样率)")
    if a.tj_ps is not None:
        snr_j = -20 * math.log10(w * a.tj_ps * 1e-12)
        print(f"  抖动 t_j = {a.tj_ps} ps rms → SNR_jitter = −20·log10(2π·f_in·t_j) = {snr_j:.1f} dB")
    else:
        tj = 10 ** (-a.snr_db / 20) / w
        snr_j = a.snr_db
        print(f"  目标 SNR_jitter = {a.snr_db} dB → 允许 t_j ≤ {tj * 1e12:.2f} ps rms")
    if a.bits:
        ideal = 6.02 * a.bits + 1.76
        print(f"  参考: 理想 {a.bits} 位 ADC 量化 SNR = 6.02·N + 1.76 = {ideal:.1f} dB")
    if a.adc_snr_db is not None:
        tot = -10 * math.log10(10 ** (-a.adc_snr_db / 10) + 10 ** (-snr_j / 10))
        print(f"  与 ADC 本底 SNR {a.adc_snr_db} dB 合成: SNR_total ≈ {tot:.1f} dB (功率相加的常用写法)")
    print("  t_j 是时钟相位噪声在相关带宽上积分得到的 rms 值, 含时钟源、缓冲与走线引入的抖动")
    print("  多普勒另需近端相位噪声 (如 1 kHz 偏移) 指标和发射-采样同源, 本式不覆盖")


def ripple(a):
    lsb = a.fs_vpp / (2 ** a.bits)
    if a.threshold_uv is not None:
        thr = a.threshold_uv * 1e-6
        src = f"指定阈值 {a.threshold_uv} µV"
    else:
        thr = lsb * 10 ** (-a.margin_db / 20)
        src = f"1 LSB 下 {a.margin_db} dB"
    vr = thr * 10 ** (a.psrr_db / 20)
    print(f"ADC 满量程 {a.fs_vpp} Vpp, {a.bits} 位 → 1 LSB = {lsb * 1e6:.1f} µV")
    print(f"  阈值 ({src}) = {thr * 1e6:.2f} µV, 折算到 ADC 输入")
    print(f"  VR_MAX = 阈值 × 10^(PSRR/20) = {thr * 1e6:.2f} µV × 10^({a.psrr_db}/20) = {vr * 1e3:.3f} mV")
    print("  PSRR 取该电源轨在开关频率及其谐波处的值 (查曲线), 不是直流值; 杂散表现为载波边带时改用 PSMR")
    print("  多普勒/FFT 有处理增益, 低于 LSB 的固定频率杂散仍可能成谱线: 阈值宜取噪声底并留余量")


def hvcap(a):
    c = (a.cel_pf + a.cable_pf) * 1e-12
    i_ch = c * a.dv / (a.tr_ns * 1e-9)
    limited = a.ilimit_a is not None and i_ch > a.ilimit_a
    if limited:
        i_ch = a.ilimit_a
    q_edge = a.channels * c * a.dv
    q_burst = q_edge * a.cycles
    c_hold = q_burst / a.droop_v
    print(f"每通道负载 {a.cel_pf + a.cable_pf:g} pF (阵元 {a.cel_pf:g} + 电缆 {a.cable_pf:g}), {a.channels} 通道, 每次跳变 ΔV = {a.dv:g} V, 上升时间 {a.tr_ns:g} ns")
    print(f"  每通道边沿电流 I = C·ΔV/t_r = {i_ch:.2f} A" + (" (已按驱动器限流截断)" if limited else ""))
    print(f"  全部通道同时跳变的峰值电流 ≈ {i_ch * a.channels:.1f} A (估算上限; 聚焦延时会错开边沿, 但按最坏情况放去耦)")
    print(f"  每轨每个 burst 消耗电荷 Q = N·C·ΔV·周期数 = {q_burst * 1e6:.3f} µC ({a.cycles:g} 周期)")
    print(f"  允许下垂 {a.droop_v} V → 每轨最小有效储能 C ≥ Q/ΔV下垂 = {c_hold * 1e6:.2f} µF (假设 burst 内电源不补能)")
    print("  高压 MLCC 按直流偏压降额后的有效容量选, 耐压留余量; 储能电容紧贴脉冲器 HV 引脚")
    if a.prf_khz:
        e_cyc = a.channels * c * a.dv ** 2
        p = e_cyc * a.cycles * a.prf_khz * 1e3
        print(f"  发射功率 P ≈ N·C·ΔV²·周期数·PRF = {p:.3f} W @ PRF {a.prf_khz} kHz (双极 ±V 时 ΔV = 2V, 即每周期 4·C·V²)")


def datarate(a):
    cont = a.container_bits or (8 if a.bits <= 8 else 16 if a.bits <= 16 else 32)
    samples = a.fs_msps * 1e6 * a.window_us * 1e-6
    peak = a.channels * a.fs_msps * 1e6 * a.bits
    per_shot = a.channels * samples * cont / 8
    shots_frame = a.shots * a.lines
    per_frame = per_shot * shots_frame
    per_s = per_frame * a.fps
    print(f"{a.channels} 通道 × {a.fs_msps:g} MS/s × {a.bits} 位, 接收窗 {a.window_us:g} µs, 存储按 {cont} 位/样本")
    print(f"  接收窗内瞬时速率 (ADC 链路) = {fmt_bits(peak)}/s")
    print(f"  每通道每发样本数 = {samples:.0f}; 每发原始数据 = {fmt_bytes(per_shot)}")
    print(f"  每帧 {a.shots:g} 发/线 × {a.lines:g} 线 = {shots_frame:.0f} 发 → {fmt_bytes(per_frame)}/帧")
    print(f"  {a.fps:g} 帧/s 时平均原始速率 = {fmt_bytes(per_s)}/s = {fmt_bits(per_s * 8)}/s")
    duty = shots_frame * a.fps * a.window_us * 1e-6
    print(f"  接收窗占空比 = {duty * 100:.1f}% (>100% 表示时序不可行, 需减少发射次数、线数或帧率)")
    if a.link_mbps:
        need = per_s * 8 / 1e6
        print(f"  对比链路 {a.link_mbps} Mbit/s: 原始数据需要 {need:.1f} Mbit/s, 余量 {a.link_mbps / need:.2f}× (要求 ≥2×)")
    print("  原始数据通常只能在 FPGA 内完成波束形成/IQ 抽取; 对抽取后的每一级再算一次并保留 ≥2× 余量")


def main():
    ap = argparse.ArgumentParser(description="硬件设计常用小计算")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("i2c-pullup", help="I2C 上拉电阻范围")
    p.add_argument("--vdd", type=float, required=True, help="上拉电压 V")
    p.add_argument("--cb-pf", type=float, required=True, help="总线电容 pF (引脚约 5–10 pF/个 + 走线约 0.5–1 pF/cm)")
    p.add_argument("--speed", choices=["100k", "400k", "1M", "1m"], default="400k")
    p.set_defaults(fn=i2c_pullup)

    p = sub.add_parser("bulk-cap", help="脉冲负载储能电容")
    p.add_argument("--ipeak-ma", type=float, required=True)
    p.add_argument("--pulse-ms", type=float, required=True)
    p.add_argument("--dv", type=float, required=True, help="允许的电压跌落 V")
    p.add_argument("--isupply-ma", type=float, default=0.0, help="脉冲期间电池/稳压器可同时提供的电流 mA")
    p.set_defaults(fn=bulk_cap)

    p = sub.add_parser("divider", help="分压器")
    p.add_argument("--vin", type=float, required=True)
    p.add_argument("--r1", type=float, required=True, help="上臂电阻 Ω")
    p.add_argument("--r2", type=float, required=True, help="下臂电阻 Ω")
    p.set_defaults(fn=divider)

    p = sub.add_parser("xtal", help="晶体负载电容")
    p.add_argument("--cl-pf", type=float, required=True, help="晶体规格的负载电容 CL")
    p.add_argument("--cstray-pf", type=float, default=3.0, help="杂散电容, 通常 2–5 pF")
    p.set_defaults(fn=xtal)

    p = sub.add_parser("life", help="续航估算")
    p.add_argument("--mah", type=float, required=True)
    p.add_argument("--iavg-ua", type=float, required=True)
    p.add_argument("--usable", type=float, default=0.8, help="可用系数")
    p.set_defaults(fn=life)

    p = sub.add_parser("jitter", help="时钟抖动限制的 SNR / 允许抖动")
    p.add_argument("--fin-mhz", type=float, required=True, help="输入信号最高频率 MHz")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--tj-ps", type=float, help="时钟 rms 抖动 ps → 求 SNR")
    g.add_argument("--snr-db", type=float, help="目标 SNR dB → 求允许抖动")
    p.add_argument("--adc-snr-db", type=float, help="ADC 本底 SNR dB, 给出合成 SNR")
    p.add_argument("--bits", type=int, help="ADC 位数, 打印理想量化 SNR 作参考")
    p.set_defaults(fn=jitter)

    p = sub.add_parser("ripple", help="由 ADC LSB 与 PSRR 反推电源纹波上限")
    p.add_argument("--fs-vpp", type=float, required=True, help="ADC 满量程 Vpp")
    p.add_argument("--bits", type=int, required=True, help="ADC 位数")
    p.add_argument("--psrr-db", type=float, required=True, help="该电源轨在开关频率处的 PSRR dB (正数)")
    p.add_argument("--margin-db", type=float, default=6.0, help="杂散低于 1 LSB 的余量 dB")
    p.add_argument("--threshold-uv", type=float, help="直接指定输入参考阈值 µV (如噪声底), 覆盖 LSB 法")
    p.set_defaults(fn=ripple)

    p = sub.add_parser("hvcap", help="高压脉冲器峰值电流与储能电容")
    p.add_argument("--cel-pf", type=float, required=True, help="每阵元电容 pF")
    p.add_argument("--cable-pf", type=float, default=0.0, help="每通道电缆/走线电容 pF")
    p.add_argument("--channels", type=int, required=True, help="同时发射的通道数")
    p.add_argument("--dv", type=float, required=True, help="每次跳变的电压摆幅 V (±30 V 双极为 60)")
    p.add_argument("--tr-ns", type=float, required=True, help="输出上升时间 ns")
    p.add_argument("--droop-v", type=float, required=True, help="burst 内允许的高压下垂 V")
    p.add_argument("--cycles", type=float, default=1, help="每个 burst 的周期数")
    p.add_argument("--ilimit-a", type=float, help="驱动器每通道输出电流上限 A")
    p.add_argument("--prf-khz", type=float, help="脉冲重复频率 kHz, 给出发射功率")
    p.set_defaults(fn=hvcap)

    p = sub.add_parser("datarate", help="采集数据率与存储量")
    p.add_argument("--channels", type=int, required=True)
    p.add_argument("--fs-msps", type=float, required=True, help="每通道采样率 MS/s")
    p.add_argument("--bits", type=int, required=True, help="ADC 位数")
    p.add_argument("--window-us", type=float, required=True, help="每发接收窗 µs")
    p.add_argument("--shots", type=float, default=1, help="每条线的发射次数")
    p.add_argument("--lines", type=float, default=1, help="每帧线数")
    p.add_argument("--fps", type=float, default=1, help="帧率")
    p.add_argument("--container-bits", type=int, help="存储位宽, 默认按 8/16/32 向上取整")
    p.add_argument("--link-mbps", type=float, help="对比的链路实际吞吐 Mbit/s")
    p.set_defaults(fn=datarate)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
