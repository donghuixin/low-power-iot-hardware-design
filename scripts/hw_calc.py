#!/usr/bin/env python3
"""硬件设计常用小计算。只依赖 Python 标准库。

子命令:
  i2c-pullup  I2C 上拉电阻取值范围
  bulk-cap    脉冲负载所需储能电容
  divider     分压器的输出电压、静态电流、输出阻抗
  xtal        晶体外接负载电容
  life        由容量与平均电流估算续航

示例:
  python hw_calc.py i2c-pullup --vdd 1.8 --cb-pf 40 --speed 400k
  python hw_calc.py bulk-cap --ipeak-ma 15 --pulse-ms 5 --dv 0.2 --isupply-ma 3
  python hw_calc.py divider --vin 4.2 --r1 2e6 --r2 1e6
  python hw_calc.py xtal --cl-pf 9 --cstray-pf 3
  python hw_calc.py life --mah 225 --iavg-ua 12 --usable 0.8
"""
import argparse

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

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
