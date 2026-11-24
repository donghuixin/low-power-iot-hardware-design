#!/usr/bin/env python3
"""从布好的 PCB 提取铜皮，生成布局布线验证器（阶段 R）用的铜皮数据包 copper-pack.json。

繁重的几何处理在这里离线完成，浏览器只拿到已经栅格化的小数据：
每层按 --res（默认 0.05 mm）画成网络编号位图，再降采样到求解网格（长边 --cells 格，默认 200）。

用法:
    # KiCad（6/7/8，需先在 KiCad 里填充铺铜）
    python extract_copper.py board.kicad_pcb --project layout.json -o copper-pack.json
    # 通用：Gerber（RS-274X，铜层按叠层顺序列出）+ IPC-D-356 网表 + 板框
    python extract_copper.py --gerber top.gtl in1.g2 in2.g3 bottom.gbl --outline board.gko \\
        --ipc356 board.ipc --project layout.json -o copper-pack.json

嘉立创 EDA 专业版：导出 Gerber 时一并导出 IPC 网表（IPC-D-356A），按第二种用法处理。
--project 给出布局规划器导出的布局 JSON，用来取网络类别；不给时按网络名猜（GND/VCC/RF/CLK/ADC 等）。

依赖：numpy、scipy、Pillow。
"""
import argparse
import base64
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

VERSION = 1

# ---------------------------------------------------------------- 通用模型
class Board:
    def __init__(self):
        self.layers = []            # 铜层名称，按叠层顺序（顶层在前）
        self.outline = []           # [(x, y)]，源坐标
        self.nets = {}              # 名称 → 序号（从 1 开始）
        self.segs = []              # (layer, x1, y1, x2, y2, w, net)
        self.pads = []              # dict(ref, pin, layer(-1 全层), x, y, shape, w, h, rot, net)
        self.vias = []              # (x, y, d, net)
        self.zones = []             # (layer, net, [(x, y)])
        self.regions = []           # Gerber 区域：(layer, [(x, y)], dark)
        self.flashes = []           # Gerber 焊盘：(layer, x, y, shape, w, h, dark)
        self.draws = []             # Gerber 画线：(layer, x1, y1, x2, y2, w, dark)
        self.ydown = False          # KiCad 坐标 y 向下
        self.source = ""
        self.parts = {}             # ref → dict(x, y, side)

    def net_id(self, name):
        if not name:
            return 0
        if name not in self.nets:
            self.nets[name] = len(self.nets) + 1
        return self.nets[name]


# ---------------------------------------------------------------- KiCad
def sexp(text):
    """把 S 表达式解析成嵌套列表。"""
    tok = re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+', text)
    stack, cur = [], []
    for t in tok:
        if t == "(":
            stack.append(cur); cur = []
        elif t == ")":
            done = cur; cur = stack.pop(); cur.append(done)
        else:
            cur.append(t[1:-1].replace('\\"', '"') if t.startswith('"') else t)
    return cur[0] if cur else []


def find(node, key):
    return [c for c in node if isinstance(c, list) and c and c[0] == key]


def first(node, key):
    r = find(node, key)
    return r[0] if r else None


def num(v):
    return float(v)


def kicad_rot(dx, dy, deg):
    a = math.radians(deg)
    return dx * math.cos(a) + dy * math.sin(a), -dx * math.sin(a) + dy * math.cos(a)


def parse_kicad(path):
    b = Board()
    b.source = "kicad"
    b.ydown = True
    root = sexp(Path(path).read_text(encoding="utf-8"))
    netnames = {}
    for n in find(root, "net"):
        if len(n) >= 3:
            netnames[n[1]] = n[2]
            if n[2]:
                b.net_id(n[2])
    lay = first(root, "layers")
    cu = []
    for L in lay[1:] if lay else []:
        if isinstance(L, list) and len(L) >= 3 and L[1].endswith(".Cu"):
            cu.append((int(L[0]), L[1]))
    # KiCad 6–8：F.Cu=0，内层 1..30，B.Cu=31；KiCad 9 编号不同，按名称排序更稳
    def order(name):
        if name == "F.Cu":
            return -1
        if name == "B.Cu":
            return 999
        m = re.match(r"In(\d+)\.Cu", name)
        return int(m.group(1)) if m else 500
    b.layers = [n for _, n in sorted(cu, key=lambda t: order(t[1]))]
    li = {n: i for i, n in enumerate(b.layers)}

    def netof(node):
        n = first(node, "net")
        if not n or len(n) < 2:
            return ""
        return n[2] if len(n) >= 3 else netnames.get(n[1], n[1])

    def layers_of(node):
        ls = first(node, "layers")
        names = ls[1:] if ls else ([first(node, "layer")[1]] if first(node, "layer") else [])
        if any(x in ("*.Cu", "F&B.Cu") for x in names):
            return list(range(len(b.layers)))
        return [li[x] for x in names if x in li]

    # 板框
    edges = []
    for kind in ("gr_line", "gr_rect", "gr_arc", "gr_poly", "gr_circle"):
        for g in find(root, kind):
            L = first(g, "layer")
            if not L or L[1] != "Edge.Cuts":
                continue
            if kind == "gr_line":
                s, e = first(g, "start"), first(g, "end")
                edges.append([(num(s[1]), num(s[2])), (num(e[1]), num(e[2]))])
            elif kind == "gr_rect":
                s, e = first(g, "start"), first(g, "end")
                x0, y0, x1, y1 = num(s[1]), num(s[2]), num(e[1]), num(e[2])
                edges.append([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)])
            elif kind == "gr_arc":
                s, m, e = first(g, "start"), first(g, "mid"), first(g, "end")
                if m:
                    edges.append(arc3((num(s[1]), num(s[2])), (num(m[1]), num(m[2])), (num(e[1]), num(e[2]))))
            elif kind == "gr_poly":
                pts = [(num(p[1]), num(p[2])) for p in find(first(g, "pts"), "xy")]
                edges.append(pts + pts[:1])
            elif kind == "gr_circle":
                c, e = first(g, "center"), first(g, "end")
                r = math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2]))
                edges.append([(num(c[1]) + r * math.cos(t * math.pi / 32), num(c[2]) + r * math.sin(t * math.pi / 32)) for t in range(65)])
    b.outline = chain_edges(edges)

    for fp in find(root, "footprint") + find(root, "module"):
        at = first(fp, "at")
        fx, fy = num(at[1]), num(at[2])
        frot = num(at[3]) if len(at) > 3 else 0.0
        side = "bottom" if (first(fp, "layer") or ["", "F.Cu"])[1] == "B.Cu" else "top"
        ref = ""
        for pr in find(fp, "property"):
            if len(pr) > 2 and pr[1] == "Reference":
                ref = pr[2]
        for t in find(fp, "fp_text"):
            if len(t) > 2 and t[1] == "reference":
                ref = t[2]
        b.parts[ref] = {"x": fx, "y": fy, "side": side}
        for pd in find(fp, "pad"):
            pat, size = first(pd, "at"), first(pd, "size")
            if not pat or not size:
                continue
            dx, dy = num(pat[1]), num(pat[2])
            prot = num(pat[3]) if len(pat) > 3 else frot
            ox, oy = kicad_rot(dx, dy, frot)
            ls = layers_of(pd)
            if not ls:
                continue
            layer = -1 if len(ls) == len(b.layers) and len(ls) > 1 else ls[0]
            b.pads.append({"ref": ref, "pin": pd[1], "layer": layer, "x": fx + ox, "y": fy + oy, "shape": pd[3] if len(pd) > 3 else "rect",
                           "w": num(size[1]), "h": num(size[2]), "rot": prot, "net": netof(pd)})
    for s in find(root, "segment"):
        st, en, w, L = first(s, "start"), first(s, "end"), first(s, "width"), first(s, "layer")
        if L and L[1] in li:
            b.segs.append((li[L[1]], num(st[1]), num(st[2]), num(en[1]), num(en[2]), num(w[1]), netof(s)))
    for a in find(root, "arc"):
        st, md, en, w, L = first(a, "start"), first(a, "mid"), first(a, "end"), first(a, "width"), first(a, "layer")
        if L and L[1] in li and md:
            pts = arc3((num(st[1]), num(st[2])), (num(md[1]), num(md[2])), (num(en[1]), num(en[2])))
            for p, q in zip(pts, pts[1:]):
                b.segs.append((li[L[1]], p[0], p[1], q[0], q[1], num(w[1]), netof(a)))
    for v in find(root, "via"):
        at, size = first(v, "at"), first(v, "size")
        b.vias.append((num(at[1]), num(at[2]), num(size[1]), netof(v)))
    for z in find(root, "zone"):
        name = (first(z, "net_name") or ["", ""])[1] if first(z, "net_name") else netof(z)
        for fpoly in find(z, "filled_polygon"):
            L = first(fpoly, "layer")
            pts = [(num(p[1]), num(p[2])) for p in find(first(fpoly, "pts"), "xy")]
            if L and L[1] in li and len(pts) >= 3:
                b.zones.append((li[L[1]], name, pts))
    if not any(True for _ in b.zones) and find(root, "zone"):
        print("提示：铺铜没有填充数据（filled_polygon），请先在 KiCad 里按 B 填充所有铺铜再保存", file=sys.stderr)
    return b


def arc3(a, m, c, n=12):
    """过三点的圆弧折线。"""
    ax, ay = a; bx, by = m; cx, cy = c
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        return [a, c]
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    r = math.hypot(ax - ux, ay - uy)
    t0, t1, tm = math.atan2(ay - uy, ax - ux), math.atan2(cy - uy, cx - ux), math.atan2(by - uy, bx - ux)
    def norm(t):
        return (t - t0) % (2 * math.pi)
    sweep = norm(t1)
    if norm(tm) > sweep:
        sweep -= 2 * math.pi
    return [(ux + r * math.cos(t0 + sweep * k / n), uy + r * math.sin(t0 + sweep * k / n)) for k in range(n + 1)]


def chain_edges(edges, tol=0.01):
    """把板框的线段串成一个闭合多边形（取最长的一个环）。"""
    edges = [list(e) for e in edges if len(e) >= 2]
    if not edges:
        return []
    rings = []
    while edges:
        ring = edges.pop(0)
        changed = True
        while changed and edges:
            changed = False
            for k, e in enumerate(edges):
                if math.dist(ring[-1], e[0]) < tol:
                    ring += e[1:]; edges.pop(k); changed = True; break
                if math.dist(ring[-1], e[-1]) < tol:
                    ring += e[::-1][1:]; edges.pop(k); changed = True; break
        rings.append(ring)
    ring = max(rings, key=lambda r: poly_area(r))
    return ring[:-1] if math.dist(ring[0], ring[-1]) < tol else ring


def poly_area(pts):
    s = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


# ---------------------------------------------------------------- Gerber + IPC-D-356
def parse_gerber(path, layer, b):
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    dec, scale = 6, 1.0
    aps, cur_ap = {}, None
    x = y = 0.0
    dark = True
    region = None
    for m in re.finditer(r"%([^%]*)%|([^%*]+)\*", text):
        ext, cmd = m.group(1), m.group(2)
        if ext is not None:
            for part in ext.split("*"):
                part = part.strip()
                if part.startswith("FS"):
                    f = re.search(r"X(\d)(\d)", part)
                    if f:
                        dec = int(f.group(2))
                elif part.startswith("MO"):
                    scale = 25.4 if "IN" in part else 1.0
                elif part.startswith("AD"):
                    a = re.match(r"ADD(\d+)([A-Za-z_][\w.$]*),?([\d.X]*)", part)
                    if a:
                        ps = [float(v) for v in a.group(3).split("X") if v] or [0.1]
                        shape = a.group(2)
                        if shape == "C":
                            aps[a.group(1)] = ("circle", ps[0], ps[0])
                        elif shape in ("R", "O"):
                            aps[a.group(1)] = ("rect" if shape == "R" else "oval", ps[0], ps[1] if len(ps) > 1 else ps[0])
                        else:
                            aps[a.group(1)] = ("circle", ps[0] if ps else 0.1, ps[0] if ps else 0.1)
                elif part.startswith("LP"):
                    dark = part[2:3] != "C"
            continue
        cmd = cmd.strip()
        if not cmd:
            continue
        if cmd.startswith("G36"):
            region = []; continue
        if cmd.startswith("G37"):
            if region and len(region) >= 3:
                b.regions.append((layer, [(px * scale, py * scale) for px, py in region], dark))
            region = None; continue
        d = re.match(r"(?:G0?[123])?\s*D(\d+)$", cmd)
        if d and int(d.group(1)) >= 10:
            cur_ap = d.group(1); continue
        mm = re.match(r"(?:G0?[123])?(?:X([+-]?\d+))?(?:Y([+-]?\d+))?(?:I[+-]?\d+)?(?:J[+-]?\d+)?D0?([123])$", cmd)
        if not mm:
            continue
        nx = int(mm.group(1)) / 10 ** dec if mm.group(1) is not None else x
        ny = int(mm.group(2)) / 10 ** dec if mm.group(2) is not None else y
        op = mm.group(3)
        if region is not None:
            if op == "2":
                if len(region) >= 3:
                    b.regions.append((layer, [(px * scale, py * scale) for px, py in region], dark))
                region = [(nx, ny)]
            elif op == "1":
                if not region:
                    region = [(x, y)]
                region.append((nx, ny))
        elif op == "1" and cur_ap in aps:
            b.draws.append((layer, x * scale, y * scale, nx * scale, ny * scale, aps[cur_ap][1] * scale, dark))
        elif op == "3" and cur_ap in aps:
            sh, w, h = aps[cur_ap]
            b.flashes.append((layer, nx * scale, ny * scale, sh, w * scale, h * scale, dark))
        x, y = nx, ny


def parse_ipc356(path, nlayers):
    """返回 [(net, ref, pin, layer(-1 全层), x, y, is_via)]。"""
    out, unit = [], 1e-4 * 25.4       # 默认英制 0.0001 in
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("P") and "UNITS" in line:
            if "CUST 1" in line or " SI" in line:
                unit = 1e-3
            elif "CUST 2" in line:
                unit = 1e-4 * 25.4
            continue
        if not line[:3] in ("317", "327", "017", "027"):
            continue
        net = line[3:17].strip()
        if net.startswith("N/C") or not net:
            continue
        ref, pin = line[20:26].strip(), line[27:31].strip()
        xy = re.search(r"X([+-]\d+)Y([+-]\d+)", line)
        acc = re.search(r"A(\d\d)", line[30:])
        if not xy:
            continue
        a = int(acc.group(1)) if acc else 0
        if a == 0 or line[:3] in ("317", "017"):
            layer = -1
        elif a == 1:
            layer = 0
        elif a == 2 or a >= nlayers:          # KiCad 用 A02 表示底层；其他工具用最大层号
            layer = nlayers - 1
        else:
            layer = a - 1
        out.append((net, ref, pin, layer, int(xy.group(1)) * unit, int(xy.group(2)) * unit, ref.upper().startswith("VIA")))
    return out


def gerber_outline(path):
    tmp = Board()
    parse_gerber(path, 0, tmp)
    edges = [[(d[1], d[2]), (d[3], d[4])] for d in tmp.draws]
    for _, pts, _ in tmp.regions:
        edges.append(pts + pts[:1])
    return chain_edges(edges, tol=0.02)


# ---------------------------------------------------------------- 栅格化与统计
CLASS_HINTS = [
    (r"^(A|D|P|S)?GND|^VSS", "ground"),
    (r"^(SW|LX)\d*$|_SW$|_LX$", "switch_node"),
    (r"RF|ANT", "rf"),
    (r"ADC|AIN|SENS|ANA|VREF|MIC|ECG|EEG|PPG|TX_P|RX_IN", "analog"),
    (r"CLK|XTAL|XIN|XOUT|OSC|MCLK|BCLK", "clock"),
    (r"^\+|VCC|VDD|VBAT|VBUS|VIN|VOUT|VSYS|PWR|\dV\d|\d+V$|^HV|VPP|VNN", "power"),
]


def classify(name, project_classes):
    if name in project_classes:
        c = project_classes[name]
        if re.match(CLASS_HINTS[0][0], name, re.I):
            return "ground"
        return c
    for pat, cls in CLASS_HINTS:
        if re.search(pat, name, re.I):
            return cls
    return "misc"


def group_of(cls):
    if cls in ("ground", "power", "switch_node"):
        return "power"
    if cls in ("rf", "analog"):
        return cls
    return "digital"


def rle(a):
    """uint8 数组 → [计数低位, 计数高位, 值] 三字节一组，再 base64。"""
    flat = np.asarray(a, dtype=np.uint8).ravel()
    out = bytearray()
    i, n = 0, len(flat)
    while i < n:
        v = flat[i]
        j = i + 1
        while j < n and flat[j] == v and j - i < 65535:
            j += 1
        c = j - i
        out += bytes((c & 255, c >> 8, int(v)))
        i = j
    return base64.b64encode(bytes(out)).decode("ascii")


class Raster:
    def __init__(self, w, h, res):
        self.res, self.w, self.h = res, w, h
        self.nx, self.ny = int(math.ceil(w / res)) + 1, int(math.ceil(h / res)) + 1

    def px(self, x, y):
        return (x / self.res, (self.h - y) / self.res)

    def image(self, mode="I"):
        img = Image.new(mode, (self.nx, self.ny), 0)
        return img, ImageDraw.Draw(img)

    def line(self, dr, x1, y1, x2, y2, w, val):
        r = max(0.5, w / 2 / self.res)
        a, b = self.px(x1, y1), self.px(x2, y2)
        dr.line([a, b], fill=val, width=max(1, int(round(w / self.res))))
        for p in (a, b):
            dr.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=val)

    def pad(self, dr, x, y, shape, w, h, rot, val, ydown):
        if shape in ("circle",) or (shape == "oval" and abs(w - h) < 1e-6):
            r = w / 2 / self.res
            p = self.px(x, y)
            dr.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=val)
            return
        a = math.radians(rot if not ydown else -rot)
        pts = []
        if shape == "oval":
            rr = min(w, h) / 2
            L = (max(w, h) - min(w, h)) / 2
            horiz = w >= h
            for k in range(25):
                t = math.pi * 2 * k / 24
                cx = (L if math.cos(t) >= 0 else -L)
                px_, py_ = cx + rr * math.cos(t), rr * math.sin(t)
                pts.append((px_, py_) if horiz else (py_, px_))
        else:
            pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
        poly = [self.px(x + u * math.cos(a) - v * math.sin(a), y + u * math.sin(a) + v * math.cos(a)) for u, v in pts]
        dr.polygon(poly, fill=val)

    def poly(self, dr, pts, val):
        dr.polygon([self.px(x, y) for x, y in pts], fill=val)


def build_pack(b, project=None, res=0.05, cells=200):
    if not b.outline:
        raise SystemExit("找不到板框（KiCad 的 Edge.Cuts 层，或 --outline 文件）")
    xs, ys = [p[0] for p in b.outline], [p[1] for p in b.outline]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    W, H = x1 - x0, y1 - y0
    if b.ydown:
        T = lambda x, y: (x - x0, y1 - y)
    else:
        T = lambda x, y: (x - x0, y - y0)
    outline = [T(x, y) for x, y in b.outline]
    R = Raster(W, H, res)
    nL = len(b.layers)
    pclass = {}
    if project:
        for n in project.get("nets", []):
            pclass[n["name"]] = n.get("class", "misc")

    # ---------- 每层的网络编号位图 ----------
    labels = []
    if b.source == "kicad":
        for l in range(nL):
            img, dr = R.image("I")
            for zl, net, pts in b.zones:
                if zl == l:
                    R.poly(dr, [T(*p) for p in pts], b.net_id(net))
            for s in b.segs:
                if s[0] == l:
                    xa, ya = T(s[1], s[2]); xb, yb = T(s[3], s[4])
                    R.line(dr, xa, ya, xb, yb, s[5], b.net_id(s[6]))
            for pd in b.pads:
                if pd["layer"] in (-1, l):
                    x, y = T(pd["x"], pd["y"])
                    R.pad(dr, x, y, pd["shape"], pd["w"], pd["h"], pd["rot"], b.net_id(pd["net"]), True)
            for vx, vy, vd, net in b.vias:
                x, y = T(vx, vy)
                R.pad(dr, x, y, "circle", vd, vd, 0, b.net_id(net), True)
            labels.append(np.array(img, dtype=np.int32))
    else:
        recs = b.ipc
        for l in range(nL):
            img, dr = R.image("L")
            items = [("r", r) for r in b.regions if r[0] == l] + [("f", f) for f in b.flashes if f[0] == l] + [("d", d) for d in b.draws if d[0] == l]
            for kind, it in items:
                val = 255 if it[-1] else 0
                if kind == "r":
                    R.poly(dr, [T(*p) for p in it[1]], val)
                elif kind == "f":
                    x, y = T(it[1], it[2])
                    R.pad(dr, x, y, it[3], it[4], it[5], 0, val, False)
                else:
                    xa, ya = T(it[1], it[2]); xb, yb = T(it[3], it[4])
                    R.line(dr, xa, ya, xb, yb, it[5], val)
            cu = np.array(img) > 127
            comp, n = ndimage.label(cu, structure=np.ones((3, 3)))
            lab = np.zeros_like(comp)
            for net, ref, pin, layer, x, y, is_via in recs:
                if layer not in (-1, l):
                    continue
                px, py = R.px(*T(x, y))
                i, j = int(round(px)), int(round(py))
                if 0 <= j < comp.shape[0] and 0 <= i < comp.shape[1] and comp[j, i]:
                    lab[comp == comp[j, i]] = b.net_id(net)
            labels.append(lab.astype(np.int32))
        # 由画线生成导线（带网络），由 IPC 记录生成焊盘和过孔
        for l, xa, ya, xb, yb, w, dark in b.draws:
            if not dark:
                continue
            mx, my = T((xa + xb) / 2, (ya + yb) / 2)
            px, py = R.px(mx, my)
            i, j = int(round(px)), int(round(py))
            lab = labels[l]
            nid = lab[j, i] if 0 <= j < lab.shape[0] and 0 <= i < lab.shape[1] else 0
            name = next((k for k, v in b.nets.items() if v == nid), "")
            b.segs.append((l, xa, ya, xb, yb, w, name))
        for net, ref, pin, layer, x, y, is_via in recs:
            if is_via:
                b.vias.append((x, y, 0.5, net))
            else:
                b.pads.append({"ref": ref, "pin": pin, "layer": layer, "x": x, "y": y, "shape": "rect", "w": 0.5, "h": 0.5, "rot": 0, "net": net})

    # ---------- 求解网格 ----------
    k = max(1, int(math.ceil(max(W, H) / cells / res)))
    cell = k * res
    gnx, gny = int(math.ceil(R.nx / k)), int(math.ceil(R.ny / k))

    def block_mean(mask):
        """位图（行 0 在顶部 y=H）→ 求解网格覆盖率（行 0 在底部 y=0）。"""
        flip = mask[::-1].astype(np.float32)
        pad = np.zeros((gny * k, gnx * k), dtype=np.float32)
        h_, w_ = min(flip.shape[0], gny * k), min(flip.shape[1], gnx * k)
        pad[:h_, :w_] = flip[:h_, :w_]
        return pad.reshape(gny, k, gnx, k).mean(axis=(1, 3))

    id2name = {v: n for n, v in b.nets.items()}
    classes = {n: classify(n, pclass) for n in b.nets}
    groups = {n: group_of(c) for n, c in classes.items()}

    nets_out = []
    seg_by_net, via_by_net, pad_by_net = {}, {}, {}
    for s in b.segs:
        xa, ya = T(s[1], s[2]); xb, yb = T(s[3], s[4])
        seg_by_net.setdefault(s[6], []).append([s[0], round(xa, 3), round(ya, 3), round(xb, 3), round(yb, 3), round(s[5], 3)])
    for vx, vy, vd, net in b.vias:
        x, y = T(vx, vy)
        via_by_net.setdefault(net, []).append([round(x, 3), round(y, 3), round(vd, 3)])
    for pd in b.pads:
        x, y = T(pd["x"], pd["y"])
        pad_by_net.setdefault(pd["net"], []).append([pd["ref"], pd["pin"], pd["layer"], round(x, 3), round(y, 3)])

    for name, nid in sorted(b.nets.items(), key=lambda t: t[1]):
        segs = seg_by_net.get(name, [])
        o = {"name": name, "class": classes[name], "group": groups[name], "segs": segs, "vias": via_by_net.get(name, []), "pads": pad_by_net.get(name, [])}
        if segs:
            w = min(s[5] for s in segs)
            s0 = min(segs, key=lambda s: s[5])
            o["min_w"] = w
            o["min_w_at"] = [round((s0[1] + s0[3]) / 2, 3), round((s0[2] + s0[4]) / 2, 3)]
        if groups[name] == "power":
            o["cov"] = {}
            for l in range(nL):
                m = labels[l] == nid
                if m.any():
                    o["cov"][str(l)] = rle(np.round(block_mean(m) * 255))
        nets_out.append(o)

    cov = {}
    for grp in ("power", "analog", "digital", "rf"):
        ids = [nid for n, nid in b.nets.items() if groups[n] == grp]
        if not ids:
            continue
        cov[grp] = {}
        for l in range(nL):
            m = np.isin(labels[l], ids)
            if m.any():
                cov[grp][str(l)] = rle(np.round(block_mean(m) * 255))

    # ---------- 器件 ----------
    parts = []
    refs = {}
    for pd in b.pads:
        if pd["ref"]:
            x, y = T(pd["x"], pd["y"])
            r = refs.setdefault(pd["ref"], [x, y, x, y, set()])
            r[0], r[1], r[2], r[3] = min(r[0], x - pd["w"] / 2), min(r[1], y - pd["h"] / 2), max(r[2], x + pd["w"] / 2), max(r[3], y + pd["h"] / 2)
            r[4].add(pd["layer"])
    for ref, (a, c, d, e, ls) in refs.items():
        side = b.parts.get(ref, {}).get("side") or ("bottom" if ls == {nL - 1} else "top")
        parts.append({"ref": ref, "x": round((a + d) / 2, 3), "y": round((c + e) / 2, 3), "rect": [round(a, 3), round(c, 3), round(d, 3), round(e, 3)], "side": side})

    # ---------- 离线检查 ----------
    gnd_ids = [nid for n, nid in b.nets.items() if classes[n] == "ground"]
    gnd_vias = [(x, y) for n in b.nets if classes[n] == "ground" for x, y, _ in via_by_net.get(n, [])]
    checks = {"rf": [], "coupling": [], "islands": [], "detours": []}

    def at(l, x, y):
        px, py = R.px(x, y)
        i, j = int(round(px)), int(round(py))
        lab = labels[l]
        return lab[j, i] if 0 <= j < lab.shape[0] and 0 <= i < lab.shape[1] else 0

    for name in b.nets:
        if classes[name] != "rf":
            continue
        samples = []
        for l, xa, ya, xb, yb, w in seg_by_net.get(name, []):
            L = math.hypot(xb - xa, yb - ya)
            for t in np.linspace(0, 1, max(2, int(L / 0.25) + 1)):
                samples.append((l, xa + (xb - xa) * t, ya + (yb - ya) * t))
        if not samples:
            continue
        ok, gaps = 0, []
        for l, x, y in samples:
            adj = [q for q in (l - 1, l + 1) if 0 <= q < nL]
            if any(at(q, x, y) in gnd_ids for q in adj):
                ok += 1
            else:
                gaps.append((x, y))
        fence = None
        if gnd_vias:
            dmax = max(min(math.hypot(x - vx, y - vy) for vx, vy in gnd_vias) for _, x, y in samples)
            fence = round(2 * dmax, 2)
        gl = []
        for g in gaps:
            if all(math.dist(g, q) > 1.5 for q in gl):
                gl.append(g)
        checks["rf"].append({"net": name, "ref_ok": round(ok / len(samples), 3), "gaps": [[round(x, 2), round(y, 2)] for x, y in gl[:5]], "fence_mm": fence})

    ana = [n for n in b.nets if classes[n] == "analog"]
    dig = [n for n in b.nets if groups[n] == "digital"]
    pairs = {}
    for a in ana:
        for d in dig:
            for sa in seg_by_net.get(a, []):
                for sd in seg_by_net.get(d, []):
                    if sa[0] != sd[0]:
                        continue
                    ov, gap = parallel(sa, sd)
                    if ov > 0.2 and gap < 1.0:
                        key = (a, d, sa[0])
                        p = pairs.setdefault(key, [0.0, 99.0, None, 0.0])
                        p[0] += ov; p[1] = min(p[1], gap)
                        if ov > p[3]:
                            p[2], p[3] = [round((sa[1] + sa[3]) / 2, 2), round((sa[2] + sa[4]) / 2, 2)], ov
    for (a, d, l), (L, g, at_, _) in pairs.items():
        checks["coupling"].append({"a": a, "b": d, "layer": l, "len": round(L, 2), "gap": round(max(g, 0.01), 3), "ratio": round(L / max(g, 0.01), 1), "at": at_})
    checks["coupling"].sort(key=lambda c: -c["ratio"])
    checks["coupling"] = checks["coupling"][:10]

    # 地铜孤岛：各层地铜连通域经过孔连成一个图，不属于最大连通组的就是孤岛
    if gnd_ids:
        comps, parent = [], {}
        def findp(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]; a = parent[a]
            return a
        lab_layers = []
        for l in range(nL):
            m = np.isin(labels[l], gnd_ids)
            c, n = ndimage.label(m, structure=np.ones((3, 3)))
            lab_layers.append(c)
            areas = ndimage.sum(m, c, index=range(1, n + 1)) if n else []
            cms = ndimage.center_of_mass(m, c, index=range(1, n + 1)) if n else []
            for q in range(n):
                key = (l, q + 1)
                parent[key] = key
                comps.append((key, float(areas[q]) * res * res, cms[q]))
        for vx, vy in gnd_vias + [(p_[3], p_[4]) for n in b.nets if classes[n] == "ground" for p_ in pad_by_net.get(n, []) if p_[2] == -1]:
            px, py = R.px(vx, vy)
            i, j = int(round(px)), int(round(py))
            ks = [(l, int(lab_layers[l][j, i])) for l in range(nL) if 0 <= j < lab_layers[l].shape[0] and 0 <= i < lab_layers[l].shape[1] and lab_layers[l][j, i]]
            for a_, b_ in zip(ks, ks[1:]):
                parent[findp(a_)] = findp(b_)
        tot = {}
        for key, area, _ in comps:
            r = findp(key); tot[r] = tot.get(r, 0) + area
        if tot:
            main = max(tot, key=tot.get)
            for key, area, cm in comps:
                if findp(key) != main and area > 1.0:
                    y_ = H - cm[0] * res
                    checks["islands"].append({"layer": key[0], "x": round(cm[1] * res, 2), "y": round(y_, 2), "area": round(area, 1)})

    zone_nets = {z[1] for z in b.zones}
    if b.source != "kicad":                                 # Gerber：用覆盖率判断哪些网络有大块铜皮
        zone_nets = {n["name"] for n in nets_out if n.get("cov") and classes[n["name"]] in ("ground", "power")}
    checks["detours"] = detour_checks({n: (seg_by_net.get(n, []), pad_by_net.get(n, [])) for n in b.nets},
                                      skip=zone_nets | {n for n in b.nets if classes[n] == "ground"})

    return {
        "kind": "copper-pack", "version": VERSION, "source": b.source, "units": "mm", "res": res,
        "board": {"w": round(W, 3), "h": round(H, 3), "outline": [[round(x, 3), round(y, 3)] for x, y in outline]},
        "layers": b.layers,
        "grid": {"cell": cell, "nx": gnx, "ny": gny, "x0": 0, "y0": 0},
        "nets": nets_out, "cov": cov, "parts": parts, "checks": checks,
    }


def mst_length(pts):
    """平面点集的最小生成树长度（Prim，点数少，直接 O(n²)）。"""
    pts = list(dict.fromkeys((round(x, 2), round(y, 2)) for x, y in pts))
    if len(pts) < 2:
        return 0.0
    inside, total = {0}, 0.0
    dist = [math.dist(pts[0], q) for q in pts]
    while len(inside) < len(pts):
        k = min((i for i in range(len(pts)) if i not in inside), key=lambda i: dist[i])
        total += dist[k]
        inside.add(k)
        for i in range(len(pts)):
            if i not in inside:
                dist[i] = min(dist[i], math.dist(pts[k], pts[i]))
    return total


def detour_checks(nets, skip=(), ratio=1.3, slack=2.0, top=10):
    """走线总长与焊盘最小生成树长度之比。nets: {名: (segs, pads)}；segs 为 [l, x1, y1, x2, y2, w]，pads 为 [ref, pin, l, x, y]。
    靠铺铜连接的网络（skip）不查；走线总长不到直线下限一半的视为主要靠铜皮连接，也不查。
    阈值来自 CADET 的连接搜索：一步新增线长超过"向目标推进量 × 1.3 + 1 mm"就算绕行；这里按整网放宽为 ×1.3 + 2 mm。"""
    out = []
    for name, (segs, pads) in nets.items():
        if name in skip or len(pads) < 2 or not segs:
            continue
        direct = mst_length([(q[3], q[4]) for q in pads])
        routed = sum(math.hypot(s_[3] - s_[1], s_[4] - s_[2]) for s_ in segs)
        if direct < 1.0 or routed < 0.5 * direct:
            continue
        if routed > ratio * direct + slack:
            s0 = max(segs, key=lambda s_: math.hypot(s_[3] - s_[1], s_[4] - s_[2]))
            out.append({"net": name, "routed": round(routed, 2), "direct": round(direct, 2), "ratio": round(routed / direct, 2),
                        "at": [round((s0[1] + s0[3]) / 2, 2), round((s0[2] + s0[4]) / 2, 2)]})
    out.sort(key=lambda d: -(d["routed"] - d["direct"]))
    return out[:top]


def parallel(a, b):
    """两段导线的平行重叠长度与边到边间距（夹角大于 15° 时不算）。"""
    _, ax1, ay1, ax2, ay2, aw = a
    _, bx1, by1, bx2, by2, bw = b
    ua = (ax2 - ax1, ay2 - ay1); La = math.hypot(*ua)
    ub = (bx2 - bx1, by2 - by1); Lb = math.hypot(*ub)
    if La < 1e-6 or Lb < 1e-6:
        return 0.0, 99.0
    ua = (ua[0] / La, ua[1] / La)
    cosang = abs(ua[0] * ub[0] / Lb + ua[1] * ub[1] / Lb)
    if cosang < math.cos(math.radians(15)):
        return 0.0, 99.0
    t1 = (bx1 - ax1) * ua[0] + (by1 - ay1) * ua[1]
    t2 = (bx2 - ax1) * ua[0] + (by2 - ay1) * ua[1]
    lo, hi = max(0, min(t1, t2)), min(La, max(t1, t2))
    ov = hi - lo
    if ov <= 0:
        return 0.0, 99.0
    mx, my = ax1 + ua[0] * (lo + hi) / 2, ay1 + ua[1] * (lo + hi) / 2
    d = abs((mx - bx1) * ub[1] / Lb - (my - by1) * ub[0] / Lb)
    return ov, d - (aw + bw) / 2


def main(argv=None):
    ap = argparse.ArgumentParser(description="从 PCB 提取铜皮，生成布局布线验证器的铜皮数据包")
    ap.add_argument("kicad", nargs="?", help=".kicad_pcb 文件")
    ap.add_argument("--gerber", nargs="+", help="铜层 Gerber，按叠层顺序（顶层在前）")
    ap.add_argument("--outline", help="板框 Gerber（Edge.Cuts / GKO / GM1）")
    ap.add_argument("--ipc356", help="IPC-D-356 网表")
    ap.add_argument("--project", help="布局规划器导出的布局 JSON，用来取网络类别")
    ap.add_argument("--res", type=float, default=0.05, help="栅格分辨率 mm（默认 0.05）")
    ap.add_argument("--cells", type=int, default=200, help="求解网格长边格数（默认 200）")
    ap.add_argument("-o", "--output", default="copper-pack.json")
    a = ap.parse_args(argv)
    project = json.loads(Path(a.project).read_text(encoding="utf-8")) if a.project else None
    if a.kicad:
        b = parse_kicad(a.kicad)
    elif a.gerber and a.ipc356 and a.outline:
        b = Board()
        b.source = "gerber"
        b.layers = [Path(g).name for g in a.gerber]
        for l, g in enumerate(a.gerber):
            parse_gerber(g, l, b)
        b.outline = gerber_outline(a.outline)
        b.ipc = parse_ipc356(a.ipc356, len(a.gerber))
        for net, *_ in b.ipc:
            b.net_id(net)
    else:
        ap.error("给出 .kicad_pcb，或同时给出 --gerber、--outline 和 --ipc356")
    pack = build_pack(b, project, a.res, a.cells)
    out = Path(a.output)
    out.write_text(json.dumps(pack, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    nn = len(pack["nets"])
    print(f"已写入 {out}（{out.stat().st_size / 1024:.0f} KB）：{len(pack['layers'])} 层，{nn} 个网络，网格 {pack['grid']['nx']}×{pack['grid']['ny']}（{pack['grid']['cell']:.2f} mm）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
