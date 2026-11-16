#!/usr/bin/env python3
"""低功耗设备功耗预算计算器。

用法:
    python power_budget.py config.json [--json]

由电池参数、常开负载和周期性事件计算:
  - 平均电流及各项占比（折算到电池侧）
  - 续航估算（计入可用系数与自放电）
  - 峰值电流在电池内阻与路径电阻上的压降是否会低于系统最低电压
  - 压降不足时所需的储能电容

配置文件格式见 assets/power-budget-example.json。所有电流按"负载侧"填写，
脚本根据 regulator 配置折算到电池侧。只依赖 Python 标准库。
"""
import argparse
import json
import sys


def to_battery_side(i_load_ma, reg, vbat, light_load):
    """把稳压器输出侧电流折算到电池侧（不含 Iq）。"""
    kind = reg.get("type", "none")
    if kind in ("none", "ldo"):
        return i_load_ma
    if kind == "switcher":
        eff = reg.get("efficiency_sleep" if light_load else "efficiency_active", 0.85)
        vout = reg["vout_V"]
        return i_load_ma * vout / (vbat * eff)
    raise ValueError(f"未知的 regulator.type: {kind}")


def compute(cfg):
    bat = cfg["battery"]
    reg = cfg.get("regulator", {"type": "none"})
    sysc = cfg.get("system", {})
    period = float(cfg["period_s"])
    vnom = float(bat["nominal_V"])

    rows = []  # (名称, 类别, 电池侧平均电流 mA)

    for item in cfg.get("always_on", []):
        i_ma = item["current_uA"] / 1000.0
        # at_battery: 直接挂在电池上的负载（如分压器、保护芯片），不经稳压器
        if not item.get("at_battery", False):
            i_ma = to_battery_side(i_ma, reg, vnom, light_load=True)
        rows.append((item["name"], "常开", i_ma))

    iq = reg.get("iq_uA", 0.0) / 1000.0
    if iq:
        rows.append(("稳压器 Iq", "常开", iq))

    peak_load_ma = 0.0
    peak_name = "-"
    peak_dur_ms = 0.0
    for ev in cfg.get("events", []):
        charge_mc = ev["current_mA"] * ev["duration_ms"] / 1000.0 * ev.get("count_per_period", 1)
        avg = charge_mc / period
        avg = to_battery_side(avg, reg, vnom, light_load=False)
        rows.append((ev["name"], "事件", avg))
        pk = ev.get("peak_mA", ev["current_mA"])
        if pk > peak_load_ma:
            peak_load_ma, peak_name, peak_dur_ms = pk, ev["name"], ev["duration_ms"]

    i_avg = sum(r[2] for r in rows)
    sleep = sum(r[2] for r in rows if r[1] == "常开")

    # 续航
    cap = float(bat["capacity_mAh"])
    usable = float(bat.get("usable_fraction", 0.8))
    sd_pct = float(bat.get("self_discharge_pct_per_year", 0.0))
    sd_ma = cap * sd_pct / 100.0 / 8760.0  # 自放电等效电流
    hours = cap * usable / (i_avg + sd_ma) if (i_avg + sd_ma) > 0 else float("inf")

    # 峰值压降（按电池末期条件）
    v_eol = float(bat.get("eol_open_circuit_V", vnom))
    r_int = float(bat.get("eol_internal_resistance_ohm", bat.get("internal_resistance_ohm", 0.0)))
    r_path = float(sysc.get("path_resistance_ohm", 0.0))
    v_min_req = float(sysc.get("min_input_V", 0.0))
    # 升压/降压时电池侧峰值电流按末期电压折算
    peak_bat_ma = to_battery_side(peak_load_ma, reg, v_eol, light_load=False) + sleep
    v_droop = peak_bat_ma / 1000.0 * (r_int + r_path)
    v_at_peak = v_eol - v_droop
    peak_ok = v_at_peak >= v_min_req

    # 储能电容：保守地假设脉冲电流全部由电容提供
    cap_needed_uF = None
    allowed_dv = v_eol - v_min_req
    if not peak_ok and allowed_dv > 0:
        cap_needed_uF = peak_bat_ma / 1000.0 * (peak_dur_ms / 1000.0) / allowed_dv * 1e6

    return {
        "rows": [{"name": n, "kind": k, "avg_uA": i * 1000.0, "share_pct": (i / i_avg * 100.0 if i_avg else 0.0)} for n, k, i in rows],
        "avg_current_uA": i_avg * 1000.0,
        "sleep_current_uA": sleep * 1000.0,
        "self_discharge_equiv_uA": sd_ma * 1000.0,
        "life_hours": hours,
        "life_days": hours / 24.0,
        "life_years": hours / 8760.0,
        "peak": {
            "event": peak_name,
            "load_peak_mA": peak_load_ma,
            "battery_peak_mA": peak_bat_ma,
            "eol_voltage_V": v_eol,
            "series_resistance_ohm": r_int + r_path,
            "droop_V": v_droop,
            "voltage_at_peak_V": v_at_peak,
            "min_required_V": v_min_req,
            "ok": peak_ok,
            "bulk_cap_needed_uF": cap_needed_uF,
        },
    }


def render(cfg, res):
    out = []
    out.append(f"电池: {cfg['battery'].get('name', '?')}  {cfg['battery']['capacity_mAh']} mAh  周期: {cfg['period_s']} s")
    out.append("")
    out.append(f"{'项目':<28}{'类别':<6}{'平均电流(µA)':>14}{'占比':>8}")
    out.append("-" * 60)
    for r in sorted(res["rows"], key=lambda x: -x["avg_uA"]):
        out.append(f"{r['name']:<28}{r['kind']:<6}{r['avg_uA']:>14.3f}{r['share_pct']:>7.1f}%")
    out.append("-" * 60)
    out.append(f"睡眠(常开)电流合计: {res['sleep_current_uA']:.3f} µA")
    out.append(f"平均电流(电池侧):   {res['avg_current_uA']:.3f} µA")
    out.append(f"自放电等效电流:     {res['self_discharge_equiv_uA']:.3f} µA")
    out.append(f"估算续航: {res['life_days']:.1f} 天 ≈ {res['life_years']:.2f} 年")
    p = res["peak"]
    out.append("")
    out.append(f"峰值检查(电池末期): 事件「{p['event']}」负载峰值 {p['load_peak_mA']:.1f} mA, 电池侧 {p['battery_peak_mA']:.1f} mA")
    out.append(f"  {p['eol_voltage_V']:.2f} V − {p['battery_peak_mA']:.1f} mA × {p['series_resistance_ohm']:.2f} Ω = {p['voltage_at_peak_V']:.2f} V"
               f"  (要求 ≥ {p['min_required_V']:.2f} V) → {'通过' if p['ok'] else '不通过'}")
    if p["bulk_cap_needed_uF"] is not None:
        out.append(f"  需要储能电容约 {p['bulk_cap_needed_uF']:.0f} µF 有效容量(保守估计: 脉冲电流全部由电容提供; 注意偏压降额与漏电)")
    elif not p["ok"]:
        out.append("  电池末期开路电压已低于系统最低电压, 需更换电池方案或降低系统最低电压")
    out.append("")
    out.append("提示: 结果基于典型值估算。稳压器效率请按对应负载电流查曲线; 上板后用实测值替换。")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description="低功耗设备功耗预算计算器")
    ap.add_argument("config", help="JSON 配置文件路径")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出结果")
    args = ap.parse_args()
    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    res = compute(cfg)
    if args.json:
        json.dump(res, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print(render(cfg, res))


if __name__ == "__main__":
    main()
