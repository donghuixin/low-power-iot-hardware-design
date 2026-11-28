#!/usr/bin/env python3
"""出图前检查：丝印（SLK）、位号编号（ANN）、泪滴（TDR），对照设计确认文件 G5 里用户做出的决定。

    python finish_lint.py board.kicad_pcb --brief design-brief.json [--bom bom.csv] [--json finish-lint.json] [-o 报告.md]
    python finish_lint.py board.kicad_pcb --model finish-model.json      # 只导出中间模型（给扩展做对齐测试）

检查分三块：
  丝印 SLK-01…13：离焊盘距离、线宽、字高、超出板框、文字重叠、位号缺失 / 指认不清 / 被器件盖住、阅读方向、底面镜像、
                  极性与 1 脚标记、必备标注（板名、版本、接口和按键说明、警示）、板厂订单号位置；
  编号 ANN-01…05：未编号（R?、U*）、重复、前缀与器件值不符（R 却是 uF）、编号顺序与跳号、与 BOM 不一致；
  泪滴 TDR-00…02：按策略需要泪滴的焊盘 / 过孔连接点没有泪滴、射频与差分网络上加了泪滴、读不到泪滴时提醒人工确认。

阈值来自设计确认 G5 的决定；默认按嘉立创标准丝印：线宽 ≥ 0.153 mm、字高 ≥ 1.0 mm、宽高比约 1:6、丝印离焊盘 ≥ 0.15 mm
（板厂会把压焊盘的丝印裁掉，字就残了）。--json 报告里带 rules_hash，design_gate.py 用它判断 G5 是否基于最新的决定。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_copper as EC  # noqa: E402
import layout_lint as LL  # noqa: E402
import route_lint as RL  # noqa: E402

PROCESS = {  # 嘉立创丝印工艺：最小线宽、最小字高（mm）
    "标准丝印": (0.153, 1.0),
    "高精度丝印": (0.1, 0.8),
    "镂空字": (0.2, 1.5),
}
TOL = 0.005          # 6 mil = 0.1524 mm，KiCad 默认 0.15 mm 视为满足
KEY_ROLES = {"ic", "soc_rf", "rf_module", "connector", "crystal", "button", "diode", "battery", "inductor", "antenna",
             "dcdc", "ldo", "charger", "imu", "magnetometer", "temp_humidity", "barometer", "microphone", "testpoint"}
POLARIZED = {"diode", "battery"}
UNIT_OF_PREFIX = {"R": "Ω", "C": "F", "L": "H"}


# ------------------------------------------------------------------ 几何
def rot(dx, dy, deg):
    a = math.radians(deg)
    return dx * math.cos(a) - dy * math.sin(a), dx * math.sin(a) + dy * math.cos(a)


def text_bbox(x, y, w_box, h_box, deg, ax=0.5, ay=0.5):
    """文字框（模型坐标，y 向上）：锚点在 (ax, ay) 比例处，按 deg 逆时针旋转后的外接矩形。"""
    pts = []
    for fx, fy in ((0, 0), (1, 0), (1, 1), (0, 1)):
        dx, dy = (fx - ax) * w_box, (fy - ay) * h_box
        rx, ry = rot(dx, dy, deg)
        pts.append((x + rx, y + ry))
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)]


def rect_dist(a, b):
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return math.hypot(dx, dy)


def seg_rect_dist(x1, y1, x2, y2, r):
    if (r[0] <= x1 <= r[2] and r[1] <= y1 <= r[3]) or (r[0] <= x2 <= r[2] and r[1] <= y2 <= r[3]):
        return 0.0
    edges = [((r[0], r[1]), (r[2], r[1])), ((r[2], r[1]), (r[2], r[3])), ((r[2], r[3]), (r[0], r[3])), ((r[0], r[3]), (r[0], r[1]))]
    best = min(pt_seg((x1, y1), a, b) for a, b in edges)
    best = min(best, min(pt_seg(c, (x1, y1), (x2, y2)) for c in ((r[0], r[1]), (r[2], r[1]), (r[2], r[3]), (r[0], r[3]))))
    for a, b in edges:
        if seg_cross((x1, y1), (x2, y2), a, b):
            return 0.0
    return best


def pt_seg(p, a, b):
    ax, ay, bx, by = a[0], a[1], b[0], b[1]
    L2 = (bx - ax) ** 2 + (by - ay) ** 2
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / L2))
    return math.hypot(p[0] - ax - t * (bx - ax), p[1] - ay - t * (by - ay))


def seg_cross(p1, p2, p3, p4):
    def o(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1, d2, d3, d4 = o(p3, p4, p1), o(p3, p4, p2), o(p1, p2, p3), o(p1, p2, p4)
    return d1 * d2 < 0 and d3 * d4 < 0


def overlap(a, b, shrink=0.0):
    return min(a[2], b[2]) - max(a[0], b[0]) > shrink and min(a[3], b[3]) - max(a[1], b[1]) > shrink


def pad_rect(p):
    q = dict(p, w=p.get("w") or 0.5, h=p.get("h") or p.get("w") or 0.5, rot=p.get("rot") or 0.0)
    cs = RL.pad_corners(q)
    xs, ys = [c[0] for c in cs], [c[1] for c in cs]
    return [min(xs), min(ys), max(xs), max(ys)]


def in_poly(x, y, poly):
    return RL.point_in_poly(x, y, poly)


# ------------------------------------------------------------------ 从 KiCad 提取中间模型
def extract_kicad(path):
    pack, _ = RL.load_any(path)
    ctx = RL.Ctx(None, pack.get("frame"))
    to_m = lambda x, y: ctx.to_model(x, y)   # noqa: E731
    root = EC.sexp(Path(path).read_text(encoding="utf-8"))
    nL = len(pack["layers"])

    def side_of(layer):
        return "bottom" if layer.startswith("B.") else "top"

    texts, lines = [], []

    def font_of(node):
        eff = EC.first(node, "effects")
        h = w = 1.0
        t = 0.15
        mirror = False
        hidden = any(x == "hide" for x in node if isinstance(x, str))
        hd = EC.first(node, "hide")
        if hd and (len(hd) < 2 or hd[1] == "yes"):
            hidden = True
        ax = 0.5
        if eff:
            f = EC.first(eff, "font")
            if f:
                sz = EC.first(f, "size")
                if sz:
                    h, w = float(sz[1]), float(sz[2])
                th = EC.first(f, "thickness")
                if th:
                    t = float(th[1])
            j = EC.first(eff, "justify")
            if j:
                mirror = "mirror" in j
                ax = 0.0 if "left" in j else 1.0 if "right" in j else 0.5
            if any(x == "hide" for x in eff if isinstance(x, str)):
                hidden = True
        return h, w, t, mirror, hidden, ax

    def add_text(s, kind, owner, x, y, deg, layer, node):
        h, w, t, mirror, hidden, ax = font_of(node)
        mx, my = to_m(x, y)
        n = max(1, len(s))
        box = text_bbox(mx, my, n * w * 0.9, h, deg, ax if not mirror else 1 - ax)
        texts.append({"text": s, "kind": kind, "owner": owner, "side": side_of(layer), "x": round(mx, 4), "y": round(my, 4),
                      "h": h, "w": t, "rot": round(deg % 360, 3), "mirror": mirror, "hidden": hidden, "bbox": box})

    def add_line(a, b, wdt, layer, owner):
        (x1, y1), (x2, y2) = to_m(*a), to_m(*b)
        lines.append({"side": side_of(layer), "x1": round(x1, 4), "y1": round(y1, 4), "x2": round(x2, 4), "y2": round(y2, 4), "w": wdt, "owner": owner})

    def graphics(node, prefix, owner, place):
        for kind in ("line", "rect", "circle", "arc", "poly"):
            for g in EC.find(node, f"{prefix}_{kind}"):
                L = EC.first(g, "layer")
                if not L or not L[1].endswith(".SilkS"):
                    continue
                st = EC.first(g, "stroke")
                wd = EC.first(st, "width") if st else EC.first(g, "width")
                wdt = float(wd[1]) if wd else 0.12
                P = lambda k: (float(EC.first(g, k)[1]), float(EC.first(g, k)[2]))   # noqa: E731
                if kind == "line":
                    add_line(place(*P("start")), place(*P("end")), wdt, L[1], owner)
                elif kind == "rect":
                    (x0, y0), (x1, y1) = P("start"), P("end")
                    cs = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
                    for a, b in zip(cs, cs[1:]):
                        add_line(place(*a), place(*b), wdt, L[1], owner)
                elif kind == "circle":
                    (cx, cy), (ex, ey) = P("center"), P("end")
                    r = math.hypot(ex - cx, ey - cy)
                    cs = [(cx + r * math.cos(k * math.pi / 8), cy + r * math.sin(k * math.pi / 8)) for k in range(17)]
                    for a, b in zip(cs, cs[1:]):
                        add_line(place(*a), place(*b), wdt, L[1], owner)
                elif kind == "arc":
                    pts = EC.arc3(P("start"), P("mid"), P("end"), 8)
                    for a, b in zip(pts, pts[1:]):
                        add_line(place(*a), place(*b), wdt, L[1], owner)
                else:
                    ptsn = EC.first(g, "pts")
                    cs = [(float(q[1]), float(q[2])) for q in EC.find(ptsn, "xy")] if ptsn else []
                    for a, b in zip(cs, cs[1:] + cs[:1]):
                        add_line(place(*a), place(*b), wdt, L[1], owner)

    for fp in EC.find(root, "footprint") + EC.find(root, "module"):
        at = EC.first(fp, "at")
        fx, fy = float(at[1]), float(at[2])
        frot = float(at[3]) if len(at) > 3 else 0.0
        place = lambda dx, dy, fx=fx, fy=fy, frot=frot: (fx + EC.kicad_rot(dx, dy, frot)[0], fy + EC.kicad_rot(dx, dy, frot)[1])   # noqa: E731
        ref = ""
        for pr in EC.find(fp, "property") + EC.find(fp, "fp_text"):
            key = pr[1]
            if key in ("Reference", "reference"):
                ref = pr[2]
        for pr in EC.find(fp, "property"):
            L = EC.first(pr, "layer")
            if not L or not L[1].endswith(".SilkS"):
                continue
            pa = EC.first(pr, "at")
            dx, dy = float(pa[1]), float(pa[2])
            deg = float(pa[3]) if len(pa) > 3 else 0.0
            x, y = place(dx, dy)
            kind = {"Reference": "ref", "Value": "value"}.get(pr[1], "text")
            add_text(pr[2].replace("${REFERENCE}", ref), kind, ref, x, y, deg, L[1], pr)
        for ft in EC.find(fp, "fp_text"):
            L = EC.first(ft, "layer")
            if not L or not L[1].endswith(".SilkS"):
                continue
            pa = EC.first(ft, "at")
            x, y = place(float(pa[1]), float(pa[2]))
            deg = float(pa[3]) if len(pa) > 3 else 0.0
            kind = {"reference": "ref", "value": "value"}.get(ft[1], "text")
            add_text(ft[2].replace("${REFERENCE}", ref), kind, ref, x, y, deg, L[1], ft)
        graphics(fp, "fp", ref, place)
    for gt in EC.find(root, "gr_text"):
        L = EC.first(gt, "layer")
        if not L or not L[1].endswith(".SilkS"):
            continue
        pa = EC.first(gt, "at")
        add_text(gt[1], "text", "", float(pa[1]), float(pa[2]), float(pa[3]) if len(pa) > 3 else 0.0, L[1], gt)
    graphics(root, "gr", "", lambda x, y: (x, y))

    # 泪滴：KiCad 8 起泪滴是带 (attr (teardrop …)) 的铺铜区
    tears = []
    for z in EC.find(root, "zone"):
        at = EC.first(z, "attr")
        if not at or not EC.first(at, "teardrop"):
            continue
        nn = EC.first(z, "net_name")
        L = EC.first(z, "layer")
        poly = EC.first(z, "polygon")
        pts = EC.first(poly, "pts") if poly else None
        if not (nn and L and pts):
            continue
        tears.append({"net": nn[1], "layer": L[1], "poly": [list(to_m(float(q[1]), float(q[2]))) for q in EC.find(pts, "xy")]})
    counts = {}
    for fp in EC.find(root, "footprint") + EC.find(root, "module"):
        r = next((pr[2] for pr in EC.find(fp, "property") + EC.find(fp, "fp_text") if pr[1] in ("Reference", "reference")), "")
        if r:
            counts[r] = counts.get(r, 0) + 1
    m = build_model(pack, texts, lines, tears, "kicad", "full")
    m["ref_counts"] = counts
    return m


def build_model(pack, texts, lines, tears, tear_source, silk_source):
    """pack（铜皮数据包，模型坐标）+ 丝印 → 中间模型。扩展端用同样的结构。"""
    nets = [RL.norm_net(n) for n in pack.get("nets", [])]
    classes = {n["name"]: RL.infer_class(n["name"], n["pads"])[0] for n in nets}
    RL.upgrade_pairs(classes, nets, RL.merge_cons(None), [])
    layer_names = pack.get("layers") or []
    parts = {p["ref"]: {"ref": p["ref"], "value": p.get("value"), "side": p.get("side", "top"), "rect": p["rect"], "pads": []}
             for p in pack.get("parts", []) if p.get("ref")}
    for n in nets:
        for p in n["pads"]:
            if p.get("ref") in parts:
                last = len(layer_names) - 1
                side = "both" if p.get("l") == -1 else ("bottom" if last > 0 and p.get("l") == last else "top")
                parts[p["ref"]]["pads"].append({"pin": str(p.get("pin", "")), "net": n["name"], "rect": [round(v, 4) for v in pad_rect(p)], "side": side})
    junctions = []
    for n in nets:
        for s in n["segs"]:
            l, x1, y1, x2, y2, w = s[0], s[1], s[2], s[3], s[4], s[5]
            for (px, py), (qx, qy) in (((x1, y1), (x2, y2)), ((x2, y2), (x1, y1))):
                L = math.hypot(qx - px, qy - py) or 1.0
                d = ((qx - px) / L, (qy - py) / L)
                hit = None
                for v in n["vias"]:
                    if math.hypot(v[0] - px, v[1] - py) <= v[2] / 2 + 1e-6:
                        hit = ("via", v[2], None, None)
                        break
                if not hit:
                    for p in n["pads"]:
                        if p.get("l") not in (-1, l):
                            continue
                        r = pad_rect(p)
                        if r[0] - 1e-6 <= px <= r[2] + 1e-6 and r[1] - 1e-6 <= py <= r[3] + 1e-6:
                            hit = ("tht" if p.get("l") == -1 else "pad", min(r[2] - r[0], r[3] - r[1]), p.get("ref"), str(p.get("pin", "")))
                            break
                if not hit:
                    continue
                kind, size, ref, pin = hit
                tear = None
                if tear_source == "kicad":
                    lname = layer_names[l] if l < len(layer_names) else ""
                    probe = (px + d[0] * (size / 2 + 0.15), py + d[1] * (size / 2 + 0.15))
                    tear = any(t["net"] == n["name"] and t["layer"] == lname and in_poly(probe[0], probe[1], t["poly"]) for t in tears)
                junctions.append({"net": n["name"], "cls": classes.get(n["name"], "SIG"), "kind": kind, "x": round(px, 4), "y": round(py, 4),
                                  "size": round(size, 4), "trace_w": w, "dir": [round(d[0], 4), round(d[1], 4)], "teardrop": tear,
                                  "ref": ref, "pin": pin, "layer": l})
    outline = (pack.get("board") or {}).get("outline") if isinstance(pack.get("board"), dict) else pack.get("board")
    return {"kind": "lpiot-finish-model", "version": 1, "outline": outline, "parts": list(parts.values()), "texts": texts, "lines": lines,
            "junctions": junctions, "teardrop_source": tear_source, "silk_graphics_source": silk_source}


# ------------------------------------------------------------------ 规则
def num(v, d=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def decisions(brief):
    """G5 的决定；还没回答的“待填”当作没给，按默认值检查。"""
    def clean(v):
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items() if not (isinstance(x, str) and x.strip().startswith("待填"))}
        return v
    return clean((brief or {}).get("G5_finish") or {})


def rules_hash(brief):
    import design_gate as DG
    return DG.finish_rules_hash(brief)


def parse_value_unit(v):
    """返回 'Ω' / 'F' / 'H' / None。"""
    if not v:
        return None
    s = str(v).strip()
    if re.search(r"\d\s*[pnuμµm]?F\b", s, re.I) or re.search(r"\d[pnuμµ]\d", s, re.I) and not re.search(r"H", s):
        return "F"
    if re.search(r"\d\s*[pnuμµm]?H\b", s, re.I):
        return "H"
    if re.search(r"(\d\s*(Ω|ohm|R|k|K|M)\b)|(\d[RkKM]\d)|^\d+(\.\d+)?$", s):
        return "Ω"
    return None


class Finish:
    def __init__(self, model, brief=None, bom=None):
        self.m, self.b, self.bom = model, brief or {}, bom
        self.d = decisions(brief)
        self.silk = self.d.get("silk") or {}
        self.issues = []
        proc = PROCESS.get(self.silk.get("process"), PROCESS["标准丝印"])
        self.min_w = max(proc[0], num(self.silk.get("line_width_mm"), 0) or 0) if self.silk.get("line_width_mm") else proc[0]
        self.min_h = max(proc[1], num(self.silk.get("text_height_mm"), 0) or 0) if self.silk.get("text_height_mm") else proc[1]
        self.clear = max(0.15, num(self.silk.get("pad_clearance_mm"), 0.15) or 0.15)
        roles = (self.b.get("roles") or {})
        self.counts = dict(model.get("ref_counts") or {})
        for p in model["parts"]:
            self.counts.setdefault(p["ref"], 1)
        self.all_parts = {p["ref"]: dict(p, role=LL.role_of(p["ref"], p.get("value"), roles)) for p in model["parts"]}
        # 重复的位号几何位置不可靠（两个器件被当成一个），不参与丝印的几何检查，只报 ANN-02
        self.parts = {r: p for r, p in self.all_parts.items() if self.counts.get(r, 1) == 1}

    def add(self, rule, sev, refs, msg, fix="", at=None, box=None):
        v = {"rule": rule, "sev": sev, "refs": list(refs), "msg": msg}
        if fix:
            v["fix"] = fix
        if at is not None:
            v["at"] = [round(at[0], 3), round(at[1], 3)]
        if box is not None:
            v["box"] = [round(x, 3) for x in box]
        self.issues.append(v)

    def visible_texts(self):
        return [t for t in self.m["texts"] if not t.get("hidden")]

    # ---------------------------------------------------------------- 丝印
    def check_silk(self):
        pads = [(p["ref"], q) for p in self.parts.values() for q in p["pads"]]
        same = lambda side, q: q.get("side", "top") in (side, "both")   # noqa: E731
        thin = {}

        def small(rule, sev, val, need, name, c, box, what):
            k = (rule, val)
            thin.setdefault(k, {"sev": sev, "need": need, "names": [], "at": c, "box": box, "what": what})
            if name not in thin[k]["names"]:
                thin[k]["names"].append(name)
        poly = self.m.get("outline") or []
        allowed = {0.0} if self.silk.get("orientation") == "全部 0°" else {0.0, 90.0}
        vt = self.visible_texts()
        for t in vt:
            name = t["text"]
            c = ((t["bbox"][0] + t["bbox"][2]) / 2, (t["bbox"][1] + t["bbox"][3]) / 2)
            hit = [(r, q) for r, q in pads if same(t["side"], q) and rect_dist(t["bbox"], q["rect"]) < self.clear - 1e-6]
            if hit:
                r, q = hit[0]
                self.add("SLK-01", "P1", [t["owner"] or name] + ([r] if r != t["owner"] else []), f"丝印“{name}”离 {r}.{q['pin']} 焊盘不到 {self.clear:g} mm：板厂会把压到焊盘的部分裁掉，字会残缺",
                         "把文字挪开，或缩小到不压焊盘", c, t["bbox"])
            if t["w"] < self.min_w - TOL:
                small("SLK-02", "P1", t["w"], self.min_w, t["owner"] or name, c, t["bbox"], "文字线宽")
            if t["h"] < self.min_h - TOL:
                small("SLK-03", "P1", t["h"], self.min_h, t["owner"] or name, c, t["bbox"], "字高")
            elif t["h"] > 0 and t["w"] / t["h"] < 1 / 8:
                self.add("SLK-03", "P3", [t["owner"] or name], f"丝印“{name}”笔画太细（线宽 / 字高 = 1:{t['h'] / t['w']:.0f}，建议约 1:6）", "加粗笔画", c, t["bbox"])
            if poly and not all(in_poly(x, y, poly) for x, y in ((t["bbox"][0], t["bbox"][1]), (t["bbox"][2], t["bbox"][1]), (t["bbox"][2], t["bbox"][3]), (t["bbox"][0], t["bbox"][3]))):
                self.add("SLK-04", "P1", [t["owner"] or name], f"丝印“{name}”超出板框：超出的部分不会印出来", "挪回板内", c, t["bbox"])
            r0 = math.floor((t["rot"] % 360) * 10 + 0.5) / 10 % 360
            if r0 not in allowed:
                way = "倒着" if abs(r0 - 180) < 1 or abs(r0 - 270) < 1 else "斜着"
                self.add("SLK-09", "P2", [t["owner"] or name], f"丝印“{name}”旋转 {r0:g}°，{way}读：全板文字只用 {'、'.join(f'{a:g}°' for a in sorted(allowed))}，装配和维修时不用转板",
                         "旋转到 0° 或 90°", c, t["bbox"])
            if t["side"] == "bottom" and not t.get("mirror"):
                self.add("SLK-10", "P1", [t["owner"] or name], f"底面丝印“{name}”没有镜像：从底面看是反字", "设为镜像", c, t["bbox"])
            # 被器件盖住
            under = [p for p in self.parts.values() if p["side"] == t["side"] and p["rect"][0] < c[0] < p["rect"][2] and p["rect"][1] < c[1] < p["rect"][3]]
            if under:
                self.add("SLK-08", "P2", [t["owner"] or name] + ([under[0]["ref"]] if under[0]["ref"] != t["owner"] else []),
                         f"丝印“{name}”在 {under[0]['ref']} 下面：贴片后被器件盖住，装配和维修时看不到", "挪到器件旁边", c, t["bbox"])
        for ln in self.m["lines"]:
            mid = ((ln["x1"] + ln["x2"]) / 2, (ln["y1"] + ln["y2"]) / 2)
            hit = [(r, q) for r, q in pads if same(ln["side"], q) and seg_rect_dist(ln["x1"], ln["y1"], ln["x2"], ln["y2"], q["rect"]) - ln["w"] / 2 < self.clear - 1e-6]
            if hit:
                r, q = hit[0]
                self.add("SLK-01", "P1", [ln["owner"] or r], f"丝印线离 {r}.{q['pin']} 焊盘不到 {self.clear:g} mm：会被裁掉，或者印到焊盘上影响焊接", "修改封装丝印或挪开线条", mid)
            if ln["w"] < self.min_w - TOL:
                small("SLK-02", "P1", ln["w"], self.min_w, (ln["owner"] or "板上") + " 的丝印线", mid, None, "丝印线宽")
            if poly and not (in_poly(ln["x1"], ln["y1"], poly) and in_poly(ln["x2"], ln["y2"], poly)):
                self.add("SLK-04", "P1", [ln["owner"] or "丝印线"], "丝印线超出板框", "挪回板内", mid)
        for (rule, val), g in sorted(thin.items(), key=lambda kv: (kv[0][0], kv[0][1])):
            names = g["names"]
            more = f" 等 {len(names)} 处" if len(names) > 6 else ""
            bad = "印出来会断笔或看不清" if rule == "SLK-02" else "印出来认不出"
            self.add(rule, g["sev"], [n.split(" ")[0] for n in names], f"{g['what']} {val:g} mm，小于 {g['need']:g} mm：{'、'.join(names[:6])}{more}（{bad}）",
                     f"{g['what']}改到 ≥ {g['need']:g} mm", g["at"], g["box"])
        for i in range(len(vt)):
            for j in range(i + 1, len(vt)):
                a, b = vt[i], vt[j]
                if a["side"] == b["side"] and overlap(a["bbox"], b["bbox"], 0.05):
                    self.add("SLK-05", "P2", [a["owner"] or a["text"], b["owner"] or b["text"]], f"丝印“{a['text']}”和“{b['text']}”重叠", "错开摆放",
                             ((a["bbox"][0] + a["bbox"][2]) / 2, (a["bbox"][1] + a["bbox"][3]) / 2), a["bbox"])
        self.check_designators(vt)
        self.check_polarity()
        self.check_markings(vt)

    def check_designators(self, vt):
        pol = self.silk.get("designators") or "全部显示"
        if pol.startswith("不印"):
            return
        refs_shown = {}
        for t in vt:
            if t["kind"] == "ref" and t["owner"]:
                refs_shown.setdefault(t["owner"], t)
        for ref, p in self.parts.items():
            if p["role"] in ("hole",):
                continue
            need = pol == "全部显示" or p["role"] in KEY_ROLES
            t = refs_shown.get(ref)
            if not t:
                if need:
                    self.add("SLK-06", "P1", [ref], f"{ref} 没有可见的位号丝印（策略：{pol}）", "显示位号并摆到器件旁边", ((p["rect"][0] + p["rect"][2]) / 2, (p["rect"][1] + p["rect"][3]) / 2))
                continue
            c = ((t["bbox"][0] + t["bbox"][2]) / 2, (t["bbox"][1] + t["bbox"][3]) / 2)
            box = t["bbox"]
            own = rect_dist(box, p["rect"])
            near = min(((rect_dist(box, q["rect"]), q["ref"]) for q in self.parts.values() if q["ref"] != ref and q["side"] == t["side"]), default=(1e9, ""))
            if own > 3.0 or (near[0] + 0.2 < own):
                why = f"离 {ref} {own:.1f} mm" + (f"，反而离 {near[1]} 更近" if near[0] + 0.2 < own else "")
                self.add("SLK-07", "P2", [ref] + ([near[1]] if near[0] + 0.2 < own else []), f"位号 {ref} 指认不清：{why}", "把位号挪到自己器件旁边（≤ 3 mm），不要放在两个器件之间", c, box)

    def check_polarity(self):
        if self.m.get("silk_graphics_source") != "full":
            return            # 读不到封装自带的丝印（嘉立创扩展），极性标记由用户在 G5 里逐项确认
        marks = [(ln["x1"], ln["y1"]) for ln in self.m["lines"]] + [(ln["x2"], ln["y2"]) for ln in self.m["lines"]] + \
                [(((ln["x1"] + ln["x2"]) / 2), ((ln["y1"] + ln["y2"]) / 2)) for ln in self.m["lines"]] + \
                [(((t["bbox"][0] + t["bbox"][2]) / 2), ((t["bbox"][1] + t["bbox"][3]) / 2)) for t in self.visible_texts() if t["text"].strip() in ("1", "+", "•", "●")]
        for ref, p in self.parts.items():
            npads = len(p["pads"])
            pol = p["role"] in POLARIZED or (p["role"] in ("ic", "soc_rf", "dcdc", "ldo", "charger", "imu", "magnetometer", "temp_humidity", "barometer", "microphone") and npads >= 4) \
                or (p["role"] == "connector" and npads >= 3) or (p["role"] == "cap" and re.search(r"钽|电解|tant|elec", str(p.get("value") or ""), re.I))
            if not pol:
                continue
            p1 = next((q for q in p["pads"] if q["pin"] in ("1", "A1", "K")), None)
            if not p1:
                continue
            others = [q for q in p["pads"] if q is not p1]
            ok = False
            for mx, my in marks:
                d1 = rect_dist([mx, my, mx, my], p1["rect"])
                if d1 <= 1.2 and all(d1 + 0.1 < rect_dist([mx, my, mx, my], q["rect"]) for q in others):
                    ok = True
                    break
            if not ok:
                kind = "阴极 / 正极" if p["role"] in POLARIZED or p["role"] == "cap" else "1 脚"
                self.add("SLK-11", "P1", [ref], f"{ref} 没有检测到{kind}标记：贴反了没有参照", f"在 {ref}.1 旁加{kind}标记（圆点、横杠或 +）",
                         ((p1["rect"][0] + p1["rect"][2]) / 2, (p1["rect"][1] + p1["rect"][3]) / 2))

    def check_markings(self, vt):
        norm = lambda s: re.sub(r"\s+", "", str(s)).lower()   # noqa: E731
        alltext = [norm(t["text"]) for t in vt]
        bm = self.silk.get("board_marking") or {}
        for key, zh in (("name", "板名"), ("version", "版本")):
            v = bm.get(key)
            if isinstance(v, str) and v.strip() and v.strip() not in ("无",) and not any(norm(v) in s for s in alltext):
                self.add("SLK-12", "P1", [], f"板上没有找到{zh}丝印“{v}”", f"加上{zh}，改版时才分得清")
        labels = self.silk.get("labels")
        for it in labels if isinstance(labels, list) else []:
            if not isinstance(it, dict) or not it.get("text"):
                continue
            p = self.parts.get(it.get("ref"))
            near = [t for t in vt if norm(it["text"]) in norm(t["text"]) and (not p or rect_dist(t["bbox"], p["rect"]) <= 6.0)]
            if not near:
                self.add("SLK-12", "P1", [it.get("ref", "")], f"{it.get('ref', '')} 旁边没有找到说明丝印“{it['text']}”", "在接口 / 按键 / 指示灯旁加上说明",
                         ((p["rect"][0] + p["rect"][2]) / 2, (p["rect"][1] + p["rect"][3]) / 2) if p else None)
        warns = self.silk.get("warnings")
        for w in warns if isinstance(warns, list) else []:
            s = w.get("text") if isinstance(w, dict) else w
            if isinstance(s, str) and s.strip() and not any(norm(s) in t for t in alltext):
                self.add("SLK-12", "P1", [], f"板上没有找到警示丝印“{s}”", "加上警示标注")
        jlc = self.silk.get("jlc_order_no") or "板厂默认位置"
        if jlc == "指定位置" and not any("jlcjlcjlcjlc" in s for s in alltext):
            self.add("SLK-13", "P1", [], "选了“指定位置”放板厂订单号，但板上没有“JLCJLCJLCJLC”占位文字", "在想放订单号的空白处加一行 JLCJLCJLCJLC（字高 ≥ 1 mm）")
        elif jlc == "板厂默认位置":
            self.add("SLK-13", "P3", [], "板厂会在空白处自动加订单号，可能落在你不想要的地方（比如外壳开窗或导光柱下）", "介意的话改成“指定位置”并放 JLCJLCJLCJLC 占位")

    # ---------------------------------------------------------------- 位号编号
    def check_annotation(self):
        ann = self.d.get("annotation") or {}
        refs = [p["ref"] for p in self.m["parts"]]
        seen = {r: self.counts.get(r, 1) for r in refs}
        for r, n in seen.items():
            p = self.all_parts[r]
            at = ((p["rect"][0] + p["rect"][2]) / 2, (p["rect"][1] + p["rect"][3]) / 2)
            if not re.fullmatch(r"[A-Za-z_]+[0-9]+[A-Za-z]?", r):
                self.add("ANN-01", "P0", [r], f"位号“{r}”没有编号（或格式不对）：BOM、贴片坐标和维修都会对不上", "在原理图里重新编号，再更新到 PCB", at)
            if n > 1:
                self.add("ANN-02", "P0", [r], f"位号 {r} 重复了 {n} 次：贴片坐标和 BOM 会张冠李戴", "在原理图里重新编号，再更新到 PCB", at)
            m = re.match(r"([A-Za-z]+)", r)
            want = UNIT_OF_PREFIX.get(m.group(1).upper()) if m and m.group(1).upper() in UNIT_OF_PREFIX else None
            got = parse_value_unit(p.get("value"))
            if want and got and want != got:
                self.add("ANN-03", "P1", [r], f"{r} 的前缀是 {m.group(1)}（{ {'Ω': '电阻', 'F': '电容', 'H': '电感'}[want] }），但值是“{p.get('value')}”", "核对是位号错了还是值错了", at)
        groups = {}
        for r in refs:
            m = re.fullmatch(r"([A-Za-z]+)(\d+)", r)
            if m:
                groups.setdefault(m.group(1).upper(), []).append((int(m.group(2)), r))
        for pre, items in groups.items():
            nums = sorted(n for n, _ in items)
            missing = sorted(set(range(1, nums[-1] + 1)) - set(nums))
            if missing and len(missing) <= 20:
                self.add("ANN-04", "P3", [], f"{pre} 系列跳号：缺 {', '.join(f'{pre}{x}' for x in missing[:8])}{' 等' if len(missing) > 8 else ''}", "需要的话在原理图里重新编号")
        if (ann.get("scheme") or "").startswith("按位置"):
            for pre, items in groups.items():
                pts = sorted(items)
                rows = []
                for n, r in pts:
                    p = self.all_parts[r]
                    rows.append((n, r, (p["rect"][0] + p["rect"][2]) / 2, (p["rect"][1] + p["rect"][3]) / 2))
                # 按位置编号：从上到下分行（5 mm 一行），行内从左到右
                order = sorted(rows, key=lambda t: (-math.floor(t[3] / 5 + 0.5), t[2]))
                bad = [(a[1], b[1]) for a, b in zip(order, order[1:]) if a[0] > b[0]]
                if bad:
                    self.add("ANN-04", "P2", [bad[0][0], bad[0][1]], f"{pre} 系列没有按位置编号（{bad[0][0]} 在 {bad[0][1]} 前面）：维修时按位号找器件要来回找", "用 EDA 的“按位置重新编号”，再反标回原理图")
        if self.bom:
            board, bom = set(refs), set(self.bom)
            for r in sorted(bom - board)[:20]:
                self.add("ANN-05", "P1", [r], f"BOM 里有 {r}，板上没有", "原理图更新到 PCB，或从 BOM 删掉")
            for r in sorted(board - bom)[:20]:
                p = self.all_parts[r]
                self.add("ANN-05", "P1", [r], f"板上有 {r}，BOM 里没有", "核对 BOM 是否过期", ((p["rect"][0] + p["rect"][2]) / 2, (p["rect"][1] + p["rect"][3]) / 2))

    # ---------------------------------------------------------------- 泪滴
    def check_teardrops(self):
        td = self.d.get("teardrops") or {}
        policy = td.get("policy") or "仅过孔和插件孔"
        if policy == "不加":
            return
        excl = td.get("exclude_rf_diff") not in ("保留", False)
        sensitive = {"RF50", "USB90", "DIFF100"}
        unknown = self.m.get("teardrop_source") != "kicad"
        need = []
        for j in self.m["junctions"]:
            if excl and j["cls"] in sensitive:
                if j["teardrop"]:
                    self.add("TDR-02", "P2", [j["net"]], f"{j['net']}（{j['cls']}）在 {j['kind']} 连接处加了泪滴：会改变阻抗，射频和差分线一般不加", "去掉这个泪滴", (j["x"], j["y"]))
                continue
            if policy.startswith("仅过孔") and j["kind"] == "pad":
                continue
            if j["trace_w"] >= 0.8 * j["size"]:
                continue
            need.append(j)
        if unknown:
            if need:
                self.add("TDR-00", "P2", [], f"读不到泪滴（嘉立创扩展里没有泪滴的接口）：按“{policy}”策略有 {len(need)} 处连接点需要泪滴，请在嘉立创里执行 工具 → 泪滴，并在 G5 里确认已执行",
                         "执行泪滴后重新铺铜，再逐处看一遍", (need[0]["x"], need[0]["y"]))
            return
        seen = set()
        for j in need:
            key = (j["net"], j["x"], j["y"])
            if j["teardrop"] or key in seen:
                continue
            seen.add(key)
            where = f"{j['ref']}.{j['pin']}" if j.get("ref") else "过孔"
            self.add("TDR-01", "P1", [j.get("ref") or j["net"]], f"{j['net']} 在 {where} 的连接处没有泪滴（线宽 {j['trace_w']:g} mm，{'过孔' if j['kind'] == 'via' else '焊盘'} {j['size']:g} mm）",
                     "执行泪滴，钻孔偏位时线不会被切断", (j["x"], j["y"]))

    def run(self):
        self.check_silk()
        self.check_annotation()
        self.check_teardrops()
        order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
        self.issues.sort(key=lambda v: (order[v["sev"]], v["rule"], v["refs"][:1]))
        return self.issues


def unresolved_p1(issues, brief):
    import design_gate as DG
    return DG.finish_unresolved({"issues": issues}, brief or {})


def run(model, brief=None, bom=None):
    issues = Finish(model, brief, bom).run()
    cnt = {s: sum(1 for v in issues if v["sev"] == s) for s in ("P0", "P1", "P2", "P3")}
    unres = unresolved_p1(issues, brief)
    rep = {"kind": "lpiot-finish-lint", "version": 1, "p0": cnt["P0"], "p1": cnt["P1"], "p2": cnt["P2"], "p3": cnt["P3"],
           "pass": cnt["P0"] == 0 and not unres, "unresolved_p1": len(unres), "issues": issues,
           "teardrop_source": model.get("teardrop_source"), "silk_graphics_source": model.get("silk_graphics_source")}
    if brief:
        rep["rules_hash"] = rules_hash(brief)
    else:
        rep["note"] = "没有设计确认文件：按嘉立创标准丝印默认值检查；板名、版本、接口说明、订单号位置、泪滴策略需要 G5 的决定。"
    return rep


def load_bom(path):
    refs = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    if not rows:
        return refs
    head = [h.strip().lower() for h in rows[0]]
    col = next((i for i, h in enumerate(head) if h in ("designator", "reference", "references", "位号", "标识")), 0)
    for r in rows[1:]:
        if col < len(r):
            refs += [x.strip() for x in re.split(r"[,\s;，]+", r[col]) if x.strip()]
    return refs


def report_md(rep):
    lines = ["# 出图前检查：丝印、位号编号、泪滴", "",
             f"P0 {rep['p0']} · P1 {rep['p1']}（未处理 {rep['unresolved_p1']}）· P2 {rep['p2']} · P3 {rep['p3']} · " + ("通过" if rep["pass"] else "不通过"), ""]
    if rep.get("note"):
        lines += [f"> {rep['note']}", ""]
    lines += ["| 级别 | 规则 | 对象 | 问题 | 怎么改 |", "|---|---|---|---|---|"]
    for v in rep["issues"]:
        lines.append(f"| {v['sev']} | {v['rule']} | {'、'.join(v['refs'])} | {v['msg']} | {v.get('fix', '')} |")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="出图前检查：丝印、位号编号、泪滴")
    ap.add_argument("board", help=".kicad_pcb，或 --model 导出的中间模型 JSON")
    ap.add_argument("--brief", help="design-brief.json（G5 的决定）")
    ap.add_argument("--bom", help="BOM（CSV，含 Designator / 位号 列），用于核对位号")
    ap.add_argument("--json", help="写出 JSON 报告（G5 用）")
    ap.add_argument("-o", "--output", help="写出 Markdown 报告")
    ap.add_argument("--model", help="只把中间模型写到这个文件")
    a = ap.parse_args(argv)
    if a.board.endswith(".json"):
        model = json.loads(Path(a.board).read_text(encoding="utf-8"))
    else:
        model = extract_kicad(a.board)
    if a.model:
        Path(a.model).write_text(json.dumps(model, ensure_ascii=False), encoding="utf-8")
        print(f"已写入中间模型 {a.model}")
        return 0
    brief = json.loads(Path(a.brief).read_text(encoding="utf-8")) if a.brief else None
    rep = run(model, brief, load_bom(a.bom) if a.bom else None)
    if a.json:
        Path(a.json).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    md = report_md(rep)
    if a.output:
        Path(a.output).write_text(md, encoding="utf-8")
        print(f"已写入 {a.output}：P0 {rep['p0']}、P1 {rep['p1']}（未处理 {rep['unresolved_p1']}）、P2 {rep['p2']}")
    else:
        print(md)
    return 0 if rep["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
