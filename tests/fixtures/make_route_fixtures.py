#!/usr/bin/env python3
"""生成布线检查与修复的测试板（2 层，40 × 30 mm，KiCad 坐标 y 向下）。

  route-good.kicad_pcb  同样的连接，全部八方向走线、沿焊盘长轴出线、底层整层地
  route-bad.kicad_pcb   注入典型烂走线：任意角度、锐角拐角、锐角 T 分支、Z 形抖动、斜着出焊盘、
                        底层长斜跳线、晶振线打过孔

用法：python make_route_fixtures.py [输出目录]
"""
import sys
import uuid
from pathlib import Path

W, H = 40.0, 30.0
NETS = ["", "GND", "VDD", "SDA", "SCL", "LED", "XIN", "XOUT", "MISO", "BTN"]


class PCB:
    def __init__(self):
        self.items = []

    def fp(self, ref, x, y, rot, pads):
        s = [f'  (footprint "test:{ref}" (layer "F.Cu") (at {x} {y}{" " + str(rot) if rot else ""})',
             f'    (property "Reference" "{ref}" (at 0 0 0) (layer "F.SilkS"))']
        for name, px, py, w, h, net in pads:
            s.append(f'    (pad "{name}" smd rect (at {px} {py}{" " + str(rot) if rot else ""}) (size {w} {h}) (layers "F.Cu") (net {NETS.index(net)} "{net}"))')
        s.append("  )")
        self.items.append("\n".join(s))

    def seg(self, a, b, net, w=0.2, layer="F.Cu"):
        self.items.append(f'  (segment (start {a[0]} {a[1]}) (end {b[0]} {b[1]}) (width {w}) (layer "{layer}") (net {NETS.index(net)}) (uuid "{uuid.UUID(int=len(self.items))}"))')

    def path(self, pts, net, w=0.2, layer="F.Cu"):
        for a, b in zip(pts, pts[1:]):
            self.seg(a, b, net, w, layer)

    def via(self, x, y, net, d=0.6):
        self.items.append(f'  (via (at {x} {y}) (size {d}) (drill 0.3) (layers "F.Cu" "B.Cu") (net {NETS.index(net)}))')

    def text(self, gnd_zone=True):
        out = ['(kicad_pcb (version 20240108) (generator route_fixture)', '  (general (thickness 1.6))',
               '  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))']
        out += [f'  (net {i} "{n}")' for i, n in enumerate(NETS)]
        e = [(0, 0), (W, 0), (W, H), (0, H), (0, 0)]
        for a, b in zip(e, e[1:]):
            out.append(f'  (gr_line (start {a[0]} {a[1]}) (end {b[0]} {b[1]}) (layer "Edge.Cuts") (width 0.1))')
        if gnd_zone:
            pts = " ".join(f"(xy {x} {y})" for x, y in [(0.5, 0.5), (W - 0.5, 0.5), (W - 0.5, H - 0.5), (0.5, H - 0.5)])
            out.append(f'  (zone (net 1) (net_name "GND") (layer "B.Cu") (polygon (pts {pts})) (filled_polygon (layer "B.Cu") (pts {pts})))')
        return "\n".join(out + self.items) + "\n)\n"


def parts(p):
    # U1：一列 0.3 × 1.0 mm 的竖向焊盘（长轴沿 y），在 x = 10…14，y = 15
    pins = [("1", "SDA"), ("2", "SCL"), ("3", "LED"), ("4", "MISO"), ("5", "BTN"), ("6", "VDD")]
    p.fp("U1", 12, 15, 0, [(n, -2.5 + i * 1.0, 0, 0.3, 1.0, net) for i, (n, net) in enumerate(pins)])
    # 0603 电阻：横向焊盘 0.8 × 0.9（近似方形，两条轴都可出线）；R1 SDA 上拉、R2 SCL 上拉、R3 LED
    p.fp("R1", 25, 6, 0, [("1", -0.8, 0, 0.8, 0.9, "SDA"), ("2", 0.8, 0, 0.8, 0.9, "VDD")])
    p.fp("R2", 25, 10, 0, [("1", -0.8, 0, 0.8, 0.9, "SCL"), ("2", 0.8, 0, 0.8, 0.9, "VDD")])
    p.fp("R3", 30, 22, 0, [("1", -0.8, 0, 0.8, 0.9, "LED"), ("2", 0.8, 0, 0.8, 0.9, "GND")])
    # 晶振 Y1：两个 0.6 × 1.2 焊盘（长轴沿 y）
    p.fp("Y1", 6, 24, 0, [("1", -1.2, 0, 0.6, 1.2, "XIN"), ("2", 1.2, 0, 0.6, 1.2, "XOUT")])
    p.fp("U2", 6, 20, 0, [("XI", -1.2, 0, 0.3, 1.0, "XIN"), ("XO", 1.2, 0, 0.3, 1.0, "XOUT")])
    # J1：MISO 与 BTN 的测试点（长轴沿 y 的 0.6 × 1.4 焊盘）
    p.fp("J1", 34, 15, 0, [("1", -1.0, 0, 0.6, 1.4, "MISO"), ("2", 1.0, 0, 0.6, 1.4, "BTN")])


def good():
    p = PCB(); parts(p)
    # SDA：U1.1 (9.5,15) 向上直出 → 45° → 水平到 R1.1 (24.2,6)
    p.path([(9.5, 15), (9.5, 11), (14.5, 6), (24.2, 6)], "SDA")
    p.path([(10.5, 15), (10.5, 12), (12.5, 10), (24.2, 10)], "SCL")
    p.path([(11.5, 15), (11.5, 18), (15.5, 22), (29.2, 22)], "LED")
    p.path([(12.5, 15), (12.5, 17), (14.0, 18.5), (31.5, 18.5), (33.0, 17), (33.0, 15)], "MISO")
    p.path([(13.5, 15), (13.5, 13), (14.5, 12), (33.0, 12), (35.0, 14), (35.0, 15)], "BTN")
    p.path([(25.8, 6), (27.5, 6), (27.5, 10), (25.8, 10)], "VDD", 0.3)
    p.path([(14.5, 15), (14.5, 16.5), (16.0, 16.5), (17.0, 15.5), (20.0, 15.5)], "VDD", 0.3)
    p.path([(4.8, 24), (4.8, 20)], "XIN")
    p.path([(7.2, 24), (7.2, 20)], "XOUT")
    p.via(20.0, 15.5, "VDD"); p.via(27.5, 8, "VDD")
    p.path([(30.8, 22), (32.0, 22)], "GND", 0.3); p.via(32.0, 22, "GND")
    return p


def bad():
    p = PCB(); parts(p)
    p.path([(9.5, 15), (24.2, 6)], "SDA")                                  # RTG-01 任意角度 + RTG-07 斜出焊盘
    p.path([(10.5, 15), (10.5, 12), (13.0, 11.0), (18.0, 10.0), (24.2, 10)], "SCL")   # 任意角度折线
    p.path([(11.5, 15), (11.5, 18), (20.0, 22), (18.0, 22), (29.2, 22)], "LED")      # 锐角拐角（20,22 处折回）
    p.path([(12.5, 15), (12.5, 17), (14.0, 18.5), (22.0, 18.5), (22.0, 18.65), (31.5, 18.65), (33.0, 17), (33.0, 15)], "MISO")  # Z 形抖动
    p.path([(13.5, 15), (13.5, 13), (14.5, 12), (33.0, 12), (35.0, 14), (35.0, 15)], "BTN")
    p.seg((20.0, 12), (23.0, 13.2), "BTN")                                  # 锐角 T 分支的残桩（BTN 上 22° 斜出）
    p.path([(25.8, 6), (27.5, 6), (27.5, 10), (25.8, 10)], "VDD", 0.3)
    p.path([(14.5, 15), (14.5, 16.5), (16.0, 16.5), (17.0, 15.5), (20.0, 15.5)], "VDD", 0.3)
    p.via(20.0, 15.5, "VDD"); p.via(27.5, 8, "VDD")
    p.path([(4.8, 24), (4.8, 22.5)], "XIN"); p.via(4.8, 22.5, "XIN"); p.via(4.8, 21.3, "XIN")             # 晶振线打两个过孔绕到底层
    p.path([(4.8, 22.5), (4.8, 21.3)], "XIN", layer="B.Cu"); p.path([(4.8, 21.3), (4.8, 20)], "XIN")
    p.path([(7.2, 24), (8.2, 22.0), (7.2, 20)], "XOUT")                      # 晶振线 V 形
    p.path([(30.8, 22), (32.0, 22)], "GND", 0.3); p.via(32.0, 22, "GND")
    p.via(3.0, 3.0, "SCL"); p.via(3.0, 27.0, "SCL"); p.path([(3.0, 3.0), (5.0, 27.0)], "SCL", layer="B.Cu"); p.path([(5.0, 27.0), (3.0, 27.0)], "SCL", layer="B.Cu")  # 底层长斜跳线
    return p


def main(out=None):
    d = Path(out) if out else Path(__file__).resolve().parent
    (d / "route-good.kicad_pcb").write_text(good().text(), encoding="utf-8")
    (d / "route-bad.kicad_pcb").write_text(bad().text(), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
