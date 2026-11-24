#!/usr/bin/env python3
"""由验证示例（assets/layout-verify-example.json）生成两块合成的 KiCad 板，用于铜皮提取与布线后验证的测试。

  demo-plane.kicad_pcb  4 层：L2 整层地、L3 整层 VDD；射频线两侧有地过孔
  demo-trace.kicad_pcb  4 层：VDD 走顶层导线（中间一段 0.10 mm 的细颈）；地平面在射频线下开槽；顶层有一块没打孔的地铜（孤岛）

用法：python make_demo_pcb.py [输出目录]
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
P = json.loads((ROOT / "assets" / "layout-verify-example.json").read_text(encoding="utf-8"))
W, H = P["board"]["outline"]["w"], P["board"]["outline"]["h"]
LAYERS = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]

SIDE_N = {"N": (0, 1), "S": (0, -1), "E": (1, 0), "W": (-1, 0), "C": (0, 0)}


def to_world(lx, ly, pl):
    if pl.get("side") == "bottom":
        lx = -lx
    a = math.radians(pl.get("rot", 0))
    c, s = round(math.cos(a)), round(math.sin(a))
    return pl["x"] + lx * c - ly * s, pl["y"] + lx * s + ly * c


def pin_world(part, pid):
    pin = next(q for q in part["pins"] if q["id"] == pid)
    w, h, t = part["w"], part["h"], pin.get("pos", 0.5)
    loc = {"N": (-w / 2 + t * w, h / 2), "S": (-w / 2 + t * w, -h / 2), "E": (w / 2, h / 2 - t * h), "W": (-w / 2, h / 2 - t * h), "C": (0, 0)}[pin["side"]]
    return to_world(loc[0], loc[1], part["placed"])


def K(x, y):
    """规划器坐标（y 向上）→ KiCad 坐标（y 向下）。"""
    return round(x, 4), round(H - y, 4)


class PCB:
    def __init__(self):
        self.nets = ["", "GND", "VDD", "RF_FEED", "SPI_IMU", "ADC_IN"]
        self.items = []

    def nid(self, n):
        if n not in self.nets:
            self.nets.append(n)
        return self.nets.index(n)

    def fp(self, ref, x, y, side, pads):
        lay = "B.Cu" if side == "bottom" else "F.Cu"
        fx, fy = K(x, y)
        s = [f'  (footprint "demo:{ref}" (layer "{lay}") (at {fx} {fy})', f'    (property "Reference" "{ref}" (at 0 0 0) (layer "{lay[0]}.SilkS"))']
        for name, px, py, w, h, net in pads:
            kx, ky = K(px, py)
            s.append(f'    (pad "{name}" smd rect (at {round(kx - fx, 4)} {round(ky - fy, 4)}) (size {w} {h}) (layers "{lay}") (net {self.nid(net)} "{net}"))')
        s.append("  )")
        self.items.append("\n".join(s))

    def seg(self, a, b, w, layer, net):
        (x1, y1), (x2, y2) = K(*a), K(*b)
        self.items.append(f'  (segment (start {x1} {y1}) (end {x2} {y2}) (width {w}) (layer "{layer}") (net {self.nid(net)}))')

    def via(self, x, y, net, d=0.45):
        kx, ky = K(x, y)
        self.items.append(f'  (via (at {kx} {ky}) (size {d}) (drill 0.25) (layers "F.Cu" "B.Cu") (net {self.nid(net)}))')

    def zone(self, net, layer, pts):
        xy = " ".join(f"(xy {K(*p)[0]} {K(*p)[1]})" for p in pts)
        self.items.append(f'  (zone (net {self.nid(net)}) (net_name "{net}") (layer "{layer}") (polygon (pts {xy})) (filled_polygon (layer "{layer}") (pts {xy})))')

    def text(self):
        head = ['(kicad_pcb (version 20221018) (generator demo)', '  (general (thickness 1.6))',
                '  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))']
        head += [f'  (net {i} "{n}")' for i, n in enumerate(self.nets)]
        e = [(0, 0), (W, 0), (W, H), (0, H), (0, 0)]
        for a, b in zip(e, e[1:]):
            head.append(f'  (gr_line (start {K(*a)[0]} {K(*a)[1]}) (end {K(*b)[0]} {K(*b)[1]}) (layer "Edge.Cuts") (width 0.1))')
        return "\n".join(head + self.items) + "\n)\n"


def build(variant):
    pcb = PCB()
    parts = {p["ref"]: p for p in P["parts"] if p.get("placed")}
    netof = {}
    for n in P["nets"]:
        for ref, pin in n["pins"]:
            netof[(ref, pin)] = n["name"]
    ant = parts["ANT1"]
    ax0 = ant["placed"]["x"] - ant["w"] / 2          # 馈点一侧不留净空（与布局规划器一致）
    ay0, ay1 = ant["placed"]["y"] - ant["h"] / 2 - 3, ant["placed"]["y"] + ant["h"] / 2 + 3
    inset = 0.3
    plane = [(inset, inset), (W - inset, inset), (W - inset, ay0), (ax0, ay0), (ax0, ay1), (W - inset, ay1), (W - inset, H - inset), (inset, H - inset)]
    pads_xy = {}
    for ref, pt in parts.items():
        pads = []
        for q in pt["pins"]:
            x, y = pin_world(pt, q["id"])
            net = netof.get((ref, q["id"]), "")
            pads.append((q["id"], x, y, 0.6, 0.6, net))
            pads_xy[(ref, q["id"])] = (x, y)
        if pt["role"] != "antenna":
            gs = 4.0 if pt["role"] == "battery" else round(min(1.0, 0.35 * min(pt["w"], pt["h"])), 2)
            pads.append(("GND", pt["placed"]["x"], pt["placed"]["y"], gs, gs, "GND"))
            pads_xy[(ref, "GND")] = (pt["placed"]["x"], pt["placed"]["y"])
        pcb.fp(ref, pt["placed"]["x"], pt["placed"]["y"], pt["placed"].get("side", "top"), pads)
    for s in P["satellites"]:
        if not s.get("placed"):
            continue
        x, y = s["placed"]["x"], s["placed"]["y"]
        net = netof.get(tuple(s["parent"]), "")
        if s["kind"] in ("decoupling", "bulk"):
            pcb.fp(s["ref"], x, y, "top", [("1", x - s["w"] / 4, y, 0.4, 0.4, net), ("2", x + s["w"] / 4, y, 0.4, 0.4, "GND")])
            px_, py_ = pads_xy[tuple(s["parent"])]
            d = math.hypot(x - px_, y - py_) or 1.0
            pcb.via(x + s["w"] / 4 + 0.7 * (x - px_) / d, y + 0.7 * (y - py_) / d, "GND")   # 地孔放在远离引脚的一侧
            if variant == "plane":
                pcb.via(x - s["w"] / 4, y - 0.5, "VDD")
            else:
                px, py = pads_xy[tuple(s["parent"])]
                pcb.seg((x - s["w"] / 4, y), (px, py), 0.25, "F.Cu", "VDD")
    # 电源与地
    gnd = [("GND", r) for r in parts if r != "ANT1"]
    for _, r in gnd:
        x, y = pads_xy[(r, "GND")]
        pcb.via(x, y, "GND")
    vdd_pins = [(r, p) for (r, p), n in netof.items() if n == "VDD" and r in parts]
    if variant == "plane":
        pcb.zone("GND", "In1.Cu", plane)
        pcb.zone("VDD", "In2.Cu", plane)
        for r, p in vdd_pins:
            x, y = pads_xy[(r, p)]
            pcb.via(x, y, "VDD")
    else:
        slot_x = (pads_xy[("U1", "RF")][0] + pads_xy[("ANT1", "FEED")][0]) / 2
        gp = plane[:]
        # 在射频线下方从板上边缘切一条 0.8 mm 宽的槽
        cut = [(inset, inset), (W - inset, inset), (W - inset, ay0), (ax0, ay0), (ax0, ay1), (W - inset, ay1), (W - inset, H - inset),
               (slot_x + 0.4, H - inset), (slot_x + 0.4, ay0 + 1.0), (slot_x - 0.4, ay0 + 1.0), (slot_x - 0.4, H - inset), (inset, H - inset)]
        pcb.zone("GND", "In1.Cu", cut)
        pcb.zone("GND", "F.Cu", [(1.0, 9.0), (3.5, 9.0), (3.5, 11.5), (1.0, 11.5)])   # 孤岛
        # VDD：电池正极 → 过孔到顶层 → 导线到 U1；中间一段细颈
        bx, by = pads_xy[("BT1", "PLUS")]
        ux, uy = pads_xy[("U1", "VDD")]
        pcb.via(bx, by, "VDD")
        sg = 1 if ux > bx else -1
        mid = bx + (ux - bx) * 0.5
        pcb.seg((bx, by), (mid - 0.6 * sg, by), 0.3, "F.Cu", "VDD")
        pcb.seg((mid - 0.6 * sg, by), (mid + 0.6 * sg, by), 0.10, "F.Cu", "VDD")      # 细颈
        pcb.seg((mid + 0.6 * sg, by), (ux, by), 0.3, "F.Cu", "VDD")
        pcb.seg((ux, by), (ux, uy), 0.3, "F.Cu", "VDD")
        for r, p in vdd_pins:
            if r in ("U1", "BT1"):
                continue
            x, y = pads_xy[(r, p)]
            pcb.via(x, y, "VDD")                      # 其余负载走 L3 内层导线
            pcb.seg((x, y), (ux, uy), 0.2, "In2.Cu", "VDD")
        pcb.via(ux, uy, "VDD")
    # 射频线与两侧地孔
    a, b = pads_xy[("U1", "RF")], pads_xy[("ANT1", "FEED")]
    corner = (a[0], b[1])
    pcb.seg(a, corner, 0.3, "F.Cu", "RF_FEED")
    pcb.seg(corner, b, 0.3, "F.Cu", "RF_FEED")
    L = abs(b[0] - corner[0])
    for k in range(int(L / 1.5) + 1):
        x = corner[0] + (b[0] - corner[0]) * k * 1.5 / max(L, 1e-6)
        for dy in (-0.7, 0.7):
            pcb.via(x, b[1] + dy, "GND", 0.4)
    if variant == "plane":                      # 好板：竖直段也打地孔围栏
        Lv = abs(corner[1] - a[1])
        for k in range(1, int(Lv / 1.5) + 1):
            y = a[1] + (corner[1] - a[1]) * k * 1.5 / max(Lv, 1e-6)
            for dx in (-0.7, 0.7):
                pcb.via(a[0] + dx, y, "GND", 0.4)
    # 数字线与并行的模拟线
    s0, s1 = pads_xy[("U1", "SPI")], pads_xy[("U2", "SPI")]
    pcb.seg(s0, (s1[0], s0[1]), 0.15, "F.Cu", "SPI_IMU")
    # 板下方一段 8 mm 的模拟线与数字线并行，间距 0.2 mm（用于并行耦合检查）
    pcb.seg((6.0, 2.2), (14.0, 2.2), 0.15, "F.Cu", "SPI_IMU")
    gap = 0.35 if variant == "trace" else 1.5   # 坏板：间距 0.2 mm；好板：拉开到 1.35 mm
    pcb.seg((6.0, 2.2 + gap), (14.0, 2.2 + gap), 0.15, "F.Cu", "ADC_IN")
    return pcb.text()


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
    out.mkdir(parents=True, exist_ok=True)
    for v in ("plane", "trace"):
        (out / f"demo-{v}.kicad_pcb").write_text(build(v), encoding="utf-8")
        print(out / f"demo-{v}.kicad_pcb")
