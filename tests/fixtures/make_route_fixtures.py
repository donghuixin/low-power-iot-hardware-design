#!/usr/bin/env python3
"""生成布线检查与修复的测试板（2 层，40 × 30 mm，KiCad 坐标 y 向下）。

  route-good.kicad_pcb  同样的连接，全部八方向走线、沿焊盘长轴出线、底层整层地
  route-bad.kicad_pcb   注入典型烂走线：任意角度、锐角拐角、锐角 T 分支、Z 形抖动、斜着出焊盘、
                        底层长斜跳线、晶振线打过孔
  principles-good.kicad_pcb / principles-bad.kicad_pcb（45 × 36 mm）走线原则：去耦电容与负载电容就近、
                        ESD 靠接口且串在线上、串阻靠驱动端、USB 与 LVDS 差分对、晶振被一般信号挡路（优先级倒挂）、
                        开关节点与模拟输入并行（隔离）

用法：python make_route_fixtures.py [输出目录]
"""
import sys
import uuid
from pathlib import Path

W, H = 40.0, 30.0
NETS = ["", "GND", "VDD", "SDA", "SCL", "LED", "XIN", "XOUT", "MISO", "BTN"]


class PCB:
    def __init__(self, nets=None, size=(W, H)):
        self.items = []
        self.nets = nets or NETS
        self.size = size

    def fp(self, ref, x, y, rot, pads, value=None):
        s = [f'  (footprint "test:{ref}" (layer "F.Cu") (at {x} {y}{" " + str(rot) if rot else ""})',
             f'    (property "Reference" "{ref}" (at 0 0 0) (layer "F.SilkS"))']
        if value:
            s.append(f'    (property "Value" "{value}" (at 0 0 0) (layer "F.Fab"))')
        for name, px, py, w, h, net, *shape in pads:
            sh = shape[0] if shape else "rect"
            s.append(f'    (pad "{name}" smd {sh} (at {px} {py}{" " + str(rot) if rot else ""}) (size {w} {h}) (layers "F.Cu") (net {self.nets.index(net)} "{net}"))')
        s.append("  )")
        self.items.append("\n".join(s))

    def seg(self, a, b, net, w=0.2, layer="F.Cu"):
        self.items.append(f'  (segment (start {a[0]} {a[1]}) (end {b[0]} {b[1]}) (width {w}) (layer "{layer}") (net {self.nets.index(net)}) (uuid "{uuid.UUID(int=len(self.items))}"))')

    def path(self, pts, net, w=0.2, layer="F.Cu"):
        for a, b in zip(pts, pts[1:]):
            self.seg(a, b, net, w, layer)

    def via(self, x, y, net, d=0.6):
        self.items.append(f'  (via (at {x} {y}) (size {d}) (drill 0.3) (layers "F.Cu" "B.Cu") (net {self.nets.index(net)}))')

    def text(self, gnd_zone=True):
        out = ['(kicad_pcb (version 20240108) (generator route_fixture)', '  (general (thickness 1.6))',
               '  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))']
        out += [f'  (net {i} "{n}")' for i, n in enumerate(self.nets)]
        W, H = self.size
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


PNETS = ["", "GND", "VDD", "XIN", "XOUT", "LED", "USB_DP", "USB_DM", "BTN", "LVDS_P", "LVDS_N", "CS", "ADC_IN", "SW", "SCK_R", "SCK"]


def principles(ok):
    """走线原则测试板。ok=True 每条原则都满足；ok=False 每条原则各违反一次。"""
    p = PCB(PNETS, (45.0, 36.0))
    T, B = "F.Cu", "B.Cu"
    p.fp("U1", 0, 0, 0, [("1", 25, 12.5, 0.3, 1.0, "VDD"), ("2", 21, 15, 1.0, 0.3, "XIN"), ("3", 21, 16, 1.0, 0.3, "XOUT"),
                         ("4", 29, 14, 1.0, 0.3, "USB_DP"), ("5", 29, 15, 1.0, 0.3, "USB_DM"), ("6", 29, 17, 1.0, 0.3, "BTN"),
                         ("7", 29, 19, 1.0, 0.3, "LVDS_P"), ("8", 29, 20, 1.0, 0.3, "LVDS_N"),
                         ("9", 23, 21.5, 0.3, 1.0, "ADC_IN"), ("10", 27, 12.5, 0.3, 1.0, "SCK_R"), ("EP", 25, 17, 3.0, 3.0, "GND")])
    p.via(25, 17, "GND")
    p.fp("Y1", 0, 0, 0, [("1", 17.6, 15, 0.8, 0.6, "XIN"), ("2", 17.6, 16, 0.8, 0.6, "XOUT")], "32MHz")
    p.fp("J1", 0, 0, 0, [("A6", 42, 14, 1.2, 0.6, "USB_DP"), ("A7", 42, 15, 1.2, 0.6, "USB_DM"), ("3", 42, 17, 1.2, 0.6, "BTN")])
    p.fp("J3", 0, 0, 0, [("1", 42, 23, 1.2, 0.6, "LVDS_P"), ("2", 42, 24, 1.2, 0.6, "LVDS_N")])
    p.fp("J2", 0, 0, 0, [("1", 39, 30, 1.0, 0.6, "ADC_IN")])
    p.fp("L1", 0, 0, 0, [("1", 28, 33, 1.0, 1.0, "SW")], "2.2uH")
    p.fp("U3", 0, 0, 0, [("SW", 37, 33, 1.0, 1.0, "SW")])
    p.fp("U2", 0, 0, 0, [("1", 27, 4.5, 0.6, 0.6, "SCK")])
    p.fp("TP1", 0, 0, 0, [("1", 19.2, 13.5, 0.5, 0.5, "LED", "circle")])
    p.fp("TP2", 0, 0, 0, [("1", 19.2, 19.5, 0.5, 0.5, "LED", "circle")])
    # 去耦电容 C1（100nF）：好板贴着 VDD 引脚、地焊盘旁有地过孔；坏板放在 13 mm 外、地焊盘没有过孔
    if ok:
        p.fp("C1", 0, 0, 0, [("1", 25, 10.5, 0.5, 0.5, "VDD"), ("2", 25, 9.5, 0.5, 0.5, "GND")], "100nF")
        p.path([(25, 12.5), (25, 10.5)], "VDD", 0.3); p.path([(25, 9.5), (25.9, 9.5)], "GND", 0.3); p.via(25.9, 9.5, "GND")
    else:
        p.fp("C1", 0, 0, 0, [("1", 17, 7, 0.5, 0.5, "VDD"), ("2", 16, 7, 0.5, 0.5, "GND")], "100nF")
        p.path([(25, 12.5), (25, 7), (17, 7)], "VDD", 0.3)
    # 晶振与负载电容：坏板的负载电容放在 8 mm 外；一般信号 LED 从晶振和芯片之间直穿，晶振线只好打过孔钻过去
    cx, gx, vx = (16.6, 15.6, 14.9) if ok else (9.0, 8.0, 7.3)
    p.fp("C4", 0, 0, 0, [("1", cx, 15, 0.5, 0.5, "XIN"), ("2", gx, 15, 0.5, 0.5, "GND")], "12pF")
    p.fp("C5", 0, 0, 0, [("1", cx, 16, 0.5, 0.5, "XOUT"), ("2", gx, 16, 0.5, 0.5, "GND")], "12pF")
    for y in (15, 16):
        p.path([(gx, y), (vx, y)], "GND"); p.via(vx, y, "GND")
    if ok:
        p.path([(21, 15), (17.6, 15), (cx, 15)], "XIN"); p.path([(21, 16), (17.6, 16), (cx, 16)], "XOUT")
        p.path([(19.2, 13.5), (12.5, 13.5), (12.5, 19.5), (19.2, 19.5)], "LED")
    else:
        for y, nm in ((15, "XIN"), (16, "XOUT")):
            p.path([(21, y), (20.05, y)], nm); p.via(20.05, y, nm); p.path([(20.05, y), (18.5, y)], nm, layer=B); p.via(18.5, y, nm)
            p.path([(18.5, y), (17.6, y), (cx, y)], nm)
        p.path([(19.2, 13.5), (19.2, 19.5)], "LED")
    # USB：好板两根同层平行等长；坏板 D+ 打两个过孔走底层、D- 绕一个 2 mm 的弯
    if ok:
        p.path([(29, 14), (42, 14)], "USB_DP"); p.path([(29, 15), (42, 15)], "USB_DM")
    else:
        p.path([(29, 14), (35, 14)], "USB_DP"); p.via(35, 14, "USB_DP"); p.path([(35, 14), (38, 14)], "USB_DP", layer=B)
        p.via(38, 14, "USB_DP"); p.path([(38, 14), (42, 14)], "USB_DP")
        p.path([(29, 15), (36, 15), (36, 16), (38, 16), (38, 15), (42, 15)], "USB_DM")
    # 按键 ESD 管 D1：好板串在线上、紧挨接口；坏板靠芯片
    p.path([(29, 17), (42, 17)], "BTN")
    if ok:
        p.fp("D1", 0, 0, 0, [("1", 40, 17, 0.6, 0.6, "BTN"), ("2", 40, 18.2, 0.6, 0.6, "GND")], "ESD5V")
        p.path([(40, 18.2), (40, 19.1)], "GND"); p.via(40, 19.1, "GND")
    else:
        p.fp("D1", 0, 0, 0, [("1", 33, 15.9, 0.6, 0.6, "BTN"), ("2", 34.2, 15.9, 0.6, 0.6, "GND")], "ESD5V")
        p.path([(33, 17), (33, 15.9)], "BTN"); p.path([(34.2, 15.9), (35, 15.9)], "GND"); p.via(35, 15.9, "GND")
    # LVDS：好板等距平行；坏板斜段间距变窄，对内还穿过一根 CS
    p.path([(29, 19), (33, 19), (37, 23), (42, 23)], "LVDS_P")
    if ok:
        p.path([(29, 20), (32.586, 20), (36.586, 24), (42, 24)], "LVDS_N")
    else:
        p.path([(29, 20), (33.5, 20), (37.5, 24), (42, 24)], "LVDS_N")
        p.fp("TP3", 0, 0, 0, [("1", 30.8, 19.5, 0.4, 0.4, "CS", "circle")]); p.fp("TP4", 0, 0, 0, [("1", 32.2, 19.5, 0.4, 0.4, "CS", "circle")])
        p.path([(30.8, 19.5), (32.2, 19.5)], "CS")
    # 模拟输入与开关节点：坏板 SW 贴着 ADC_IN 平行 11 mm
    p.path([(23, 21.5), (23, 22.5), (30.5, 30), (39, 30)], "ADC_IN")
    if ok:
        p.path([(28, 33), (37, 33)], "SW", 0.6)
    else:
        p.path([(28, 33), (28, 30.6), (37, 30.6), (37, 33)], "SW", 0.3)
    # 串联电阻 R5：好板贴着驱动端；坏板放在线中间
    r1, r2 = (10.5, 9.1) if ok else (9.0, 7.6)
    p.fp("R5", 0, 0, 0, [("1", 27, r1, 0.5, 0.5, "SCK_R"), ("2", 27, r2, 0.5, 0.5, "SCK")], "33R")
    p.path([(27, 12.5), (27, r1)], "SCK_R"); p.path([(27, r2), (27, 4.5)], "SCK")
    return p


def main(out=None):
    d = Path(out) if out else Path(__file__).resolve().parent
    (d / "route-good.kicad_pcb").write_text(good().text(), encoding="utf-8")
    (d / "route-bad.kicad_pcb").write_text(bad().text(), encoding="utf-8")
    (d / "principles-good.kicad_pcb").write_text(principles(True).text(), encoding="utf-8")
    (d / "principles-bad.kicad_pcb").write_text(principles(False).text(), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
