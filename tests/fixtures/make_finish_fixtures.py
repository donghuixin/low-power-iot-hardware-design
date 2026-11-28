#!/usr/bin/env python3
"""出图前检查（丝印、位号编号、泪滴）的测试板，30 × 20 mm，2 层，KiCad 坐标 y 向下。

  finish-good.kicad_pcb  每条规则都满足：位号贴着自己的器件、只用 0°/90°、1 脚和极性有标记、板名版本和接口说明齐全、
                         订单号占位、过孔和插件孔都有泪滴、射频线上没有泪滴
  finish-bad.kicad_pcb   每条规则各违反一次（见 bad() 里的注释）
  finish-brief.json      G5 的决定（丝印工艺、位号策略、说明标注、泪滴策略等）

用法：python make_finish_fixtures.py [输出目录]
"""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_route_fixtures import PCB  # noqa: E402

NETS = ["", "GND", "VDD", "TX", "SIG", "LED_K", "BTN", "RF_ANT", "NC1"]
SIZE = (30.0, 20.0)
REF = {"h": 1.0, "t": 0.15}


def tear(c, d, r):
    """泪滴多边形：从焊盘 / 过孔中心 c 沿走线方向 d 张开，半径 r。"""
    L = math.hypot(*d)
    ux, uy = d[0] / L, d[1] / L
    px, py = -uy, ux
    return [(round(c[0] + px * r, 4), round(c[1] + py * r, 4)), (round(c[0] + ux * (r + 0.8), 4), round(c[1] + uy * (r + 0.8), 4)),
            (round(c[0] - px * r, 4), round(c[1] - py * r, 4)), (round(c[0] - ux * r * 0.5, 4), round(c[1] - uy * r * 0.5, 4))]


def parts(p, ok):
    u1_pads = [(str(i + 1), -2.2, -1.5 + i, 0.8, 0.3, net) for i, net in enumerate(["TX", "SIG", "BTN", "GND"])] + \
              [(str(i + 5), 2.2, 1.5 - i, 0.8, 0.3, net) for i, net in enumerate(["VDD", "LED_K", "NC1", "RF_ANT"])]
    pin1 = [(-2.6, -2.3, -1.8, -2.3, 0.15)]
    p.fp("U1", 12, 10, 0, u1_pads, "STM32G030",
         silk=dict(REF, at=(0, -3.4, 0)) if ok else dict(REF, at=(0, -3.4, 180)),     # 坏板：位号倒着（SLK-09）
         lines=pin1 if ok else [])                                                     # 坏板：没有 1 脚标记（SLK-11）
    p.fp("R1", 22, 5, 0, [("1", -0.8, 0, 0.8, 0.9, "SIG"), ("2", 0.8, 0, 0.8, 0.9, "VDD")], "10k",
         silk=dict(REF, at=(0, -1.6, 0)) if ok else dict(REF, at=(0, 2.7, 0)))         # 坏板：R1 的位号放到 C1 旁边（SLK-07）
    p.fp("C1", 22, 9, 0, [("1", -0.8, 0, 0.8, 0.9, "VDD"), ("2", 0.8, 0, 0.8, 0.9, "GND")], "100nF",
         silk=dict(REF, at=(0, -1.6, 0)) if ok else dict(REF, at=(0.9, -0.7, 0)))     # 坏板：压到焊盘（SLK-01）
    p.fp("D1", 22, 15, 0, [("1", -0.8, 0, 0.8, 0.9, "LED_K"), ("2", 0.8, 0, 0.8, 0.9, "VDD")], "LED red",
         silk=dict(REF, at=(0, -1.6, 0), hide=not ok),                                  # 坏板：位号隐藏（SLK-06）
         lines=[(-1.6, -0.6, -1.6, 0.6, 0.15)])
    p.fp("J1", 4, 10, 0, [("1", 0, -2.54, 1.7, 1.7, "VDD", "rect"), ("2", 0, 0, 1.7, 1.7, "TX", "circle"), ("3", 0, 2.54, 1.7, 1.7, "GND", "circle")],
         "Header 1x3", silk=dict(REF, at=(0, -4.6, 0)), lines=[(-1.4, -3.0, -1.4, -2.1, 0.15)], tht=("1", "2", "3"))
    p.fp("SW1", 12, 17, 0, [("1", -1.5, 0, 1.0, 0.9, "BTN"), ("2", 1.5, 0, 1.0, 0.9, "GND")], "TS-1187",
         silk=dict(REF, at=(3.6, 0, 0)))
    if not ok:
        p.fp("R?", 26, 12, 0, [("1", -0.8, 0, 0.8, 0.9, "NC1"), ("2", 0.8, 0, 0.8, 0.9, "GND")], "1k", silk=dict(REF, at=(0, -1.6, 0)))      # ANN-01
        p.fp("C2", 8, 3, 0, [("1", -0.8, 0, 0.8, 0.9, "VDD"), ("2", 0.8, 0, 0.8, 0.9, "GND")], "1uF", silk=dict(REF, at=(0, -1.6, 0)))
        p.fp("C2", 26, 6.5, 0, [("1", -0.8, 0, 0.8, 0.9, "VDD"), ("2", 0.8, 0, 0.8, 0.9, "GND")], "1uF", silk=dict(REF, at=(0, -1.6, 0)))      # ANN-02
        p.fp("C3", 17, 4.5, 0, [("1", -0.8, 0, 0.8, 0.9, "VDD"), ("2", 0.8, 0, 0.8, 0.9, "GND")], "10k", silk=dict(REF, at=(0, -1.6, 0)))     # ANN-03
        p.fp("R4", 26, 17, 0, [("1", -0.8, 0, 0.8, 0.9, "VDD"), ("2", 0.8, 0, 0.8, 0.9, "BTN")], "10k", silk=dict(REF, at=(0, -1.6, 0)))    # ANN-04 跳号


def copper(p, ok):
    # TX：J1.2（插件孔）→ U1.1；SIG：U1.2 → 过孔 → 底层 → 过孔 → R1.1；RF_ANT：U1.8 → 过孔（射频，不加泪滴）
    p.path([(4.0, 10.0), (6.0, 10.0), (7.5, 8.5), (9.8, 8.5)], "TX")
    p.path([(9.8, 9.5), (8.5, 9.5), (8.5, 12.5)], "SIG")
    p.via(8.5, 12.5, "SIG")
    p.path([(8.5, 12.5), (16.5, 12.5)], "SIG", layer="B.Cu")
    p.via(16.5, 12.5, "SIG")
    p.path([(16.5, 12.5), (16.5, 6.0), (17.5, 5.0), (21.2, 5.0)], "SIG")
    p.path([(14.2, 8.5), (16.8, 8.5)], "RF_ANT", 0.3)
    p.via(16.8, 8.5, "RF_ANT")
    if ok:
        p.teardrop("TX", tear((4.0, 10.0), (1, 0), 0.85))
        for c, d, L in (((8.5, 12.5), (0, -1), "F.Cu"), ((8.5, 12.5), (1, 0), "B.Cu"), ((16.5, 12.5), (-1, 0), "B.Cu"), ((16.5, 12.5), (0, -1), "F.Cu")):
            p.teardrop("SIG", tear(c, d, 0.3), L)
    else:
        p.teardrop("SIG", tear((8.5, 12.5), (0, -1), 0.3))                       # 只在一处加了：其余三处过孔连接和 J1.2 缺泪滴（TDR-01）
        p.teardrop("RF_ANT", tear((16.8, 8.5), (-1, 0), 0.3))                   # 射频线上加了泪滴（TDR-02）


def marks(p, ok):
    if ok:
        p.silk_text("FINISH-DEMO V1.0", 15, 1.6)
        p.silk_text("UART", 4, 14.6)
        p.silk_text("RST", 12, 18.8)
        p.silk_text("3V3 ONLY", 25.5, 19.0)
        p.silk_text("JLCJLCJLCJLC", 6.5, 4.0)
        p.silk_text("BOTTOM", 15, 10, layer="B.SilkS", mirror=True)
    else:
        p.silk_text("FINISH-DEMO", 15, 1.6)                                      # 没有版本号（SLK-12）
        p.silk_text("UART", 4, 14.0, h=0.6, t=0.08)                              # 字高、线宽不够（SLK-02 / SLK-03）
        p.silk_text("RST", 15.0, 17.0)                                           # 和 SW1 的位号重叠（SLK-05）
        p.silk_text("V1", 29.6, 10, rot=90)                                      # 超出板框（SLK-04）
        p.silk_text("TX", 7.0, 11.6, rot=45)                                     # 斜着（SLK-09）
        p.silk_text("BOTTOM", 15, 10, layer="B.SilkS")                           # 底面没镜像（SLK-10）
        # 没有 JLCJLCJLCJLC 占位（SLK-13），没有警示“3V3 ONLY”（SLK-12）


def board(ok):
    p = PCB(NETS, SIZE)
    p.chamfer = 0.5
    parts(p, ok)
    copper(p, ok)
    marks(p, ok)
    return p


BRIEF = {
    "kind": "lpiot-design-brief", "version": 2,
    "project": {"name": "finish-demo", "owner": "测试"},
    "roles": {},
    "G5_finish": {
        "silk": {
            "process": "标准丝印", "text_height_mm": 1.0, "line_width_mm": 0.15, "pad_clearance_mm": 0.15,
            "designators": "全部显示", "orientation": "0° 和 90°",
            "polarity": "芯片 1 脚圆点，LED 阴极横杠，排针 1 脚方焊盘加短线",
            "labels": [{"ref": "J1", "text": "UART"}, {"ref": "SW1", "text": "RST"}],
            "board_marking": {"name": "FINISH-DEMO", "version": "V1.0"},
            "warnings": ["3V3 ONLY"], "compliance": "无", "jlc_order_no": "指定位置", "bottom_silk": "需要",
            "review": {"screenshot": "silk-top.png", "polarity_checked": "已核对"},
        },
        "annotation": {"scheme": "按位置重新编号", "back_annotated": "是", "bom": ""},
        "teardrops": {"policy": "仅过孔和插件孔", "exclude_rf_diff": "去掉", "done": "已执行并重新铺铜"},
        "report": "finish-lint.json",
        "accepted_exceptions": "无",
    },
}


def main(out=None):
    d = Path(out or Path(__file__).resolve().parent)
    (d / "finish-good.kicad_pcb").write_text(board(True).text(gnd_zone=False), encoding="utf-8")
    (d / "finish-bad.kicad_pcb").write_text(board(False).text(gnd_zone=False), encoding="utf-8")
    (d / "finish-brief.json").write_text(json.dumps(BRIEF, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {d}/finish-good.kicad_pcb、finish-bad.kicad_pcb、finish-brief.json")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
