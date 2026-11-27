#!/usr/bin/env python3
"""布线几何检查、网络类推导与质量评分。

规则见 references/16-routing-constraints.md：RTG（几何）、RTW（线宽）、RTL（线长）、RTV（过孔）、
RTS（间距）、RTY（层），评分项 VF-16…26；走线原则（就近 RTP、差分 RTD、优先级 RTO、隔离 RTS-06，评分 VF-28…30）
见 references/17-routing-principles.md，实现在 route_principles.py。DRC（间距、短路、开路）是前置闸门，这里不重复。

  python route_lint.py lint board.kicad_pcb [--constraints c.json] [-o report.md] [--json report.json]
  python route_lint.py lint copper-pack.json [...]          # extract_copper.py 生成的铜皮数据包
  python route_lint.py gate plan.json                       # 写入 EDA 之前的闸门：只查方向、锐角和锐角分支
  python route_lint.py constraints board.kicad_pcb [--layers 4] [-o constraints.json] [--dru routing.kicad_dru]
  python route_lint.py order board.kicad_pcb                # 按布线优先级给出推荐布线顺序

lint 有 P0 违规时退出码为 1；gate 有拦截项时退出码为 1。

坐标：kicad 输入时报告同时给出 KiCad 坐标（at_src）和数据包坐标（at，左下角为原点、y 向上）。
plan.json 的格式见 references/16-routing-constraints.md 第 6 节。
"""
import argparse
import json
import math
import re
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

ANG_TOL = 0.001      # mm：线段端点相对理想方向的横向偏差容差（1 µm）
TURN_TOL = 0.5       # 度：判断锐角时的容差
WELD = 1e4           # 端点焊接：坐标取到 0.1 µm
SIN1 = math.sin(math.radians(1.0))

# ------------------------------------------------------------------ 网络类默认值
# width：默认线宽；min_width：低于它记 RTW（P1）；via_budget：每网过孔上限（None 不限）；tau_max：绕行率上限
CLASSES = {
    "SIG":      {"width": 0.20, "min_width": 0.127, "via_budget": 2, "tau_max": 1.3},
    "CLK":      {"width": 0.20, "min_width": 0.127, "via_budget": 1, "tau_max": 1.15, "critical": True},
    "ANALOG":   {"width": 0.20, "min_width": 0.15, "via_budget": 2, "tau_max": 1.15, "critical": True},
    "XTAL":     {"width": 0.20, "min_width": 0.127, "via_budget": 0, "tau_max": 1.15, "max_len_mm": 5.0, "critical": True},
    "RF50":     {"width": None, "min_width": 0.15, "via_budget": 0, "tau_max": 1.15, "critical": True, "allow_arc": True, "no_branch": True},
    "USB90":    {"width": 0.20, "min_width": 0.127, "via_budget": 2, "tau_max": 1.15, "critical": True, "skew_mm": 0.5, "skew_max_mm": 1.25},
    "DIFF100":  {"width": 0.15, "min_width": 0.1, "via_budget": 2, "tau_max": 1.15, "critical": True, "skew_mm": 0.13, "skew_max_mm": 0.5},
    "PWR_LOW":  {"width": 0.30, "min_width": 0.25, "via_budget": None, "tau_max": None},
    "PWR_MAIN": {"width": 0.60, "min_width": 0.50, "via_budget": None, "tau_max": None},
    "SW":       {"width": None, "min_width": 0.30, "via_budget": None, "tau_max": None},
    "HV":       {"width": 0.30, "min_width": 0.30, "via_budget": 2, "tau_max": 1.3},
    "GND":      {"width": None, "min_width": None, "via_budget": None, "tau_max": None},
}
# 布线与修复顺序，与 route_principles.TIERS 一致：射频 → 晶振 → 开关回路与高压 → 高速差分 → 时钟 → 模拟 → 电源 → 一般信号 → 地
PRIORITY = ["RF50", "XTAL", "SW", "HV", "USB90", "DIFF100", "CLK", "ANALOG", "PWR_MAIN", "PWR_LOW", "SIG", "GND"]

NAME_RULES = [
    (r"^(A|D|P|S|C)?GND|^VSS|^EARTH|^0V$", "GND", 0.95),
    (r"^(SW|LX|PH)\d*$|_(SW|LX)\d*$", "SW", 0.9),
    (r"USB.*D[PN+\-]$|^D[+\-]$|USB_?D?[PN]$|_D[PN]$", "USB90", 0.9),
    (r"LVDS|MIPI|HDMI|SERDES|(^|_)(TX|RX|CK|CLK|D\d)_?[PN]$", "DIFF100", 0.85),
    (r"XTAL|^XIN|^XOUT|^XC\d|^XL\d|OSC_?(IN|OUT)|32K", "XTAL", 0.85),
    (r"(^|_)(ANT|RF)(_|$|\d)|RFIO|LNA|^RF", "RF50", 0.85),
    (r"^HV|PULSE|VPP|VNN", "HV", 0.85),
    (r"VBAT|VBUS|VIN|VSYS|BAT\+|^\+?BATT?$", "PWR_MAIN", 0.85),
    (r"^\+|VCC|VDD|VOUT|PWR|\dV\d|^\d+V\d*$|VREG|VIO", "PWR_LOW", 0.85),
    (r"CLK|SCK|MCLK|BCLK|LRCK", "CLK", 0.85),
    (r"ADC|AIN|SENS|ANA|VREF|MIC|ECG|PPG", "ANALOG", 0.8),
    (r"SCL|SDA|TXD?|RXD?|MOSI|MISO|CS|EN|INT|RST|GPIO|^P\d", "SIG", 0.85),
]
CTRL = re.compile(r"EN|CTRL|SEL|_SW_?C|GPIO", re.I)


def infer_class(name, pads=()):
    """按网络名和所连焊盘推网络类。返回 (类, 置信度, 依据)。置信度低于 0.8 的应请用户确认。"""
    cls, conf, why = "SIG", 0.6, "默认"
    if not name or name.startswith(("Net-(", "unconnected-")):
        cls, conf, why = "SIG", 0.5, "未命名网络"
    else:
        for pat, c, p in NAME_RULES:
            if re.search(pat, name, re.I):
                cls, conf, why = c, p, f"网络名匹配 {pat}"
                break
        if cls == "RF50" and CTRL.search(name):
            cls, conf, why = "SIG", 0.6, "名字含 RF 但像控制线"
    if cls in ("SIG",) and conf < 0.9:                      # 拓扑只改写普通信号
        refs = [(str(p.get("ref", "")), str(p.get("pin", ""))) for p in pads]
        if any(re.match(r"^(Y|X)\d", r) for r, _ in refs):
            return "XTAL", 0.9, "连到晶振"
        if any(re.match(r"^(J|USB|CN)", r) and q.upper() in ("A6", "A7", "B6", "B7", "D+", "D-", "DP", "DM") for r, q in refs):
            return "USB90", 0.85, "连到 USB 连接器的 D+/D- 脚"
        if any(re.match(r"^(ANT|AE|E)\d", r) or q.upper() in ("ANT", "FEED", "RF") for r, q in refs):
            return "RF50", 0.85, "连到天线或 ANT/RF 脚"
        if any(re.match(r"^L\d", r) for r, _ in refs) and any(re.match(r"^U\d", r) for r, _ in refs) and not name.startswith("Net-(L"):
            return "SW", 0.7, "电感与芯片之间（可能是开关节点）"
    return cls, conf, why


def class_rules(cls, cons=None):
    r = dict(CLASSES.get(cls, CLASSES["SIG"]))
    if cons:
        r.update((cons.get("netclasses") or {}).get(cls, {}))
    return r


# ------------------------------------------------------------------ 几何
def seg_len(s):
    return math.hypot(s[3] - s[1], s[4] - s[2])


def octi_dev(dx, dy):
    """线段相对最近的 45° 倍数方向的横向偏差（mm）和角度偏差（度）。"""
    L = math.hypot(dx, dy)
    if L < 1e-9:
        return 0.0, 0.0
    a = math.degrees(math.atan2(dy, dx)) % 45.0
    d = min(a, 45.0 - a)
    return L * math.sin(math.radians(d)), d


def is_octi(dx, dy, tol=ANG_TOL):
    return octi_dev(dx, dy)[0] <= tol


def d_oct(dx, dy):
    """八方向（0/45/90°）最短距离。"""
    ax, ay = abs(dx), abs(dy)
    return max(ax, ay) + (math.sqrt(2) - 1) * min(ax, ay)


def angle_between(u, v):
    lu, lv = math.hypot(*u), math.hypot(*v)
    if lu < 1e-12 or lv < 1e-12:
        return 180.0
    c = max(-1.0, min(1.0, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))
    return math.degrees(math.acos(c))


def pt_seg(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 < 1e-18 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
    return math.hypot(px - x1 - t * dx, py - y1 - t * dy)


def _cross(ax, ay, bx, by, cx, cy):
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)


def segs_intersect(a, b):
    (x1, y1, x2, y2), (x3, y3, x4, y4) = a, b
    d1, d2 = _cross(x3, y3, x4, y4, x1, y1), _cross(x3, y3, x4, y4, x2, y2)
    d3, d4 = _cross(x1, y1, x2, y2, x3, y3), _cross(x1, y1, x2, y2, x4, y4)
    return (d1 * d2 < 0) and (d3 * d4 < 0)


def seg_seg(a, b):
    """两线段中心线最短距离。a, b = (x1, y1, x2, y2)。"""
    if segs_intersect(a, b):
        return 0.0
    return min(pt_seg(a[0], a[1], *b), pt_seg(a[2], a[3], *b), pt_seg(b[0], b[1], *a), pt_seg(b[2], b[3], *a))


def pad_axis(p):
    r = math.radians(p.get("rot", 0.0))
    return math.cos(r), math.sin(r)


def pad_corners(p, grow=0.0):
    ux, uy = pad_axis(p)
    hw, hh = p["w"] / 2 + grow, p["h"] / 2 + grow
    return [(p["x"] + sx * hw * ux - sy * hh * uy, p["y"] + sx * hw * uy + sy * hh * ux) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def pt_in_pad(x, y, p, tol=1e-3):
    if p.get("shape") in ("circle",) or not p.get("w"):
        return math.hypot(x - p["x"], y - p["y"]) <= max(p.get("w") or 0.5, p.get("h") or 0.5) / 2 + tol
    ux, uy = pad_axis(p)
    dx, dy = x - p["x"], y - p["y"]
    lx, ly = dx * ux + dy * uy, -dx * uy + dy * ux
    return abs(lx) <= p["w"] / 2 + tol and abs(ly) <= p["h"] / 2 + tol


def seg_pad(s4, p):
    """线段中心线到焊盘边缘的距离（相交为 0）。圆形焊盘按圆处理。"""
    if p.get("shape") == "circle":
        return max(0.0, pt_seg(p["x"], p["y"], *s4) - max(p["w"], p["h"]) / 2)
    if pt_in_pad(s4[0], s4[1], p, 0) or pt_in_pad(s4[2], s4[3], p, 0):
        return 0.0
    c = pad_corners(p)
    edges = list(zip(c, c[1:] + c[:1]))
    if any(segs_intersect(s4, (a[0], a[1], b[0], b[1])) for a, b in edges):
        return 0.0
    return min([pt_seg(s4[0], s4[1], a[0], a[1], b[0], b[1]) for a, b in edges] +
               [pt_seg(s4[2], s4[3], a[0], a[1], b[0], b[1]) for a, b in edges] +
               [pt_seg(q[0], q[1], *s4) for q in c])


def pad_exit_dist(x, y, e, p):
    """从焊盘内一点 (x, y) 沿单位方向 e 走到焊盘边缘的距离。"""
    ux, uy = pad_axis(p)
    dx, dy = x - p["x"], y - p["y"]
    lx, ly = dx * ux + dy * uy, -dx * uy + dy * ux
    ex, ey = e[0] * ux + e[1] * uy, -e[0] * uy + e[1] * ux
    ts = []
    for pos, d, half in ((lx, ex, p["w"] / 2), (ly, ey, p["h"] / 2)):
        if abs(d) > 1e-12:
            ts.append(((half if d > 0 else -half) - pos) / d)
    ts = [t for t in ts if t >= 0]
    return min(ts) if ts else 0.0


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-300) + x1:
            inside = not inside
    return inside


def oct_mst(pts):
    """八方向距离下的最小生成树长度。"""
    pts = list(dict.fromkeys((round(x, 3), round(y, 3)) for x, y in pts))
    if len(pts) < 2:
        return 0.0
    inside, total = {0}, 0.0
    dist = [d_oct(pts[0][0] - q[0], pts[0][1] - q[1]) for q in pts]
    while len(inside) < len(pts):
        k = min((i for i in range(len(pts)) if i not in inside), key=lambda i: dist[i])
        total += dist[k]; inside.add(k)
        for i in range(len(pts)):
            if i not in inside:
                dist[i] = min(dist[i], d_oct(pts[k][0] - pts[i][0], pts[k][1] - pts[i][1]))
    return total


# ------------------------------------------------------------------ 数据模型
# 网络：{"name", "class", "segs": [[l, x1, y1, x2, y2, w, arc]], "vias": [[x, y, d]],
#        "pads": [{"ref", "pin", "l", "x", "y", "w", "h", "rot", "shape"}]}；rot 是焊盘局部 x 轴在本坐标系里的方向角（度）
def norm_pad(p):
    if isinstance(p, dict):
        q = dict(p)
        q.setdefault("l", q.pop("layer", -1))
    else:
        q = {"ref": p[0], "pin": p[1], "l": p[2], "x": p[3], "y": p[4]}
        if len(p) >= 8:
            q.update(w=p[5], h=p[6], rot=p[7])
        if len(p) >= 9:
            q["shape"] = p[8]
    q.setdefault("w", None); q.setdefault("h", None); q.setdefault("rot", 0.0); q.setdefault("shape", "rect")
    return q


def norm_net(n):
    segs = [list(s[:6]) + [bool(s[6]) if len(s) > 6 else False] for s in n.get("segs", [])]
    return {"name": n["name"], "class": n.get("rclass"), "segs": segs, "vias": [list(v[:3]) for v in n.get("vias", [])],
            "pads": [norm_pad(p) for p in n.get("pads", [])], "zone": bool(n.get("zone"))}


def nets_from_board(b, flip=False):
    """extract_copper.Board → 网络列表（源坐标；flip=True 时 y 取反，变成 y 向上）。"""
    sy = -1.0 if flip else 1.0
    out = {}
    def net(name):
        return out.setdefault(name, {"name": name, "segs": [], "vias": [], "pads": []})
    for s in b.segs:
        arc = bool(s[7]) if len(s) > 7 else False
        net(s[6])["segs"].append([s[0], s[1], s[2] * sy, s[3], s[4] * sy, s[5], arc])
    for x, y, d, n in b.vias:
        net(n)["vias"].append([x, y * sy, d])
    for p in b.pads:
        rot = p.get("rot", 0.0) or 0.0
        if b.ydown:                                          # KiCad：局部 x 轴在 y 向下坐标里是 (cos, -sin)
            a, c = math.cos(math.radians(rot)), -math.sin(math.radians(rot))
            r = math.degrees(math.atan2(c * sy, a))
        else:
            r = rot
        net(p["net"])["pads"].append({"ref": p["ref"], "pin": p["pin"], "l": p["layer"], "x": p["x"], "y": p["y"] * sy,
                                      "w": p["w"], "h": p["h"], "rot": r, "shape": p.get("shape", "rect")})
    return [v for k, v in out.items() if k]


# ------------------------------------------------------------------ 连接图
def wkey(x, y):
    return (round(x * WELD), round(y * WELD))


class Graph:
    """一个网络在一层上的走线图。节点按端点焊接，T 型接在线段中间的端点会把那条线段切开。"""

    def __init__(self, segs, pads, vias, layer):
        self.layer = layer
        self.pads = [p for p in pads if p["l"] in (-1, layer)]
        self.vias = vias
        pieces = []
        ends = [(s[1], s[2]) for s in segs] + [(s[3], s[4]) for s in segs]
        for i, s in enumerate(segs):
            ts = []
            if not s[6]:
                L = seg_len(s)
                for (x, y) in ends:
                    if L > 1e-6 and pt_seg(x, y, s[1], s[2], s[3], s[4]) < 1e-4:
                        t = ((x - s[1]) * (s[3] - s[1]) + (y - s[2]) * (s[4] - s[2])) / (L * L)
                        if 1e-4 < t * L < L - 1e-4:
                            ts.append(t)
            ts = sorted(set(round(t, 9) for t in ts))
            pts = [(s[1], s[2])] + [(s[1] + t * (s[3] - s[1]), s[2] + t * (s[4] - s[2])) for t in ts] + [(s[3], s[4])]
            for a, b in zip(pts, pts[1:]):
                pieces.append({"a": a, "b": b, "w": s[5], "arc": s[6], "src": i})
        self.edges = pieces
        self.nodes = {}
        for k, e in enumerate(pieces):
            for end in ("a", "b"):
                key = wkey(*e[end])
                nd = self.nodes.setdefault(key, {"p": e[end], "e": []})
                nd["e"].append(k)
                e["k" + end] = key
        for key, nd in self.nodes.items():
            x, y = nd["p"]
            nd["pad"] = next((p for p in self.pads if pt_in_pad(x, y, p)), None)
            nd["via"] = any(math.hypot(x - v[0], y - v[1]) <= v[2] / 2 + 1e-3 for v in vias)
            ws = {round(pieces[k]["w"], 4) for k in nd["e"]}
            nd["wchange"] = len(ws) > 1
            nd["arc"] = any(pieces[k]["arc"] for k in nd["e"])
            nd["anchor"] = len(nd["e"]) != 2 or nd["pad"] is not None or nd["via"] or nd["wchange"] or nd["arc"]
        self.chains = self._chains()

    def other(self, k, key):
        e = self.edges[k]
        return e["kb"] if e["ka"] == key else e["ka"]

    def vec(self, k, key):
        """从节点 key 沿边 k 出去的方向向量。"""
        e = self.edges[k]
        a, b = (e["a"], e["b"]) if e["ka"] == key else (e["b"], e["a"])
        return (b[0] - a[0], b[1] - a[1])

    def _chains(self):
        seen, chains = set(), []
        def walk(start, k):
            keys, ks = [start], []
            cur = start
            while True:
                seen.add(k); ks.append(k)
                cur = self.other(k, cur); keys.append(cur)
                nd = self.nodes[cur]
                if nd["anchor"] or cur == start:
                    break
                nxt = [q for q in nd["e"] if q not in seen]
                if not nxt:
                    break
                k = nxt[0]
            return {"keys": keys, "edges": ks}
        for key, nd in self.nodes.items():
            if nd["anchor"]:
                for k in nd["e"]:
                    if k not in seen:
                        chains.append(walk(key, k))
        for k in range(len(self.edges)):                     # 没有锚点的环
            if k not in seen:
                key = self.edges[k]["ka"]
                self.nodes[key]["anchor"] = True
                chains.append(walk(key, k))
        for c in chains:
            c["pts"] = [self.nodes[k]["p"] for k in c["keys"]]
            c["w"] = self.edges[c["edges"][0]]["w"]
            c["arc"] = any(self.edges[k]["arc"] for k in c["edges"])
            c["len"] = sum(math.dist(a, b) for a, b in zip(c["pts"], c["pts"][1:]))
        return chains


# ------------------------------------------------------------------ 规则检查
SEV_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}


class Ctx:
    def __init__(self, cons=None, frame=None):
        self.cons = merge_cons(cons)
        self.frame = frame or {}
        self.out = []
        self.exempt = []
        for z in self.cons.get("exempt_zones", []):
            if z.get("poly"):
                self.exempt.append((set(z.get("rules", [])), [self.to_model(*p) for p in z["poly"]], z.get("reason", "")))

    def to_model(self, x, y):
        f = self.frame
        if not f:
            return (x, y)
        return (x - f["x0"], f["y1"] - y) if f.get("ydown") else (x - f["x0"], y - f["y0"])

    def to_src(self, x, y):
        f = self.frame
        if not f:
            return [round(x, 3), round(y, 3)]
        return [round(x + f["x0"], 3), round(f["y1"] - y, 3)] if f.get("ydown") else [round(x + f["x0"], 3), round(y + f["y0"], 3)]

    def exempted(self, rule, x, y):
        return any(rule in rs and point_in_poly(x, y, poly) for rs, poly, _ in self.exempt)

    def add(self, rule, sev, net, layer, at, msg, value=None, cls=None, metric=None):
        if at is not None and self.exempted(rule, *at):
            return
        v = {"rule": rule, "sev": sev, "net": net, "layer": layer, "msg": msg}
        if at is not None:
            v["at"] = [round(at[0], 3), round(at[1], 3)]
            if self.frame:
                v["at_src"] = self.to_src(*at)
        if value is not None:
            v["value"] = value
        if metric:
            v["metric"] = metric
        self.out.append(v)


def merge_cons(cons):
    c = {"geometry": {"angles_deg": [0, 45, 90, 135], "angle_tol_um": 1, "min_seg": {"k_w": 1.0, "abs_mm": 0.15},
                      "fanout_k_w": 0.5, "jog_k_w": 2.0, "jitter_window_k_w": 5.0, "forbid_acute": True},
         "netclasses": {}, "nets": {}, "layers": [], "bundles": [], "exempt_zones": [], "board": {}}
    if cons:
        for k, v in cons.items():
            if isinstance(v, dict) and isinstance(c.get(k), dict):
                c[k] = {**c[k], **v}
            else:
                c[k] = v
    return c


METRIC_OF = {"RTG-01": "VF-16", "RTG-10": "VF-16", "RTG-02": "VF-17", "RTG-03": "VF-17", "RTG-05": "VF-18", "RTG-06": "VF-18",
             "RTG-07": "VF-18", "RTG-09": "VF-18", "RTG-12": "VF-18", "RTV-01": "VF-20", "RTV-05": "VF-20", "RTY-04": "VF-21", "RTY-05": "VF-21",
             "RTL-01": "VF-22", "RTL-02": "VF-22", "RTS-03": "VF-23", "RTY-02": "VF-24", "RTL-11": "VF-24"}


def check_graph(ctx, g, net, cls, rules, stats):
    """单个网络单层上的几何规则。"""
    geo = ctx.cons["geometry"]
    tol = geo.get("angle_tol_um", 1) / 1000.0
    L = g.layer
    # RTG-01 方向；RTG-10 圆弧
    arc_chains = 0
    for c in g.chains:
        if c["arc"]:
            if not rules.get("allow_arc"):
                arc_chains += 1
                ctx.add("RTG-10", "P2", net, L, c["pts"][len(c["pts"]) // 2], "圆弧走线没有声明豁免区（只限射频、柔性弯折区、高压区）")
            continue
    for k, e in enumerate(g.edges):
        if e["arc"]:
            continue
        dx, dy = e["b"][0] - e["a"][0], e["b"][1] - e["a"][1]
        lat, deg = octi_dev(dx, dy)
        if lat > tol:
            if pad_aligned_exit(g, e, dx, dy):
                continue
            mid = ((e["a"][0] + e["b"][0]) / 2, (e["a"][1] + e["b"][1]) / 2)
            ctx.add("RTG-01", "P1", net, L, mid, f"任意角度线段：偏离 45° 倍数 {deg:.1f}°、长 {math.hypot(dx, dy):.2f} mm", round(deg, 2))
            stats["angle"] += 1
    # RTG-02/03 锐角
    for key, nd in g.nodes.items():
        if len(nd["e"]) < 2 or nd["pad"] is not None or nd["via"] or nd["arc"]:
            continue
        dirs = sorted(math.degrees(math.atan2(*reversed(g.vec(k, key)))) % 360 for k in nd["e"])
        gaps = [(dirs[(i + 1) % len(dirs)] - dirs[i]) % 360 for i in range(len(dirs))]
        if len(dirs) == 2:
            gaps = [min(gaps)]
        m = min(gaps)
        if m < 90 - TURN_TOL:
            w = min(g.edges[k]["w"] for k in nd["e"])
            sev = "P0" if w <= 0.15 + 1e-9 else "P1"
            rule = "RTG-02" if len(dirs) == 2 else "RTG-03"
            ctx.add(rule, sev, net, L, nd["p"], f"{'锐角拐角' if rule == 'RTG-02' else '锐角 T 分支'}：夹角 {m:.0f}°（线宽 {w} mm）", round(m, 1))
            stats["acute"] += 1
    # 短段、抖动、出焊盘、线宽突变
    kw, absmin = geo["min_seg"]["k_w"], geo["min_seg"]["abs_mm"]
    for c in g.chains:
        if c["arc"]:
            continue
        pts, w = c["pts"], c["w"]
        stats["segs"] += len(pts) - 1
        for i, (a, b) in enumerate(zip(pts, pts[1:])):
            Ls = math.dist(a, b)
            near_anchor = (i == 0 and g.nodes[c["keys"][0]]["anchor"]) or (i == len(pts) - 2 and g.nodes[c["keys"][-1]]["anchor"])
            lim = geo.get("fanout_k_w", 0.5) * w if near_anchor else max(kw * w, absmin)
            if 1e-6 < Ls < lim - 1e-9 and len(pts) > 2:
                ctx.add("RTG-05", "P2", net, L, a, f"短线段 {Ls:.3f} mm（下限 {lim:.3f} mm）", round(Ls, 3))
                stats["short"] += 1
        turns, cum, turn_sum = [], 0.0, 0.0
        for i in range(1, len(pts) - 1):
            cum += math.dist(pts[i - 1], pts[i])
            u = (pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); v = (pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
            t = angle_between(u, v)
            if t > 1.0:
                turns.append((cum, pts[i]))
                turn_sum += min(t, 180) / 90.0
        stats["bends"] += len(turns)
        # 多余拐弯（VF-19）：按转角计（45° = 0.5，90° = 1），减去这段连接至少需要的转角
        A, B = pts[0], pts[-1]
        need = 0.0 if is_octi(B[0] - A[0], B[1] - A[1]) else 0.5
        for key in (c["keys"][0], c["keys"][-1]):
            p = g.nodes[key]["pad"]
            if p is not None and p.get("w") and p.get("shape") != "circle" and math.dist(A, B) > 1e-6:
                d = (B[0] - A[0], B[1] - A[1]) if key == c["keys"][0] else (A[0] - B[0], A[1] - B[1])
                ux, uy = pad_axis(p)
                if not any(abs(d[0] * ay - d[1] * ax) / math.hypot(*d) <= SIN1 for ax, ay in ((ux, uy), (-uy, ux))):
                    need += 0.5
        stats["excess"].append(max(0.0, turn_sum - need))
        jogk = geo.get("jog_k_w", 2.0)
        flagged = False
        for i in range(len(pts) - 3):                       # Z 形微折：第 i 段与第 i+2 段平行同向、横向错开小于 2w
            a0, a1, b0, b1 = pts[i], pts[i + 1], pts[i + 2], pts[i + 3]
            u = (a1[0] - a0[0], a1[1] - a0[1]); v = (b1[0] - b0[0], b1[1] - b0[1])
            if angle_between(u, v) < 1.0 and math.hypot(*u) > 1e-6:
                off = pt_seg(b0[0], b0[1], a0[0] - 1e3 * u[0], a0[1] - 1e3 * u[1], a0[0] + 1e3 * u[0], a0[1] + 1e3 * u[1])
                if 1e-4 < off < jogk * w:
                    ctx.add("RTG-06", "P2", net, L, a1, f"Z 形微折：横向只错开 {off:.3f} mm", round(off, 3))
                    stats["jog"] += 1; flagged = True
                    break
        win = geo.get("jitter_window_k_w", 5.0) * w
        if not flagged:
            for i in range(len(turns) - 2):
                if turns[i + 2][0] - turns[i][0] <= win:
                    ctx.add("RTG-06", "P2", net, L, turns[i][1], f"走线抖动：{win:.2f} mm 内拐了 3 次以上")
                    stats["jog"] += 1
                    break
        for end in (0, -1):                                 # RTG-07 出焊盘方向
            nd = g.nodes[c["keys"][end]]
            p = nd["pad"]
            if p is None or not p.get("w") or p.get("shape") == "circle" or len(pts) < 2:
                continue
            a, b = (pts[0], pts[1]) if end == 0 else (pts[-1], pts[-2])
            d = (b[0] - a[0], b[1] - a[1])
            Ld = math.hypot(*d)
            if Ld < 1e-6:
                continue
            ux, uy = pad_axis(p)
            axes = [(ux, uy), (-uy, ux)]
            big, small = max(p["w"], p["h"]), min(p["w"], p["h"])
            if big / max(small, 1e-6) >= 1.3:
                axes = [(ux, uy)] if p["w"] >= p["h"] else [(-uy, ux)]
            ok = any(abs(d[0] * ay - d[1] * ax) / Ld <= SIN1 for ax, ay in axes)
            if not ok:
                sev = "P1" if small <= 0.35 else "P2"
                ctx.add("RTG-07", sev, net, L, a, f"从焊盘 {p['ref']}.{p['pin']} 斜着或沿短轴出线（应沿焊盘长轴直出）")
                stats["exit"] += 1
    if not rules.get("_zone"):                              # RTG-12 悬空线头
        for key, nd in g.nodes.items():
            if len(nd["e"]) == 1 and nd["pad"] is None and not nd["via"]:
                ctx.add("RTG-12", "P2", net, L, nd["p"], "悬空线头：走线一端没有接到焊盘、过孔或其他走线（天线式残桩）")
                stats["stub"] += 1
    for key, nd in g.nodes.items():                         # RTG-09 走线途中变宽变窄
        if nd["wchange"] and nd["pad"] is None and not nd["via"]:
            neck = False
            for k in nd["e"]:
                c = next(cc for cc in g.chains if k in cc["edges"])
                far = g.nodes[c["keys"][-1] if c["keys"][0] == key else c["keys"][0]]
                if far["pad"] is not None and c["len"] <= 1.0 + 1e-9:
                    neck = True
            if not neck:
                ctx.add("RTG-09", "P2", net, L, nd["p"], "线宽在走线中途变化（只应在焊盘颈缩或分支处变化）")
                stats["wchange"] += 1
    # RF 不分叉
    if rules.get("no_branch"):
        for key, nd in g.nodes.items():
            if len(nd["e"]) >= 3 and nd["pad"] is None:
                ctx.add("RTL-06", "P0", net, L, nd["p"], "射频线分叉", metric="VF-26")
    return arc_chains


def pad_aligned_exit(g, e, dx, dy):
    """非 45° 倍数旋转的器件：从焊盘沿焊盘轴引出的第一段不算任意角度（RTG-10 的局部扇出豁免）。"""
    for end in ("ka", "kb"):
        p = g.nodes[e[end]]["pad"]
        if p is None:
            continue
        ux, uy = pad_axis(p)
        if is_octi(ux, uy, 1e-6):
            continue
        L = math.hypot(dx, dy)
        if L <= 1.5 and any(abs(dx * ay - dy * ax) / L <= SIN1 for ax, ay in ((ux, uy), (-uy, ux))):
            return True
    return False


# ------------------------------------------------------------------ 评分
WEIGHTS = {"VF-16": 15, "VF-17": 10, "VF-18": 8, "VF-19": 8, "VF-20": 10, "VF-21": 12, "VF-22": 8, "VF-23": 7, "VF-24": 6, "VF-25": 6, "VF-26": 10,
           "VF-28": 8, "VF-29": 8, "VF-30": 6}
NAMES = {"VF-16": "任意角度", "VF-17": "锐角", "VF-18": "短段、抖动与出线", "VF-19": "多余拐弯", "VF-20": "过孔", "VF-21": "地平面完整性",
         "VF-22": "绕行率", "VF-23": "成束整齐度", "VF-24": "层方向与层使用", "VF-25": "走线密度均匀性", "VF-26": "网络类约束",
         "VF-28": "差分对", "VF-29": "就近", "VF-30": "优先级与隔离"}


def ramp(v, good, bad):
    """good 以内 0，bad 以上 1，中间线性。"""
    if v is None:
        return 0.0
    if v <= good:
        return 0.0
    if v >= bad:
        return 1.0
    return (v - good) / (bad - good)


def analyze(pack, cons=None):
    """对铜皮数据包（或同格式的网络列表）做全部布线检查并打分。返回报告 dict。"""
    frame = pack.get("frame")
    ctx = Ctx(cons, frame)
    layers = pack.get("layers") or []
    nL = len(layers)
    nets = [norm_net(n) for n in pack.get("nets", [])]
    stats = {k: 0 for k in ("angle", "acute", "short", "jog", "exit", "wchange", "stub", "segs", "bends")}
    stats["excess"] = []
    classes, conf = {}, []
    for n in nets:
        given = (ctx.cons.get("nets") or {}).get(n["name"], {}).get("class") or n.get("class")
        if given:
            classes[n["name"]] = given
        else:
            c, p, why = infer_class(n["name"], n["pads"])
            classes[n["name"]] = c
            if p < 0.8:
                conf.append({"net": n["name"], "class": c, "confidence": p, "why": why})
    upgrade_pairs(classes, nets, ctx.cons, conf)
    gnd_vias = [(v[0], v[1]) for n in nets if classes[n["name"]] == "GND" for v in n["vias"]]
    gnd_vias += [(p["x"], p["y"]) for n in nets if classes[n["name"]] == "GND" for p in n["pads"] if p["l"] == -1]
    fab_min = (ctx.cons.get("board") or {}).get("fab_min_track") or (0.127 if nL <= 2 else 0.09)
    per_net, ratios, crit_tau, norm_tau, over_budget = [], [], [], [], 0
    len_by_layer = [0.0] * max(nL, 1)
    against = {}
    layer_dir = {}
    for i, Ld in enumerate(ctx.cons.get("layers") or []):
        nm = Ld.get("name")
        idx = layers.index(nm) if nm in layers else (i if i < nL else None)
        if idx is not None and Ld.get("preferred_dir") in ("H", "V"):
            layer_dir[idx] = Ld["preferred_dir"]
    bottom_chains = []
    for n in nets:
        name, cls = n["name"], classes[n["name"]]
        rules = class_rules(cls, ctx.cons)
        rules["_zone"] = n.get("zone") or cls == "GND"
        bends0 = stats["bends"]
        nchains = 0
        routed = 0.0
        for l in sorted({s[0] for s in n["segs"]}):
            segs = [s for s in n["segs"] if s[0] == l]
            g = Graph(segs, n["pads"], n["vias"], l)
            check_graph(ctx, g, name, cls, rules, stats)
            nchains += len([c for c in g.chains if not c["arc"]])
            for c in g.chains:
                routed += c["len"]
                if 0 <= l < len(len_by_layer):
                    len_by_layer[l] += c["len"]
                if nL == 2 and l == nL - 1 and cls not in ("GND", "PWR_LOW", "PWR_MAIN", "SW"):
                    bottom_chains.append((name, c))
            if l in layer_dir and cls not in ("GND",):
                for s in segs:
                    if s[6]:
                        continue
                    dx, dy = abs(s[3] - s[1]), abs(s[4] - s[2])
                    Ls = math.hypot(dx, dy)
                    a = against.setdefault(l, [0.0, 0.0])
                    a[1] += Ls
                    if (layer_dir[l] == "H" and dy > 10 * dx) or (layer_dir[l] == "V" and dx > 10 * dy):
                        a[0] += Ls
        bends = stats["bends"] - bends0
        if nchains:
            ratios.append(bends / max(1, nchains))
        # 线宽
        mw = rules.get("min_width")
        if mw and n["segs"]:
            worst = None
            for s in n["segs"]:
                if s[5] < mw - 1e-6:
                    near_pad = seg_len(s) <= 1.0 and any(pt_in_pad(s[1], s[2], p) or pt_in_pad(s[3], s[4], p) for p in n["pads"] if p["l"] in (-1, s[0]))
                    if near_pad and s[5] >= fab_min - 1e-6:
                        continue                                  # RTW-10 焊盘处颈缩
                    if worst is None or s[5] < worst[5]:
                        worst = s
            if worst is not None:
                sev, rule = ("P0", "RTW-09") if worst[5] < fab_min - 1e-6 else ("P1", "RTW-01")
                ctx.add(rule, sev, name, worst[0], ((worst[1] + worst[3]) / 2, (worst[2] + worst[4]) / 2),
                        f"{cls} 线宽 {worst[5]} mm 低于{'板厂下限 ' + str(fab_min) if rule == 'RTW-09' else '网络类下限 ' + str(mw)} mm", worst[5], metric="VF-26")
        # 过孔预算
        vb = rules.get("via_budget")
        nv = len(n["vias"])
        if vb is not None and nv > vb and n["segs"]:
            sev = "P0" if vb == 0 else "P2"
            v0 = n["vias"][0]
            ctx.add("RTV-01", sev, name, None, (v0[0], v0[1]), f"{cls} 网络有 {nv} 个过孔，预算 {vb}", nv)
            over_budget += 1
        # 绕行率
        tau_max = rules.get("tau_max")
        pads_xy = [(p["x"], p["y"]) for p in n["pads"]]
        direct = oct_mst(pads_xy)
        if tau_max and direct >= 1.0 and routed >= 0.5 * direct and not n.get("zone"):
            tau = routed / direct
            if rules.get("critical"):
                crit_tau.append(tau)
            else:
                norm_tau.append(tau)
            lim = tau_max if not (direct < 5 and not rules.get("critical")) else 1.6
            if tau > lim:
                rule = "RTL-02" if rules.get("critical") else "RTL-01"
                sev = "P1" if rules.get("critical") else "P2"
                s0 = max(n["segs"], key=seg_len) if n["segs"] else None
                at = ((s0[1] + s0[3]) / 2, (s0[2] + s0[4]) / 2) if s0 else None
                ctx.add(rule, sev, name, None, at, f"绕行率 {tau:.2f}（走线 {routed:.1f} mm，八方向最短 {direct:.1f} mm，上限 {lim}）", round(tau, 2))
        # 晶振
        if cls == "XTAL" and n["segs"]:
            mx = rules.get("max_len_mm", 5.0)
            if routed > mx:
                ctx.add("RTL-03", "P1", name, None, None, f"晶振走线 {routed:.1f} mm，超过 {mx} mm", round(routed, 2), metric="VF-26")
        per_net.append({"net": name, "class": cls, "len": round(routed, 2), "vias": nv, "bends": bends})
    # 过孔压焊盘、换层回流过孔
    smd = [(n["name"], p) for n in nets for p in n["pads"] if p["l"] != -1 and p.get("w")]
    for n in nets:
        cls = classes[n["name"]]
        for v in n["vias"]:
            for owner, p in smd:
                if pt_in_pad(v[0], v[1], p, 0):
                    if owner != n["name"]:
                        ctx.add("RTV-05", "P0", n["name"], p["l"], (v[0], v[1]), f"过孔压在其他网络 {owner} 的焊盘 {p['ref']}.{p['pin']} 上")
                    elif p["w"] * p["h"] < 2.0 and str(p["pin"]).upper() not in ("EP", "PAD", "0", "GND", "THERMAL"):
                        ctx.add("RTV-05", "P1", n["name"], p["l"], (v[0], v[1]), f"盘中孔：过孔在焊盘 {p['ref']}.{p['pin']} 内（标准工艺不塞孔会漏锡）")
            if nL >= 4 and cls not in ("GND", "PWR_LOW", "PWR_MAIN", "SW") and n["segs"]:
                d = min((math.hypot(v[0] - x, v[1] - y) for x, y in gnd_vias), default=None)
                if d is None or d > 5.08:
                    ctx.add("RTV-02", "P1", n["name"], None, (v[0], v[1]), "换层过孔附近 5.08 mm 内没有地过孔" if d is not None else "换层过孔附近没有地过孔", round(d, 2) if d else None, metric="VF-26")
                elif d > 2.0:
                    ctx.add("RTV-02", "P2", n["name"], None, (v[0], v[1]), f"最近的地过孔在 {d:.1f} mm 外（建议 2 mm 内）", round(d, 2), metric="VF-26")
    # 2 层板底层跳线
    if nL == 2:
        for name, c in bottom_chains:
            if c["len"] > 10.0:
                ctx.add("RTL-11", "P2", name, 1, c["pts"][len(c["pts"]) // 2], f"底层信号跳线长 {c['len']:.1f} mm（2 层板底层应是地平面，单根 ≤ 10 mm）", round(c["len"], 1))
        bot = sum(c["len"] for _, c in bottom_chains)
        top = len_by_layer[0] if len_by_layer else 0
        if top > 0 and bot > 0.10 * top:
            ctx.add("RTL-11", "P2", None, 1, None, f"底层信号总长 {bot:.0f} mm，是顶层的 {bot / top:.0%}（上限 10%）", round(bot / top, 2))
    # 层方向
    for l, (a, t) in against.items():
        if t > 0 and a / t > 0.25:
            ctx.add("RTY-02", "P2", None, l, None, f"L{l + 1}（主方向 {layer_dir[l]}）逆向走线占 {a / t:.0%}", round(a / t, 2))
    # 地平面
    planes = (pack.get("checks") or {}).get("planes") or []
    roles = {}
    for i, Ld in enumerate(ctx.cons.get("layers") or []):
        idx = layers.index(Ld["name"]) if Ld.get("name") in layers else i
        roles[idx] = Ld.get("role")
    def plane_layer(l):                                     # 该当地平面的层：约束里标了 gnd_plane；否则 2 层板的底层、4 层以上的内层
        if roles:
            return roles.get(l) == "gnd_plane"
        return (nL == 2 and l == 1) or (nL >= 4 and 0 < l < nL - 1)
    gnd_layers = [p for p in planes if plane_layer(p["layer"]) and p.get("gnd_frac", 0) >= 0.5]
    no_plane = nL >= 2 and planes is not None and not gnd_layers and bool(pack.get("checks"))
    for p in gnd_layers:
        if p.get("frag", 0) > 0.10:
            ctx.add("RTY-05", "P1", None, p["layer"], None, f"L{p['layer'] + 1} 地平面破碎度 {p['frag']:.2f}（被走线切成 {p.get('pieces', '?')} 块，上限 0.10）", p["frag"])
        if nL >= 4 and 0 < p["layer"] < nL - 1:
            tr = [n["name"] for n in nets if classes[n["name"]] != "GND" and any(s[0] == p["layer"] for s in n["segs"])]
            if tr:
                ctx.add("RTY-04", "P0", ", ".join(tr[:4]), p["layer"], None, f"内层地平面 L{p['layer'] + 1} 上有其他网络的走线：{', '.join(tr[:4])}")
    # 成束
    bundle_sd = bundle_check(ctx, nets)
    # 走线原则：就近、差分对、优先级倒挂、攻击 / 敏感网络隔离（route_principles.py）
    import route_principles as RP
    values = {p["ref"]: p.get("value") for p in pack.get("parts") or [] if p.get("value")}
    pairs = RP.analyze(ctx, nets, classes, values, nL, bool(gnd_layers), {p["net"]: p["len"] for p in per_net})
    # 密度
    cv, overload = density(nets, layers, pack.get("board"))

    # ---------------- 评分
    v = ctx.out
    cnt = lambda rules_, sevs=None: sum(1 for x in v if x["rule"] in rules_ and (sevs is None or x["sev"] in sevs))
    m = {}
    def put(id_, value, frac, note=""):
        w = WEIGHTS[id_]
        frac = max(0.0, min(1.0, frac))
        m[id_] = {"name": NAMES[id_], "value": value, "weight": w, "deduct": round(w * frac, 1),
                  "level": "良好" if frac == 0 else ("警告" if frac < 0.75 else "不合格"), "note": note}
    n16, n17 = cnt({"RTG-01", "RTG-10"}), cnt({"RTG-02", "RTG-03"})
    put("VF-16", n16, 0 if n16 == 0 else 0.4 + 0.12 * (n16 - 1))
    put("VF-17", n17, 0 if n17 == 0 else 0.4 + 0.2 * (n17 - 1))
    per100 = 100.0 * (stats["short"] + stats["jog"] + stats["exit"] + stats["wchange"] + stats["stub"]) / max(1, stats["segs"])
    put("VF-18", round(per100, 2), ramp(per100, 1, 4), "每 100 段的短段、抖动、斜出焊盘、线宽突变与悬空线头数")
    ex = statistics.mean(stats["excess"]) if stats["excess"] else None
    put("VF-19", round(ex, 2) if ex is not None else None, ramp(ex, 0.5, 2.0) if ex is not None else 0,
        "每段连接的多余转角（45° 记 0.5、90° 记 1，扣除连接本身必需的转角）的平均值")
    n20 = over_budget + cnt({"RTV-05"})
    put("VF-20", n20, 0 if n20 == 0 else (0.5 if n20 <= 2 else 1.0), "超预算的网络 + 盘中孔")
    if gnd_layers:
        F = max(p.get("frag", 0) for p in gnd_layers)
        put("VF-21", round(F, 3), 1.0 if cnt({"RTY-04"}) else ramp(F, 0.05, 0.15), "最大破碎度 = 1 − 最大连通地铜 / 该层地铜")
    elif no_plane:
        put("VF-21", None, 0.5, "该当地平面的层（2 层板底层 / 4 层板内层）地铜覆盖不到一半")
    else:
        put("VF-21", None, 0, "未计算（需要从 .kicad_pcb 或铜皮数据包读入）")
    p90 = sorted(norm_tau)[int(0.9 * (len(norm_tau) - 1))] if norm_tau else None
    cmax = max(crit_tau) if crit_tau else None
    f22 = max(ramp(p90, 1.2, 1.4) if p90 else 0, ramp(cmax, 1.1, 1.2) if cmax else 0)
    put("VF-22", {"p90": round(p90, 2) if p90 else None, "critical_max": round(cmax, 2) if cmax else None}, f22)
    if bundle_sd is not None:
        put("VF-23", round(bundle_sd, 3), ramp(bundle_sd, 0.02, 0.08), "束内间距标准差（mm）")
    else:
        put("VF-23", None, 0, "约束里没有定义成束网络")
    worst_dir = max((a / t for a, t in against.values() if t > 0), default=None)
    n24 = cnt({"RTL-11"})
    f24 = max(ramp(worst_dir, 0.15, 0.35) if worst_dir is not None else 0, 0 if n24 == 0 else (0.5 if n24 <= 2 else 1.0))
    put("VF-24", {"against_max": round(worst_dir, 2) if worst_dir is not None else None, "rtl11": n24}, f24,
        "" if layer_dir or nL == 2 else "约束里没有层主方向")
    put("VF-25", {"cv": round(cv, 2) if cv is not None else None, "overloaded_tiles": overload},
        max(ramp(cv, 0.8, 1.6) if cv is not None else 0, 0.5 if overload else 0), "2.5 mm 瓦片走线占用率")
    crit = [x for x in v if x.get("metric") == "VF-26" or x["rule"] in ("RTL-03", "RTL-06", "RTV-02", "RTW-01", "RTW-09")]
    p0 = any(x["sev"] == "P0" for x in crit)
    p1 = sum(1 for x in crit if x["sev"] == "P1")
    p2 = sum(1 for x in crit if x["sev"] == "P2")
    put("VF-26", {"P0": int(p0), "P1": p1, "P2": p2}, 1.0 if p0 or p1 > 2 else (0.6 if p1 else (0.3 if p2 else 0)))
    def sev_frac(prefixes, extra=()):
        xs = [x for x in v if x["rule"].startswith(prefixes) or x["rule"] in extra]
        c = {s_: sum(1 for x in xs if x["sev"] == s_) for s_ in ("P0", "P1", "P2", "P3")}
        return c, (1.0 if c["P0"] else min(1.0, 0.5 * c["P1"] + 0.2 * c["P2"] + 0.05 * c["P3"]))
    c28, f28 = sev_frac(("RTD-",))
    put("VF-28", {**c28, "pairs": len(pairs)}, f28, "" if pairs else "没有识别到差分对")
    c29, f29 = sev_frac(("RTP-",))
    put("VF-29", c29, f29)
    c30, f30 = sev_frac(("RTO-",), ("RTS-06",))
    put("VF-30", c30, f30)
    for x in v:
        x.setdefault("metric", METRIC_OF.get(x["rule"], "VF-26" if x in crit else None))
    score = round(100 - 100.0 * sum(e["deduct"] for e in m.values()) / sum(WEIGHTS.values()), 1)   # 按总权重归一化到 100
    has_p0 = any(x["sev"] == "P0" for x in v)
    grade = "不通过（有 P0）" if has_p0 else ("优秀" if score >= 90 else "合格" if score >= 75 else "需返工" if score >= 60 else "不合格")
    v.sort(key=lambda x: (SEV_ORDER[x["sev"]], x["rule"], str(x.get("net"))))
    return {"kind": "routing-report", "version": 1, "score": score, "grade": grade, "pass": not has_p0,
            "gate": {"RTG-01": n16 - cnt({"RTG-10"}), "RTG-02/03": n17},
            "metrics": m, "violations": v, "pairs": pairs, "stats": {k: (round(statistics.mean(x), 3) if x else 0) if isinstance(x, list) else x for k, x in stats.items()}, "classes": classes, "confirm": conf, "nets": per_net}


def upgrade_pairs(classes, nets, cons, conf=None):
    """按命名成对的网络（X_P / X_N、D+ / D-…）如果被推成普通信号或时钟，改成差分类 DIFF100（USB 的保持 USB90）。"""
    import route_principles as RP
    given = set((cons.get("nets") or {}).keys()) if cons else set()
    for a, b in RP.pair_names([n["name"] for n in nets]):
        for x in (a, b):
            if x not in given and classes.get(x) in ("SIG", "CLK"):
                classes[x] = "DIFF100"
                if conf is not None:
                    conf[:] = [c for c in conf if c["net"] != x]
                    conf.append({"net": x, "class": "DIFF100", "confidence": 0.75, "why": f"与 {b if x == a else a} 命名成对"})

def bundle_check(ctx, nets):
    bundles = ctx.cons.get("bundles") or []
    if not bundles:
        return None
    by = {n["name"]: n for n in nets}
    sds = []
    for bd in bundles:
        segs = [(nm, s) for nm in bd.get("nets", []) if nm in by for s in by[nm]["segs"] if not s[6]]
        pitches = []
        for i, (na, a) in enumerate(segs):
            best = None
            for nb, b in segs:
                if nb == na or b[0] != a[0]:
                    continue
                u, w_ = (a[3] - a[1], a[4] - a[2]), (b[3] - b[1], b[4] - b[2])
                ang = angle_between(u, w_)
                if min(ang, 180 - ang) > 1.0:
                    continue
                La = math.hypot(*u)
                if La < 1.0:
                    continue
                ux, uy = u[0] / La, u[1] / La
                t1 = (b[1] - a[1]) * ux + (b[2] - a[2]) * uy
                t2 = (b[3] - a[1]) * ux + (b[4] - a[2]) * uy
                ov = min(La, max(t1, t2)) - max(0, min(t1, t2))
                if ov < 1.0:
                    continue
                d = abs((b[1] - a[1]) * uy - (b[2] - a[2]) * ux)
                best = d if best is None else min(best, d)
            if best is not None:
                pitches.append(best)
        if len(pitches) >= 2:
            sd = statistics.pstdev(pitches)
            if bd.get("pitch_mm"):
                sd = max(sd, abs(statistics.mean(pitches) - bd["pitch_mm"]))
            sds.append(sd)
            if sd > 0.05:
                ctx.add("RTS-03", "P2", bd.get("id"), None, None, f"束 {bd.get('id')} 间距不一致（标准差或偏差 {sd:.3f} mm）", round(sd, 3))
    return max(sds) if sds else None


def density(nets, layers, board, tile=2.5):
    occ = {}
    for n in nets:
        for s in n["segs"]:
            L = seg_len(s)
            k = max(1, int(L / 0.5))
            for i in range(k):
                t = (i + 0.5) / k
                x, y = s[1] + t * (s[3] - s[1]), s[2] + t * (s[4] - s[2])
                key = (s[0], int(math.floor(x / tile)), int(math.floor(y / tile)))
                occ[key] = occ.get(key, 0.0) + (L / k) * s[5] / (tile * tile)
    vals = list(occ.values())
    if len(vals) < 4:
        return None, 0
    mu = statistics.mean(vals)
    cv = statistics.pstdev(vals) / mu if mu > 0 else None
    return cv, sum(1 for x in vals if x > 0.6)


# ------------------------------------------------------------------ 读入
def load_any(path, cons=None):
    """返回 (pack, board)。.kicad_pcb 时 board 为 extract_copper.Board，其余为 None。"""
    p = Path(path)
    if p.suffix == ".kicad_pcb":
        import extract_copper as X
        b = X.parse_kicad(p)
        return X.build_pack(b, routing=False), b
    data = json.loads(p.read_text(encoding="utf-8"))
    if data.get("kind") == "copper-pack":
        return data, None
    return plan_to_pack(data), None


def plan_to_pack(data):
    """写入 EDA 之前的走线计划（plan.json）→ 数据包格式。单位 mm 或 mil；ydown=true 时把 y 取反。"""
    k = 0.0254 if data.get("units") == "mil" else 1.0
    sy = -1.0 if data.get("ydown") else 1.0
    layers = data.get("layers") or sorted({s[0] for s in data.get("segs", [])}, key=str)
    li = {n: i for i, n in enumerate(layers)}
    L = lambda x: li.get(x, x) if not isinstance(x, int) else x
    nets = {}
    def net(n):
        return nets.setdefault(n, {"name": n, "segs": [], "vias": [], "pads": []})
    for s in data.get("segs", []):
        arc = bool(s[7]) if len(s) > 7 else False
        net(s[6])["segs"].append([L(s[0]), s[1] * k, s[2] * k * sy, s[3] * k, s[4] * k * sy, s[5] * k, arc])
    for v in data.get("vias", []):
        net(v[3])["vias"].append([v[0] * k, v[1] * k * sy, v[2] * k])
    for p in data.get("pads", []):
        rot = p.get("rot", 0.0) * sy
        net(p.get("net", ""))["pads"].append({"ref": p.get("ref", ""), "pin": p.get("pin", ""), "l": L(p.get("layer", -1)), "x": p["x"] * k,
                                              "y": p["y"] * k * sy, "w": p.get("w", 0.5) * k, "h": p.get("h", 0.5) * k, "rot": rot, "shape": p.get("shape", "rect")})
    return {"kind": "plan", "layers": layers, "nets": list(nets.values()), "units": "mm"}


# ------------------------------------------------------------------ 约束生成
def make_constraints(pack, layers=None, fab="JLC-standard"):
    nL = layers or len(pack.get("layers") or []) or 2
    names = pack.get("layers") or (["F.Cu", "B.Cu"] if nL == 2 else ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"])
    W, H = (pack.get("board") or {}).get("w", 1), (pack.get("board") or {}).get("h", 1)
    long_ = "H" if W >= H else "V"
    short_ = "V" if long_ == "H" else "H"
    if nL == 2:
        lays = [{"name": names[0], "role": "signal", "preferred_dir": None},
                {"name": names[-1], "role": "gnd_plane", "routing": "jumpers_only", "max_jumper_mm": 10}]
    else:
        lays = [{"name": names[0], "role": "signal", "preferred_dir": long_, "against_dir_cost": 1.5},
                {"name": names[1], "role": "gnd_plane", "routing": "forbidden"}]
        lays += [{"name": n, "role": "power_pour", "routing": "limited"} for n in names[2:-1]]
        lays += [{"name": names[-1], "role": "signal", "preferred_dir": short_, "against_dir_cost": 1.5}]
    nets, confirm = {}, []
    for n in pack.get("nets", []):
        c, p, why = infer_class(n["name"], [norm_pad(q) for q in n.get("pads", [])])
        nets[n["name"]] = {"class": c, "confidence": p}
    cls = {k: v["class"] for k, v in nets.items()}
    upgrade_pairs(cls, [{"name": k} for k in nets], None)
    for k, c in cls.items():
        if c != nets[k]["class"]:
            nets[k] = {"class": c, "confidence": 0.75}
    confirm = [k for k, v in nets.items() if v["confidence"] < 0.8]
    import route_principles as RP
    pairs = [{"p": a, "n": b} for a, b in RP.pair_names(list(nets))]
    return {
        "schema": "lpiot-routing/1.0",
        "board": {"layers": nL, "copper_oz": 1, "fab": fab, "units": "mm", "fab_min_track": 0.127 if nL <= 2 else 0.09},
        "layers": lays,
        "geometry": merge_cons(None)["geometry"] | {"chamfer_min": {"k_w": 2.0, "abs_mm": 0.2}, "forbid_acute_tee": True},
        "netclasses": {k: {kk: vv for kk, vv in v.items()} for k, v in CLASSES.items()},
        "nets": nets, "confirm": confirm,
        "priority": PRIORITY, "pairs": pairs, "budgets": {}, "keepouts": [], "exempt_zones": [], "channels": [], "bundles": [], "escape": [], "locks": [],
    }


def kicad_dru(cons):
    """把能用 KiCad 自定义规则表达的几项写成 .kicad_dru。角度与线段长度规则未经 kicad-cli 实测，请按文档第 7 节自检。"""
    g = cons.get("geometry") or {}
    ms = (g.get("min_seg") or {}).get("abs_mm", 0.15)
    out = ["# 布线几何规则（由 route_lint.py 生成）。只覆盖 KiCad 能表达的部分；任意角度、抖动、出焊盘方向由 route_lint.py 检查。",
           "# 注意：track_angle 的角度定义与单位写法在 KiCad 9/10 之间有差异，第一次使用时请用 tests/fixtures/route-bad.kicad_pcb",
           "# 跑 kicad-cli pcb drc，确认报出锐角和短线段；没报就说明规则被忽略了。", "(version 1)", ""]
    out.append('(rule "RTG-02 禁止锐角拐角"\n  (constraint track_angle (min 90deg))\n  (condition "A.Type == \'Track\'"))\n')
    out.append(f'(rule "RTG-05 最小线段长度"\n  (constraint track_segment_length (min {ms}mm))\n  (condition "A.Type == \'Track\'"))\n')
    zero = [k for k, v in (cons.get("netclasses") or {}).items() if v.get("via_budget") == 0]
    if zero:
        cond = " || ".join(f"A.NetClass == '{k}'" for k in zero)
        out.append(f'(rule "RTV-01 {"/".join(zero)} 不打过孔"\n  (constraint via_count (max 0))\n  (condition "{cond}"))\n')
    for k, v in (cons.get("netclasses") or {}).items():
        if v.get("min_width"):
            out.append(f'(rule "RTW {k} 最小线宽"\n  (constraint track_width (min {v["min_width"]}mm))\n  (condition "A.NetClass == \'{k}\'"))\n')
    return "\n".join(out)


# ------------------------------------------------------------------ 报告
def report_md(rep, title="布线质量报告"):
    L = [f"# {title}", "", f"**得分 {rep['score']} / 100 · {rep['grade']}**", "",
         "| 编号 | 指标 | 值 | 等级 | 扣分 / 权重 | 说明 |", "|---|---|---|---|---|---|"]
    for k, e in rep["metrics"].items():
        val = e["value"] if not isinstance(e["value"], dict) else ", ".join(f"{a}={b}" for a, b in e["value"].items())
        L.append(f"| {k} | {e['name']} | {val if val is not None else '—'} | {e['level']} | {e['deduct']} / {e['weight']} | {e['note']} |")
    L += ["", f"违规 {len(rep['violations'])} 条：" + "，".join(f"{s} {sum(1 for x in rep['violations'] if x['sev'] == s)}" for s in ('P0', 'P1', 'P2', 'P3')), ""]
    if rep["violations"]:
        L += ["| 等级 | 规则 | 网络 | 层 | 位置 | 说明 |", "|---|---|---|---|---|---|"]
        for x in rep["violations"][:200]:
            at = x.get("at_src") or x.get("at")
            L.append(f"| {x['sev']} | {x['rule']} | {x.get('net') or ''} | {'' if x.get('layer') is None else 'L' + str(x['layer'] + 1)} | {at if at else ''} | {x['msg']} |")
        if len(rep["violations"]) > 200:
            L.append(f"| … | | | | | 另有 {len(rep['violations']) - 200} 条，见 JSON |")
    if rep.get("confirm"):
        L += ["", "网络类需要确认（自动推导置信度低于 0.8）：", ""]
        L += [f"- {c['net']} → {c['class']}（{c['why']}）" for c in rep["confirm"][:40]]
    L += ["", "修复：`python scripts/route_fix.py <板子.kicad_pcb>` 自动修复任意角度、锐角、短段和斜出焊盘；修不了的标为 needs_manual。", ""]
    return "\n".join(L)


def order_md(rows):
    L = ["# 推荐布线顺序", "", "按档位先后；同档内先布最密器件上的网络，再按八方向最短长度从短到长。地网络最后铺铜、补缝合过孔。", ""]
    cur = None
    k = 0
    for r in rows:
        if r["tier"] != cur:
            cur = r["tier"]
            L += ["", f"## {r['tier']}. {r['tier_name']}：{r['why']}", "", "| 顺序 | 网络 | 类 | 焊盘数 | 最短长度 mm |", "|---|---|---|---|---|"]
        k += 1
        L.append(f"| {k} | {r['net']} | {r['class']} | {r['pads']} | {r['len']} |")
    return "\n".join(L) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="布线几何检查、网络类推导与质量评分")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("lint"); s.add_argument("file"); s.add_argument("--constraints"); s.add_argument("-o", "--output"); s.add_argument("--json")
    s = sub.add_parser("gate"); s.add_argument("file"); s.add_argument("--constraints")
    s = sub.add_parser("order"); s.add_argument("file"); s.add_argument("--constraints"); s.add_argument("--json")
    s = sub.add_parser("constraints"); s.add_argument("file"); s.add_argument("--layers", type=int); s.add_argument("-o", "--output", default="constraints.json")
    s.add_argument("--dru")
    a = ap.parse_args(argv)
    cons = json.loads(Path(a.constraints).read_text(encoding="utf-8")) if getattr(a, "constraints", None) else None
    if a.cmd == "lint":
        pack, _ = load_any(a.file, cons)
        rep = analyze(pack, cons)
        md = report_md(rep, f"布线质量报告：{Path(a.file).name}")
        if a.output:
            Path(a.output).write_text(md, encoding="utf-8")
        if a.json:
            Path(a.json).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
        print(md)
        return 0 if rep["pass"] else 1
    if a.cmd == "gate":
        pack, _ = load_any(a.file, cons)
        rep = analyze(pack, cons)
        block = [x for x in rep["violations"] if x["rule"] in ("RTG-01", "RTG-02", "RTG-03")]
        for x in block:
            print(f"拦截 {x['rule']} {x.get('net')} L{(x.get('layer') or 0) + 1} {x.get('at')}: {x['msg']}")
        print(f"闸门：{'不通过，' + str(len(block)) + ' 处任意角度或锐角，先用 route_fix.py 修复' if block else '通过'}")
        return 1 if block else 0
    if a.cmd == "order":
        import route_principles as RP
        pack, _ = load_any(a.file, cons)
        rep = analyze(pack, cons)
        nets = [norm_net(n) for n in pack.get("nets", [])]
        rows = RP.routing_order(nets, rep["classes"])
        if a.json:
            Path(a.json).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        print(order_md(rows))
        return 0
    if a.cmd == "constraints":
        pack, _ = load_any(a.file)
        c = make_constraints(pack, a.layers)
        Path(a.output).write_text(json.dumps(c, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"已写入 {a.output}：{len(c['nets'])} 个网络，{len(c['confirm'])} 个需要确认网络类")
        if a.dru:
            Path(a.dru).write_text(kicad_dru(c), encoding="utf-8")
            print(f"已写入 {a.dru}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
