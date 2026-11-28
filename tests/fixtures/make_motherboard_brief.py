#!/usr/bin/env python3
"""真实演示板（nRF5340 / MDBT53 可穿戴主板，作者同意公开）的设计确认文件：按板子上读出来的器件、边和功能块写成，
用于扩展的演示和测试。G0 的功能描述是根据器件推断的示例，不是作者的产品说明。

    python make_motherboard_brief.py [输出目录]   → motherboard-brief.json
"""
import json
import sys
from pathlib import Path

D = Path(__file__).resolve().parent
PACK = json.loads((D / "motherboard-pack.json").read_text(encoding="utf-8"))
W, H = PACK["board"]["w"], PACK["board"]["h"]
RECT = {p["ref"]: p["rect"] for p in PACK["parts"]}


def center(ref):
    r = RECT[ref]
    return (r[0] + r[2]) / 2, (r[1] + r[3]) / 2


def region(refs, pad=0.6):
    xs = [v for r in refs for v in (RECT[r][0], RECT[r][2])]
    ys = [v for r in refs for v in (RECT[r][1], RECT[r][3])]
    return [round(max(0, (min(xs) - pad) / W), 3), round(max(0, (min(ys) - pad) / H), 3), round(min(1, (max(xs) + pad) / W), 3), round(min(1, (max(ys) + pad) / H), 3)]


def fixed(ref, what, edge, reason):
    x, y = center(ref)
    along = x if edge in ("top", "bottom") else y
    return {"ref": ref, "what": what, "edge": edge, "along_mm": round(along, 2), "tol_mm": 1.0, "side": "top", "reason": reason}


BLOCKS = [
    ("无线主控", ["MDBT1", "X2", "C25", "C26", "J1"], "主控模组贴上边，天线朝板外；调试口在模组左侧"),
    ("音频", ["U6", "U12", "CRYSTAL1", "C3", "C7"], "PDM 麦克风和编解码在左侧中部，远离开关电源"),
    ("传感器", ["U2", "U3"], "IMU 和磁力计在板中部，离板边和电感有距离"),
    ("存储", ["U10", "U11", "CARD1"], "Flash 与 TF 卡靠右边，TF 卡口朝外"),
    ("电源与充电", ["U5", "U8", "L1", "U13", "U14", "CN1", "SW1"], "充电、电量计和负载开关集中在下部，开机键在下边"),
    ("指示与接口", ["U9", "LED1", "X1", "VTRG1"], "RGB 指示灯驱动、FPC 和排针在左边"),
    ("USB", ["U7", "D1", "R25", "R26"], "USB-C 贴下边，ESD 紧挨接口"),
]

BRIEF = {
    "kind": "lpiot-design-brief", "version": 2,
    "project": {"name": "MotherBoard（nRF5340 可穿戴主板，演示）", "owner": "donghuixin"},
    "roles": {"X1": "connector", "VTRG1": "connector", "CARD1": "connector", "CN1": "battery", "CRYSTAL1": "crystal", "X2": "crystal",
              "MDBT1": "rf_module", "U1": "diode", "U4": "res"},
    "G0_requirements": {
        "function": "演示：基于 nRF5340（MDBT53 模组）的可穿戴录音与运动记录主板——PDM 麦克风 + ADAU1860 编解码，BMI270 + BMM150 运动与方向，TF 卡和 64 Mbit Flash 存储，USB-C 充电（BQ25120 + BQ27220 电量计），RGB 指示灯、按键，FPC 接副板",
        "power": {"source": "1S 锂电，USB-C 5 V 充电", "peak_ma": 120, "sleep_ua": 20},
        "wireless": "BLE 5.3（模组自带天线）",
        "environment": "可穿戴，0–45 °C，塑料外壳",
        "fab": {"layers": 6, "thickness_mm": 1.6, "fab": "JLC", "tier": "6 层 JLC06161H-3313，盘中孔树脂塞孔"},
    },
    "G1_mechanical": {
        "outline": {"shape": "rect", "w_mm": W, "h_mm": H, "file": ""},
        "enclosure": {"material": "塑料", "max_height_top_mm": 3.5, "max_height_bottom_mm": 1.0},
        "holes": "无",
        "fixed": [fixed("U7", "USB-C 接口", "bottom", "外壳下端开孔"), fixed("X1", "FPC 座", "left", "排线从左侧接副板"),
                  fixed("CARD1", "TF 卡座", "right", "外壳右侧卡槽"), fixed("SW1", "按键", "bottom", "外壳按键位置")],
        "keepouts": "无",
    },
    "G2_partition": {
        "blocks": [{"name": n, "parts": ps, "region": region(ps), "why": w} for n, ps, w in BLOCKS],
        "signal_flow": "USB-C(下) → 充电与电量计(下左) → 负载开关 → 1.8 V / 3.3 V → 主控模组(上)；麦克风与编解码(左) → I2S → 主控；传感器(中) → I2C → 主控；TF 卡与 Flash(右) → SPI → 主控",
        "layout_review": {"screenshot": "motherboard-layout.png", "notes": "作者原始布局"},
    },
    "G3_layout_check": {"report": "待填：layout_lint.py 生成的 JSON 报告路径", "accepted_exceptions": "无"},
    "G4_routing_plan": {
        "stackup": [{"layer": "F.Cu", "use": "器件与信号"}, {"layer": "In1.Cu", "use": "参考地 1"}, {"layer": "In2.Cu", "use": "电源层"},
                    {"layer": "In3.Cu", "use": "数字信号"}, {"layer": "In4.Cu", "use": "参考地 2"}, {"layer": "B.Cu", "use": "信号与少量器件"}],
        "priorities": "待填：在扩展里“从板子梳理”后逐档确认",
        "diff_pairs": [{"p": "USB_D+", "n": "USB_D-", "impedance_ohm": 90, "skew_mm": 0.5}],
        "power_nets": [{"net": "V_BAT", "current_ma": 300, "width_mm": 0.4}, {"net": "VUSB", "current_ma": 500, "width_mm": 0.6},
                       {"net": "3V3", "current_ma": 150, "width_mm": 0.25}, {"net": "+1.8V", "current_ma": 100, "width_mm": 0.24}],
        # 等长组由用户决定（演示：几 MHz 的 JTAG 和 25 MHz 的 SD 卡 SPI 电气上并不需要等长，这里是“用户要求等长”的示例）
        "length_groups": [{"name": "JTAG 烧写口", "nets": ["TCK", "TMS", "TDI", "TDO"], "tol_mm": 0.05},
                          {"name": "TF 卡 SPI", "nets": ["SPI_CLK_SD", "SPI_MOSI_SD", "SPI_MISO_SD", "SPI_CS_SD"], "tol_mm": 0.1}],
        # 检查用的约束（可选）：6 层 JLC 盘中孔树脂塞孔；作者习惯圆弧拐角；X1 是 FPC 座，几根网络按名字被误认成晶振
        "constraints": {k: v for k, v in json.loads((D / "motherboard-constraints.json").read_text(encoding="utf-8")).items() if k != "length_groups"},
        "acceptance": {"route_lint_min_score": 75, "drc_zero": True, "human_review": True},
    },
    "G5_finish": {
        "silk": {"process": "标准丝印", "text_height_mm": 1.0, "line_width_mm": 0.153, "pad_clearance_mm": 0.15, "designators": "只印关键器件",
                 "orientation": "0° 和 90°", "polarity": "芯片 1 脚圆点，LED 阴极横杠，排针 1 脚方焊盘",
                 "labels": [{"ref": "J1", "text": "SWD"}], "board_marking": {"name": "MotherBoard", "version": "V1.0"}, "warnings": "无",
                 "compliance": "无", "jlc_order_no": "板厂默认位置", "bottom_silk": "不需要",
                 "review": {"screenshot": "待填：用户看过的丝印截图", "polarity_checked": "待填：是否已对照原理图逐个核对极性器件和 1 脚标记？（已核对）"}},
        "annotation": {"scheme": "保持现状", "back_annotated": "没有改动", "bom": ""},
        "teardrops": {"policy": "全部焊盘与过孔", "exclude_rf_diff": "去掉", "done": "已执行并重新铺铜"},
        "report": "待填：finish_lint.py --json 的报告路径",
        "accepted_exceptions": "无",
    },
    "G6_acceptance": {"route_report": "待填", "drc_errors": "待填", "screenshots": "待填"},
    "confirmations": {},
}


def main(out=None):
    d = Path(out or D)
    (d / "motherboard-brief.json").write_text(json.dumps(BRIEF, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {d}/motherboard-brief.json")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
