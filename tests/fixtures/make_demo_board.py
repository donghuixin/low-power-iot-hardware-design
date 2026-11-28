#!/usr/bin/env python3
"""演示板：一块 50 × 32 mm 的 BLE 传感器节点（nRF52 + 32 MHz 晶振 + 片状天线 + USB-C + 降压 DCDC + IMU + 按键 + LED）。

    python make_demo_board.py [输出目录]      → demo-node.kicad_pcb、demo-node-brief.json

走线全部按八方向、只用 135° 拐角布成，只留下几处真实的问题，用来演示检查与修复：
  - SCL 有两段任意角度的斜线（RTG-01）；INT1 有 Z 形微折（RTG-06，也带出直角）；LED 有一个直角拐角（RTG-04）
  - IMU 的去耦电容 C8 放在 7 mm 外（RTP-01）；USB 的 ESD 管 D1 放在芯片旁、离接口 11 mm（RTP-05）
  - 测试点 TP1 压进天线 3 mm 净空区（LAY-06）；按键 SW1 沿右边的位置和外壳开孔差 2 mm（LAY-03）
其余网络（射频、晶振、USB 差分、开关节点、电源）都是合格的走法，修复后板上不应再有任何直角。
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_route_fixtures import PCB  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import design_gate as DG  # noqa: E402

NETS = ["", "GND", "VDD", "VBUS", "SW", "DEC1", "XIN", "XOUT", "USB_DP", "USB_DM", "RF_OUT", "RF_ANT",
        "SDA", "SCL", "INT1", "BTN", "LED", "TEST"]
T, B = "F.Cu", "B.Cu"


def check_path(pts, allow_bad=False):
    """生成时自检：每段八方向、拐角只有 135°（故意留的问题除外）。"""
    if allow_bad:
        return
    for a, b in zip(pts, pts[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        assert abs(dx) < 1e-9 or abs(dy) < 1e-9 or abs(abs(dx) - abs(dy)) < 1e-9, (a, b)
    for a, b, c in zip(pts, pts[1:], pts[2:]):
        u, v = (a[0] - b[0], a[1] - b[1]), (c[0] - b[0], c[1] - b[1])
        cosv = (u[0] * v[0] + u[1] * v[1]) / (math.hypot(*u) * math.hypot(*v))
        assert cosv < -0.7, f"拐角不是 135°：{a} {b} {c}"


def board():
    p = PCB(NETS, (50.0, 32.0))
    route = p.path

    def path(pts, net, w=0.2, layer=T, bad=False):
        check_path(pts, bad)
        route(pts, net, w, layer)

    # ---------------- 器件 ----------------
    p.fp("U1", 0, 0, 0, [("1", 19.0, 14.5, 0.8, 0.3, "XIN"), ("2", 19.0, 15.5, 0.8, 0.3, "XOUT"),
                         ("3", 19.0, 16.5, 0.8, 0.3, "USB_DP"), ("4", 19.0, 17.5, 0.8, 0.3, "USB_DM"),
                         ("5", 25.0, 14.5, 0.8, 0.3, "SDA"), ("6", 25.0, 15.5, 0.8, 0.3, "SCL"), ("7", 25.0, 16.5, 0.8, 0.3, "INT1"),
                         ("8", 21.0, 13.0, 0.3, 0.8, "DEC1"), ("9", 23.0, 13.0, 0.3, 0.8, "RF_OUT"), ("10", 24.0, 13.0, 0.3, 0.8, "BTN"),
                         ("11", 21.0, 19.0, 0.3, 0.8, "LED"), ("12", 22.0, 19.0, 0.3, 0.8, "VDD"),
                         ("EP", 22.0, 16.0, 3.0, 3.0, "GND")], "nRF52832")
    for vx in (21.0, 22.0, 23.0):
        for vy in (15.0, 16.0, 17.0):
            p.via(vx, vy, "GND")
    p.fp("C1", 0, 0, 0, [("1", 21.0, 11.3, 0.5, 0.5, "DEC1"), ("2", 21.0, 10.3, 0.5, 0.5, "GND")], "100nF")
    p.fp("Y1", 0, 0, 0, [("1", 16.8, 14.5, 0.8, 0.6, "XIN"), ("2", 16.8, 15.5, 0.8, 0.6, "XOUT")], "32MHz")
    p.fp("C4", 0, 0, 0, [("1", 15.3, 14.5, 0.5, 0.5, "XIN"), ("2", 14.3, 14.5, 0.5, 0.5, "GND")], "12pF")
    p.fp("C5", 0, 0, 0, [("1", 15.3, 15.5, 0.5, 0.5, "XOUT"), ("2", 14.3, 15.5, 0.5, 0.5, "GND")], "12pF")
    p.fp("J1", 0, 0, 0, [("A6", 2.0, 16.5, 1.2, 0.6, "USB_DP"), ("A7", 2.0, 17.5, 1.2, 0.6, "USB_DM"),
                         ("A4", 2.0, 20.0, 1.2, 0.6, "VBUS"), ("A1", 2.0, 21.0, 1.2, 0.6, "GND")], "USB-C")
    p.fp("D1", 0, 0, 0, [("1", 13.0, 16.5, 0.6, 0.6, "USB_DP"), ("2", 13.0, 17.5, 0.6, 0.6, "USB_DM"), ("3", 13.0, 18.8, 0.6, 0.6, "GND")], "ESD5V")
    p.fp("C7", 0, 0, 0, [("1", 3.8, 23.0, 0.5, 0.5, "VBUS"), ("2", 2.8, 23.0, 0.5, 0.5, "GND")], "10uF")
    p.fp("U2", 0, 0, 0, [("1", 7.0, 26.0, 1.0, 0.6, "VBUS"), ("2", 9.4, 26.0, 1.0, 0.6, "SW"), ("3", 8.2, 27.6, 0.6, 1.0, "GND")], "TPS62840")
    p.fp("L1", 0, 0, 0, [("1", 11.6, 26.0, 1.4, 1.4, "SW"), ("2", 14.0, 26.0, 1.4, 1.4, "VDD")], "2.2uH")
    p.fp("C3", 0, 0, 0, [("1", 16.0, 26.0, 0.5, 0.5, "VDD"), ("2", 16.0, 25.0, 0.5, 0.5, "GND")], "10uF")
    p.fp("C2", 0, 0, 0, [("1", 22.0, 20.6, 0.5, 0.5, "VDD"), ("2", 23.0, 20.6, 0.5, 0.5, "GND")], "100nF")
    p.fp("D2", 0, 0, 0, [("1", 17.4, 21.0, 0.6, 0.6, "LED"), ("2", 16.4, 21.0, 0.6, 0.6, "GND")], "LED")
    p.fp("U3", 0, 0, 0, [("1", 31.8, 14.5, 0.8, 0.3, "SDA"), ("2", 31.8, 15.5, 0.8, 0.3, "SCL"), ("3", 31.8, 16.5, 0.8, 0.3, "INT1"),
                         ("4", 33.0, 18.6, 0.3, 0.8, "VDD"), ("5", 33.0, 13.6, 0.3, 0.8, "GND")], "BMI270")
    p.fp("C8", 0, 0, 0, [("1", 35.4, 24.0, 0.5, 0.5, "VDD"), ("2", 36.4, 24.0, 0.5, 0.5, "GND")], "100nF")
    p.fp("L2", 0, 0, 0, [("1", 35.4, 7.0, 0.6, 0.5, "RF_OUT"), ("2", 36.6, 7.0, 0.6, 0.5, "RF_ANT")], "3.9nH")
    p.fp("ANT1", 0, 0, 0, [("1", 43.5, 1.25, 1.0, 1.5, "RF_ANT"), ("2", 48.5, 1.25, 1.0, 1.5, "GND")], "2.4GHz")
    p.fp("SW1", 0, 0, 0, [("1", 48.0, 9.0, 1.2, 0.8, "BTN"), ("2", 48.0, 11.0, 1.2, 0.8, "GND")], "KEY")
    p.fp("TP1", 0, 0, 0, [("1", 41.5, 4.0, 1.0, 1.0, "TEST", "circle")])

    # ---------------- 走线（合格部分）----------------
    path([(21.0, 13.0), (21.0, 11.3)], "DEC1"); path([(21.0, 10.3), (21.0, 9.5)], "GND"); p.via(21.0, 9.5, "GND")
    path([(19.0, 14.5), (16.8, 14.5), (15.3, 14.5)], "XIN"); path([(19.0, 15.5), (16.8, 15.5), (15.3, 15.5)], "XOUT")
    for y in (14.5, 15.5):
        path([(14.3, y), (13.6, y)], "GND"); p.via(13.6, y, "GND")
    path([(2.0, 16.5), (13.0, 16.5), (19.0, 16.5)], "USB_DP"); path([(2.0, 17.5), (13.0, 17.5), (19.0, 17.5)], "USB_DM")
    path([(13.0, 18.8), (13.0, 19.7)], "GND"); p.via(13.0, 19.7, "GND")
    path([(2.0, 21.0), (3.0, 21.0)], "GND", 0.3); p.via(3.0, 21.0, "GND")
    path([(2.0, 20.0), (3.6, 20.0), (5.0, 21.4), (5.0, 24.6), (6.4, 26.0), (7.0, 26.0)], "VBUS", 0.5)
    path([(5.0, 23.0), (3.8, 23.0)], "VBUS", 0.5); path([(2.8, 23.0), (2.8, 23.9)], "GND", 0.3); p.via(2.8, 23.9, "GND")
    path([(8.2, 27.6), (8.2, 28.6)], "GND", 0.4); p.via(8.2, 28.6, "GND")
    path([(9.4, 26.0), (11.6, 26.0)], "SW", 0.6)
    path([(14.0, 26.0), (16.0, 26.0), (16.8, 26.0), (18.3, 27.5), (22.0, 27.5), (32.0, 27.5), (33.0, 26.5), (33.0, 24.0), (33.0, 18.6)], "VDD", 0.3)
    path([(16.0, 25.0), (16.0, 24.2)], "GND", 0.3); p.via(16.0, 24.2, "GND")
    path([(22.0, 27.5), (22.0, 20.6), (22.0, 19.0)], "VDD", 0.3)
    path([(23.0, 20.6), (23.0, 21.5)], "GND", 0.3); p.via(23.0, 21.5, "GND")
    path([(16.4, 21.0), (15.6, 21.0)], "GND"); p.via(15.6, 21.0, "GND")
    path([(31.8, 14.5), (25.0, 14.5)], "SDA")
    path([(33.0, 13.6), (33.0, 12.6)], "GND"); p.via(33.0, 12.6, "GND")
    path([(33.0, 24.0), (35.4, 24.0)], "VDD", 0.3); path([(36.4, 24.0), (37.2, 24.0)], "GND"); p.via(37.2, 24.0, "GND")
    path([(23.0, 13.0), (23.0, 10.0), (26.0, 7.0), (35.4, 7.0)], "RF_OUT", 0.35)
    path([(36.6, 7.0), (40.0, 7.0), (43.5, 3.5), (43.5, 1.25)], "RF_ANT", 0.35)
    path([(48.5, 1.25), (48.5, 2.6)], "GND", 0.3); p.via(48.5, 2.6, "GND")
    path([(24.0, 13.0), (24.0, 11.0), (26.0, 9.0), (48.0, 9.0)], "BTN")
    path([(48.0, 11.0), (46.9, 11.0)], "GND"); p.via(46.9, 11.0, "GND")

    # ---------------- 故意留下的问题 ----------------
    path([(25.0, 15.5), (26.2, 15.5), (28.4, 15.0), (30.6, 15.5), (31.8, 15.5)], "SCL", bad=True)        # 任意角度
    path([(25.0, 16.5), (27.6, 16.5), (27.6, 16.62), (29.2, 16.62), (29.2, 16.5), (31.8, 16.5)], "INT1", bad=True)  # Z 形微折
    path([(21.0, 19.0), (21.0, 21.0), (17.4, 21.0)], "LED", bad=True)                                     # 直角拐角
    return p


BRIEF = {
    "kind": "lpiot-design-brief", "version": 2,
    "project": {"name": "BLE 运动传感器节点（演示）", "owner": "演示"},
    "roles": {"U1": "soc_rf", "U2": "dcdc", "L2": "rf_match", "U3": "imu"},
    "G0_requirements": {
        "function": "腕戴运动记录器：nRF52 读取 IMU 姿态数据，经 BLE 发到手机，USB-C 充电和烧录",
        "power": {"source": "USB 5 V，板上降压 DCDC 到 3.0 V（演示板不含电池）", "peak_ma": 15, "sleep_ua": 5},
        "wireless": "BLE 5（2.4 GHz 片状天线）",
        "environment": "室内外 -10–45 °C，腕戴，防汗",
        "fab": {"layers": 2, "thickness_mm": 1.0, "fab": "JLC", "tier": "standard"},
    },
    "G1_mechanical": {
        "outline": {"shape": "rect", "w_mm": 50, "h_mm": 32, "file": ""},
        "enclosure": {"material": "塑料", "max_height_top_mm": 2.5, "max_height_bottom_mm": 0.8},
        "holes": "无",
        "fixed": [
            {"ref": "J1", "what": "USB-C", "edge": "left", "along_mm": 13.3, "tol_mm": 1.5, "side": "top", "reason": "外壳左侧 USB 开孔"},
            {"ref": "ANT1", "what": "片状天线", "edge": "top", "tol_mm": 2, "side": "top", "reason": "天线朝外壳顶部，远离手腕"},
            {"ref": "SW1", "what": "按键", "edge": "right", "along_mm": 20, "tol_mm": 1.5, "side": "top", "reason": "外壳右侧按键孔"},
        ],
        "keepouts": "无",
    },
    "G2_partition": {
        "blocks": [
            {"name": "主控", "parts": ["U1", "Y1", "C1", "C2", "C4", "C5"], "region": "center", "why": "四周都要出线"},
            {"name": "射频", "parts": ["L2", "ANT1"], "region": "top-right", "why": "天线在右上角板边"},
            {"name": "USB 与电源", "parts": ["J1", "D1", "C7", "U2", "L1", "C3"], "region": "left-third", "why": "USB 在左侧，开关电源远离天线和 IMU"},
            {"name": "传感器", "parts": ["U3", "C8"], "region": "right", "why": "IMU 远离开关电源和热源"},
            {"name": "人机", "parts": ["SW1", "D2"], "region": "any", "why": "按键贴外壳开孔，LED 靠近导光柱"},
        ],
        "signal_flow": "USB-C(左) 进电 → DCDC(左下) → VDD 沿底边到主控(中)和 IMU(右)；射频从主控上方走到右上角天线；I2C 从主控右侧到 IMU",
        "layout_review": {"screenshot": "demo-layout.png", "notes": "演示"},
    },
    "G3_layout_check": {"report": "待填", "accepted_exceptions": "无"},
    "G4_routing_plan": {
        "stackup": [{"layer": "TOP", "use": "器件与全部信号"}, {"layer": "BOTTOM", "use": "完整地平面，不走线"}],
        "priorities": "待填",
        "diff_pairs": [{"p": "USB_DP", "n": "USB_DM", "impedance_ohm": 90, "skew_mm": 0.5}],
        "power_nets": [{"net": "VBUS", "current_ma": 500, "width_mm": 0.5}, {"net": "VDD", "current_ma": 50, "width_mm": 0.3}],
        "acceptance": {"route_lint_min_score": 85, "drc_zero": True, "human_review": True},
    },
    "G5_finish": DG.finish_template(),
    "G6_acceptance": {"route_report": "待填", "drc_errors": "待填", "screenshots": "待填"},
    "confirmations": {},
}


def main(out=None):
    d = Path(out) if out else Path(__file__).resolve().parent
    (d / "demo-node.kicad_pcb").write_text(board().text(), encoding="utf-8")
    (d / "demo-node-brief.json").write_text(json.dumps(BRIEF, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
