#!/usr/bin/env python3
"""布线几何修复：把任意角度、锐角、抖动、斜出焊盘的走线重建为八方向折线（规则见 references/16-routing-constraints.md）。

  python route_fix.py board.kicad_pcb [-o fixed.kicad_pcb] [--diff diff.json] [--constraints c.json] [--clearance 0.15] [--no-chamfer]
  python route_fix.py plan.json [-o plan-fixed.json] [--diff diff.json]      # 写入嘉立创 EDA 之前的走线计划

做法：以“锚点之间的一段走线”为单位（锚点 = 焊盘、过孔、分支点、线宽变化点），保持锚点不动，
依次尝试直线、两段肘形（先斜后直 / 先直后斜）、三段式（直-斜-直 / 斜-直-斜），焊盘端可先沿焊盘轴直出一小段；
都不合法时在局部窗口里跑带拐弯代价的八方向 A*。每段修复原子提交，提交前检查：
  1. 只有 0/45/90/135° 线段，没有锐角，出焊盘方向正确；
  2. 与其他网络的铜（走线、焊盘、过孔）间距不小于规则，不出板框；
  3. 整个网络的连通关系（哪些焊盘、过孔连在一起）不变；线宽、锚点坐标不变。
任一条不满足就保留原样并标为 needs_manual。修复后请在 EDA 里重新填充铺铜并跑一次 DRC。
"""
import argparse
import heapq
import json
import math
import re
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import route_lint as RL  # noqa: E402

SQ2 = math.sqrt(2)
DIRS = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]


# ------------------------------------------------------------------ 障碍物索引
class Obstacles:
    """其他网络的铜：按层存放，1 mm 网格分桶。"""

    def __init__(self, nets, layers, outline=None, keepouts=(), cell=1.0):
        self.cell = cell
        self.items = []        # (net, kind, layer(-1 全层), geom, radius)
        self.grid = {}
        self.outline = outline or []
        self.keepouts = list(keepouts)
        for n in nets:
            self.add_net(n)

    def _bbox(self, kind, g, r):
        if kind == "seg":
            return min(g[0], g[2]) - r, min(g[1], g[3]) - r, max(g[0], g[2]) + r, max(g[1], g[3]) + r
        if kind == "pad":
            c = RL.pad_corners(g) if g.get("w") else [(g["x"] - 0.3, g["y"] - 0.3), (g["x"] + 0.3, g["y"] + 0.3)]
            xs, ys = [p[0] for p in c], [p[1] for p in c]
            return min(xs), min(ys), max(xs), max(ys)
        return g[0] - r, g[1] - r, g[0] + r, g[1] + r

    def _cells(self, bb, grow=0.0):
        c = self.cell
        for i in range(int(math.floor((bb[0] - grow) / c)), int(math.floor((bb[2] + grow) / c)) + 1):
            for j in range(int(math.floor((bb[1] - grow) / c)), int(math.floor((bb[3] + grow) / c)) + 1):
                yield (i, j)

    def _put(self, it):
        k = len(self.items)
        self.items.append(it)
        for cell in self._cells(self._bbox(it[1], it[3], it[4])):
            self.grid.setdefault(cell, []).append(k)

    def add_net(self, n):
        for s in n["segs"]:
            self._put([n["name"], "seg", s[0], (s[1], s[2], s[3], s[4]), s[5] / 2])
        for p in n["pads"]:
            self._put([n["name"], "pad", p["l"], p, 0.0])
        for v in n["vias"]:
            self._put([n["name"], "via", -1, (v[0], v[1]), v[2] / 2])

    def remove_net(self, name):
        for it in self.items:
            if it and it[0] == name:
                it[0] = None                                   # 软删除

    def margin(self, s4, w, net, layer, clear):
        """线段 s4 = (x1, y1, x2, y2)、线宽 w 与其他网络铜的最小余量（负数表示违规）。"""
        bb = (min(s4[0], s4[2]), min(s4[1], s4[3]), max(s4[0], s4[2]), max(s4[1], s4[3]))
        reach = w / 2 + clear + 2.0
        seen, best = set(), 1e9
        for cell in self._cells(bb, reach):
            for k in self.grid.get(cell, ()):
                if k in seen:
                    continue
                seen.add(k)
                it = self.items[k]
                if it[0] is None or it[0] == net or it[2] not in (-1, layer):
                    continue
                if it[1] == "seg":
                    d = RL.seg_seg(s4, it[3]) - it[4]
                elif it[1] == "pad":
                    d = RL.seg_pad(s4, it[3]) if it[3].get("w") else RL.pt_seg(it[3]["x"], it[3]["y"], *s4) - 0.3
                else:
                    d = RL.pt_seg(it[3][0], it[3][1], *s4) - it[4]
                best = min(best, d - w / 2 - clear)
        if self.outline:
            for (x1, y1), (x2, y2) in zip(self.outline, self.outline[1:] + self.outline[:1]):
                best = min(best, RL.seg_seg(s4, (x1, y1, x2, y2)) - w / 2 - 0.2)
            if not (RL.point_in_poly(s4[0], s4[1], self.outline) and RL.point_in_poly(s4[2], s4[3], self.outline)):
                best = min(best, -1.0)
        for poly in self.keepouts:
            if RL.point_in_poly(s4[0], s4[1], poly) or RL.point_in_poly(s4[2], s4[3], poly) or \
               any(RL.segs_intersect(s4, (a[0], a[1], b[0], b[1])) for a, b in zip(poly, poly[1:] + poly[:1])):
                best = min(best, -1.0)
        return best


# ------------------------------------------------------------------ 连通性
def components(net):
    """网络里各焊盘、过孔的连通分组（按铜皮几何是否接触）。返回 frozenset(frozenset(端点 id))。"""
    segs, pads, vias = net["segs"], net["pads"], net["vias"]
    items = [("s", i) for i in range(len(segs))] + [("p", i) for i in range(len(pads))] + [("v", i) for i in range(len(vias))]
    parent = list(range(len(items)))
    def f(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    def touch(a, b):
        (ka, ia), (kb, ib) = a, b
        if ka > kb:
            (ka, ia), (kb, ib) = (kb, ib), (ka, ia)
        if ka == "p" and kb == "s":
            p, s = pads[ia], segs[ib]
            return p["l"] in (-1, s[0]) and (RL.seg_pad((s[1], s[2], s[3], s[4]), p) if p.get("w") else RL.pt_seg(p["x"], p["y"], s[1], s[2], s[3], s[4]) - 0.25) < s[5] / 2
        if ka == "p" and kb == "v":
            p, v = pads[ia], vias[ib]
            return (RL.seg_pad((v[0], v[1], v[0], v[1]), p) if p.get("w") else math.hypot(p["x"] - v[0], p["y"] - v[1]) - 0.25) < v[2] / 2
        if ka == "s" and kb == "s":
            s, t = segs[ia], segs[ib]
            return s[0] == t[0] and RL.seg_seg((s[1], s[2], s[3], s[4]), (t[1], t[2], t[3], t[4])) < (s[5] + t[5]) / 2 - 1e-6
        if ka == "s" and kb == "v":
            s, v = segs[ia], vias[ib]
            return RL.pt_seg(v[0], v[1], s[1], s[2], s[3], s[4]) < (s[5] + v[2]) / 2
        if ka == "p" and kb == "p":
            p, q = pads[ia], pads[ib]
            return (p["l"] == q["l"] or -1 in (p["l"], q["l"])) and RL.pt_in_pad(q["x"], q["y"], p, 0)
        if ka == "v" and kb == "v":
            u, v = vias[ia], vias[ib]
            return math.hypot(u[0] - v[0], u[1] - v[1]) < (u[2] + v[2]) / 2
        return False
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if touch(items[i], items[j]):
                parent[f(i)] = f(j)
    groups = {}
    for i, it in enumerate(items):
        if it[0] != "s":
            groups.setdefault(f(i), set()).add(it)
    return frozenset(frozenset(g) for g in groups.values())


# ------------------------------------------------------------------ 折线工具
def simplify(pts):
    """去掉零长段，合并共线点（首尾不动）。"""
    out = [pts[0]]
    for p in pts[1:]:
        if math.dist(p, out[-1]) > 1e-7:
            out.append(p)
    i = 1
    while i < len(out) - 1:
        a, b, c = out[i - 1], out[i], out[i + 1]
        u, v = (b[0] - a[0], b[1] - a[1]), (c[0] - b[0], c[1] - b[1])
        if abs(u[0] * v[1] - u[1] * v[0]) < 1e-9 * max(1e-9, math.hypot(*u) * math.hypot(*v)) and u[0] * v[0] + u[1] * v[1] > 0:
            out.pop(i)
        else:
            i += 1
    return out


def octi_paths(P, Q):
    """P→Q 的八方向折线候选：直线、两种肘形、两种三段式。"""
    dx, dy = Q[0] - P[0], Q[1] - P[1]
    if RL.is_octi(dx, dy, 1e-7):
        return [[P, Q]]
    ax, ay = abs(dx), abs(dy)
    sx, sy = math.copysign(1, dx), math.copysign(1, dy)
    d = min(ax, ay); r = max(ax, ay) - d
    diag = (sx * d, sy * d)
    st = (sx * r, 0.0) if ax > ay else (0.0, sy * r)
    add = lambda p, v, k=1.0: (p[0] + k * v[0], p[1] + k * v[1])
    c1 = [P, add(P, diag), Q]
    c2 = [P, add(P, st), Q]
    m1 = add(P, st, 0.5); c3 = [P, m1, add(m1, diag), Q]
    m2 = add(P, diag, 0.5); c4 = [P, m2, add(m2, st), Q]
    return [c1, c2, c3, c4]


def poly_cost(pts, w, minseg):
    c = 0.0
    for a, b in zip(pts, pts[1:]):
        L = math.dist(a, b)
        c += L * (1.1 if abs(abs(b[0] - a[0]) - abs(b[1] - a[1])) < 1e-6 and L > 0 else 1.0)
        if L < minseg:
            c += 2.0
    for a, b, d in zip(pts, pts[1:], pts[2:]):
        turn = 180 - RL.angle_between((a[0] - b[0], a[1] - b[1]), (d[0] - b[0], d[1] - b[1]))
        c += 1.0 if turn < 46 else (3.0 if turn < 91 else 100.0)
    return c


def exit_axes(p):
    """焊盘允许的出线轴：长宽比 ≥ 1.3 只许长轴，否则两条轴都行；圆形或尺寸未知时不限。"""
    if p is None or not p.get("w") or p.get("shape") == "circle":
        return None
    ux, uy = RL.pad_axis(p)
    if max(p["w"], p["h"]) / max(min(p["w"], p["h"]), 1e-6) >= 1.3:
        return [(ux, uy)] if p["w"] >= p["h"] else [(-uy, ux)]
    return [(ux, uy), (-uy, ux)]


def poly_problems(pts, w, padA, padB, othersA, othersB, minseg, fanout):
    """折线自身的几何问题：hard（angle/acute/tee/exit）与 soft（short）。"""
    hard, soft = [], []
    if len(pts) < 2:
        return ["degenerate"], soft
    for i, (a, b) in enumerate(zip(pts, pts[1:])):
        dx, dy = b[0] - a[0], b[1] - a[1]
        if not RL.is_octi(dx, dy):
            pad = padA if i == 0 else (padB if i == len(pts) - 2 else None)
            ax = exit_axes(pad)
            L = math.hypot(dx, dy)
            if not (pad and ax and not RL.is_octi(*ax[0], 1e-6) and any(abs(dx * q[1] - dy * q[0]) / L <= RL.SIN1 for q in ax)):
                hard.append("angle")
        L = math.hypot(dx, dy)
        lim = fanout * w if i in (0, len(pts) - 2) else minseg
        if len(pts) > 2 and L < lim - 1e-9:
            soft.append("short")
    for a, b, c in zip(pts, pts[1:], pts[2:]):
        if RL.angle_between((a[0] - b[0], a[1] - b[1]), (c[0] - b[0], c[1] - b[1])) < 90 - RL.TURN_TOL:
            hard.append("acute")
    for end, pad, others in ((0, padA, othersA), (-1, padB, othersB)):
        a, b = (pts[0], pts[1]) if end == 0 else (pts[-1], pts[-2])
        d = (b[0] - a[0], b[1] - a[1])
        for o in others:
            if RL.angle_between(d, o) < 90 - RL.TURN_TOL:
                hard.append("tee")
        ax = exit_axes(pad)
        if ax:
            seq = pts if end == 0 else pts[::-1]
            for i in range(len(seq) - 1):                   # 起点在焊盘内的每一段都必须沿允许的轴
                if i > 0 and not RL.pt_in_pad(seq[i][0], seq[i][1], pad):
                    break
                dd = (seq[i + 1][0] - seq[i][0], seq[i + 1][1] - seq[i][1])
                L = math.hypot(*dd)
                if L > 1e-9 and not any(abs(dd[0] * q[1] - dd[1] * q[0]) / L <= RL.SIN1 for q in ax):
                    hard.append("exit")
                    break
    return hard, soft


def merge_overlaps(segs):
    """同层同宽、共线且重叠的线段合并成一条（重复画线、折回重叠是烂走线的常见来源）。"""
    segs = [list(x) for x in segs]
    changed = True
    while changed:
        changed = False
        for i in range(len(segs)):
            a = segs[i]
            if a[6]:
                continue
            ux, uy = a[3] - a[1], a[4] - a[2]
            La = math.hypot(ux, uy)
            if La < 1e-9:
                continue
            ux, uy = ux / La, uy / La
            for j in range(i + 1, len(segs)):
                b = segs[j]
                if b[6] or b[0] != a[0] or abs(b[5] - a[5]) > 1e-6:
                    continue
                if any(abs((x - a[1]) * uy - (y - a[2]) * ux) > 1e-5 for x, y in ((b[1], b[2]), (b[3], b[4]))):
                    continue
                pb = sorted([(b[1] - a[1]) * ux + (b[2] - a[2]) * uy, (b[3] - a[1]) * ux + (b[4] - a[2]) * uy])
                if min(La, pb[1]) - max(0.0, pb[0]) <= 1e-6:
                    continue
                lo, hi = min(0.0, pb[0]), max(La, pb[1])
                segs[i] = [a[0], a[1] + lo * ux, a[2] + lo * uy, a[1] + hi * ux, a[2] + hi * uy, a[5], False]
                segs.pop(j)
                changed = True
                break
            if changed:
                break
    return segs


def dangling_chains(g):
    """一端悬空（度为 1、不在焊盘或过孔上）的走线段：天线式残桩，删除后不影响连通。"""
    out = []
    for c in g.chains:
        for key in (c["keys"][0], c["keys"][-1]):
            nd = g.nodes[key]
            if len(nd["e"]) == 1 and nd["pad"] is None and not nd["via"]:
                out.append(c)
                break
    return out


# ------------------------------------------------------------------ 修复器
class Fixer:
    def __init__(self, nets, layers, cons=None, clearance=0.15, outline=None, chamfer=True, log=None, local=False):
        self.local = local                  # 只改 P0（任意角度、锐角、锐角分支、直角），不重布出线方向、短段、抖动，不删线头
        self.nets = nets
        self.layers = layers
        self.cons = RL.merge_cons(cons)
        self.clear = clearance
        self.chamfer = chamfer
        self.obs = Obstacles(nets, layers, outline, [z["poly"] for z in self.cons.get("keepouts", []) if z.get("poly")])
        self.log = log if log is not None else []
        self.manual = []
        geo = self.cons["geometry"]
        self.kw, self.absmin, self.fanout = geo["min_seg"]["k_w"], geo["min_seg"]["abs_mm"], geo.get("fanout_k_w", 0.5)

    def classes(self, n):
        given = (self.cons.get("nets") or {}).get(n["name"], {}).get("class")
        return given or RL.infer_class(n["name"], n["pads"])[0]

    def clear_for(self, cls):
        return (self.cons.get("netclasses") or {}).get(cls, {}).get("clearance", self.clear)

    # ---- 候选与校验
    def stub_options(self, A, pad, target, w):
        """焊盘端：不加短直段，或沿允许的轴先直出到焊盘边外 max(0.2, w)。"""
        opts = [None]
        ax = exit_axes(pad)
        if ax:
            for q in ax:
                for s in (1, -1):
                    e = (q[0] * s, q[1] * s)
                    if (target[0] - A[0]) * e[0] + (target[1] - A[1]) * e[1] < -1e-9:
                        continue
                    t = RL.pad_exit_dist(A[0], A[1], e, pad) + max(0.2, w)
                    opts.append((A[0] + e[0] * t, A[1] + e[1] * t))
        return opts

    def valid(self, pts, w, net, layer, clear, padA, padB, oA, oB):
        hard, soft = poly_problems(pts, w, padA, padB, oA, oB, max(self.kw * w, self.absmin), self.fanout)
        if hard:
            return False, soft
        for a, b in zip(pts, pts[1:]):
            if self.obs.margin((a[0], a[1], b[0], b[1]), w, net, layer, clear) < -1e-6:
                return False, soft
        return True, soft

    def route_chain(self, A, B, w, net, layer, clear, padA, padB, oA, oB, minseg):
        if math.dist(A, B) < 1e-6:                          # 首尾相接的环：不自动处理
            return None, None
        cands = []
        for sa in self.stub_options(A, padA, B, w):
            for sb in self.stub_options(B, padB, A, w):
                P = sa or A; Q = sb or B
                for mid in octi_paths(P, Q):
                    pts = simplify(([A] if sa else []) + mid + ([B] if sb else []))
                    cands.append((poly_cost(pts, w, minseg), pts))
        cands.sort(key=lambda t: t[0])
        soft_ok = None
        for c, pts in cands:
            ok, soft = self.valid(pts, w, net, layer, clear, padA, padB, oA, oB)
            if ok and not soft:
                return pts, "elbow"
            if ok and soft_ok is None:
                soft_ok = pts
        pts = self.astar(A, B, w, net, layer, clear, padA, padB, oA, oB, minseg)
        if pts:
            return pts, "astar"
        return (soft_ok, "elbow") if soft_ok else (None, None)

    def astar(self, A, B, w, net, layer, clear, padA, padB, oA, oB, minseg, margin=2.0, max_nodes=60000):
        best = None
        for sa in self.stub_options(A, padA, B, w):
            S = sa or A
            for sb in self.stub_options(B, padB, A, w):
                T = sb or B
                r = self._astar(S, T, w, net, layer, clear, margin, max_nodes)
                if not r:
                    continue
                pts = simplify(([A] if sa else []) + r + ([B] if sb else []))
                ok, soft = self.valid(pts, w, net, layer, clear, padA, padB, oA, oB)
                if ok:
                    c = poly_cost(pts, w, minseg)
                    if best is None or c < best[0]:
                        best = (c, pts)
            if best:
                break
        return best[1] if best else None

    def raster(self, S, p, x0, y0, x1, y1, w, net, layer, clear):
        """把窗口内其他网络的铜按 (w/2 + 间距) 膨胀后栅格化，返回 free(i, j)。网格原点在 S。"""
        import numpy as np
        from PIL import Image, ImageDraw
        i0, i1 = int(math.floor((x0 - S[0]) / p)), int(math.ceil((x1 - S[0]) / p))
        j0, j1 = int(math.floor((y0 - S[1]) / p)), int(math.ceil((y1 - S[1]) / p))
        W, H = i1 - i0 + 1, j1 - j0 + 1
        img = Image.new("1", (W, H), 0)
        dr = ImageDraw.Draw(img)
        g = w / 2 + clear
        px = lambda x, y: ((x - S[0]) / p - i0, (y - S[1]) / p - j0)
        bb = (x0 - 3, y0 - 3, x1 + 3, y1 + 3)
        seen = set()
        for cell in self.obs._cells(bb):
            for k in self.obs.grid.get(cell, ()):
                if k in seen:
                    continue
                seen.add(k)
                it = self.obs.items[k]
                if it[0] is None or it[0] == net or it[2] not in (-1, layer):
                    continue
                if it[1] == "seg":
                    a, b = px(it[3][0], it[3][1]), px(it[3][2], it[3][3])
                    r = (it[4] + g) / p
                    dr.line([a, b], fill=1, width=max(1, int(math.ceil(2 * r)) + 1))
                    for c in (a, b):
                        dr.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=1)
                elif it[1] == "pad":
                    q = it[3]
                    if q.get("w") and q.get("shape") != "circle":
                        dr.polygon([px(*c) for c in RL.pad_corners(q, g)], fill=1)
                    else:
                        c = px(q["x"], q["y"]); r = ((max(q.get("w") or 0.6, q.get("h") or 0.6)) / 2 + g) / p
                        dr.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=1)
                else:
                    c = px(*it[3]); r = (it[4] + g) / p
                    dr.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=1)
        for poly in self.obs.keepouts:
            dr.polygon([px(*c) for c in poly], fill=1)
        blocked = np.array(img, dtype=bool)
        if self.obs.outline:
            inside = Image.new("1", (W, H), 0)
            ImageDraw.Draw(inside).polygon([px(*c) for c in self.obs.outline], fill=1)
            from scipy import ndimage
            ins = ndimage.binary_erosion(np.array(inside, dtype=bool), iterations=max(1, int(math.ceil((w / 2 + 0.2) / p))))
            blocked |= ~ins
        def free(i, j):
            a, b = i - i0, j - j0
            return 0 <= a < W and 0 <= b < H and not blocked[b, a]
        return free

    def _astar(self, S, T, w, net, layer, clear, margin, max_nodes):
        span = max(abs(T[0] - S[0]), abs(T[1] - S[1])) + 2 * margin
        p = max(0.05, span / 300.0)
        x0, x1 = min(S[0], T[0]) - margin, max(S[0], T[0]) + margin
        y0, y1 = min(S[1], T[1]) - margin, max(S[1], T[1]) + margin
        free = self.raster(S, p, x0, y0, x1, y1, w, net, layer, clear)
        def finish(i, j, d):
            x, y = S[0] + i * p, S[1] + j * p
            for tail in octi_paths((x, y), T)[:2]:
                ok = True
                prev = (DIRS[d][0], DIRS[d][1]) if d is not None else None
                for a, b in zip(tail, tail[1:]):
                    v = (b[0] - a[0], b[1] - a[1])
                    if math.hypot(*v) < 1e-9:
                        continue
                    if prev and RL.angle_between((-prev[0], -prev[1]), v) < 90 - RL.TURN_TOL:
                        ok = False; break
                    if self.obs.margin((a[0], a[1], b[0], b[1]), w, net, layer, clear) < -1e-6:
                        ok = False; break
                    prev = v
                if ok:
                    return tail
            return None
        h = lambda i, j: RL.d_oct(T[0] - S[0] - i * p, T[1] - S[1] - j * p)
        start = (0, 0, None)
        g = {start: 0.0}
        came = {}
        pq = [(h(0, 0), 0.0, 0, 0, -1)]
        n = 0
        while pq and n < max_nodes:
            f, gc, i, j, d = heapq.heappop(pq)
            d = None if d < 0 else d
            if gc > g.get((i, j, d), 1e18) + 1e-9:
                continue
            n += 1
            if n % 16 == 1 or h(i, j) < 3 * p:
                tail = finish(i, j, d)
                if tail:
                    pts = [tail[0]]
                    st = (i, j, d)
                    while st in came:
                        st = came[st]
                        pts.append((S[0] + st[0] * p, S[1] + st[1] * p))
                    pts.reverse()
                    return simplify(pts + tail[1:])
            for nd, (dx, dy) in enumerate(DIRS):
                if d is not None:
                    turn = min((nd - d) % 8, (d - nd) % 8)
                    if turn > 2:
                        continue
                    tc = (0, 1.0, 3.0)[turn]
                else:
                    tc = 0.0
                ni, nj = i + dx, j + dy
                if not free(ni, nj):
                    continue
                step = p * (SQ2 * 1.1 if dx and dy else 1.0)
                ng = gc + step + tc
                key = (ni, nj, nd)
                if ng < g.get(key, 1e18) - 1e-9:
                    g[key] = ng; came[key] = (i, j, d)
                    heapq.heappush(pq, (ng + h(ni, nj), ng, ni, nj, nd))
        return None

    # ---- 主流程
    def chain_needs_fix(self, g, c, w):
        pts = c["pts"]
        nA, nB = g.nodes[c["keys"][0]], g.nodes[c["keys"][-1]]
        oA = self.others(g, c, 0); oB = self.others(g, c, -1)
        hard, soft = poly_problems(pts, w, nA["pad"], nB["pad"], oA, oB, max(self.kw * w, self.absmin), self.fanout)
        jog = False
        for i in range(len(pts) - 3):
            u = (pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); v = (pts[i + 3][0] - pts[i + 2][0], pts[i + 3][1] - pts[i + 2][1])
            if RL.angle_between(u, v) < 1.0 and math.hypot(*u) > 1e-6:
                off = RL.pt_seg(pts[i + 2][0], pts[i + 2][1], pts[i][0] - 1e3 * u[0], pts[i][1] - 1e3 * u[1], pts[i][0] + 1e3 * u[0], pts[i][1] + 1e3 * u[1])
                if 1e-4 < off < 2 * w:
                    jog = True
        return hard + soft + (["jog"] if jog else [])

    def others(self, g, c, end):
        """自由锚点（分支点）上其他边的出射方向，用来检查锐角 T 分支。焊盘、过孔上不算。"""
        key = c["keys"][end]
        nd = g.nodes[key]
        if nd["pad"] is not None or nd["via"]:
            return []
        mine = c["edges"][0] if end == 0 else c["edges"][-1]
        return [g.vec(k, key) for k in nd["e"] if k != mine]

    def fix_net(self, n, cls):
        clear = self.clear_for(cls)
        rules = RL.class_rules(cls, self.cons)
        before = components(n)
        new_segs, changed, results = [], False, []
        for l in sorted({s[0] for s in n["segs"]}):
            segs = [s for s in n["segs"] if s[0] == l]
            merged = merge_overlaps(segs)
            if len(merged) != len(segs):
                results.append({"net": n["name"], "layer": l, "issues": ["overlap"], "how": "merge", "segs_before": len(segs), "segs_after": len(merged)})
                segs, changed = merged, True
            g = RL.Graph(segs, n["pads"], n["vias"], l)
            if not n.get("zone") and not self.local:
                for _ in range(5):
                    dead = dangling_chains(g)
                    if not dead:
                        break
                    drop = {k for c in dead for k in c["edges"]}
                    for c in dead:
                        results.append({"net": n["name"], "layer": l, "from": [round(c["pts"][0][0], 3), round(c["pts"][0][1], 3)],
                                        "to": [round(c["pts"][-1][0], 3), round(c["pts"][-1][1], 3)], "issues": ["stub"], "how": "remove",
                                        "segs_before": len(c["edges"]), "segs_after": 0})
                    segs = [[l, e["a"][0], e["a"][1], e["b"][0], e["b"][1], e["w"], e["arc"]] for k, e in enumerate(g.edges) if k not in drop]
                    segs = merge_overlaps(segs)
                    changed = True
                    g = RL.Graph(segs, n["pads"], n["vias"], l)
            replaced = set()
            added = []
            for c in g.chains:
                w = c["w"]
                if c["arc"]:
                    continue
                issues = self.chain_needs_fix(g, c, w)
                if not issues or (self.local and not set(issues) & {"angle", "acute", "tee"}):
                    continue
                A, B = c["pts"][0], c["pts"][-1]
                nA, nB = g.nodes[c["keys"][0]], g.nodes[c["keys"][-1]]
                minseg = max(self.kw * w, self.absmin)
                pts, how = self.route_chain(A, B, w, n["name"], l, clear, nA["pad"], nB["pad"], self.others(g, c, 0), self.others(g, c, -1), minseg)
                if pts is None or [tuple(q) for q in pts] == [tuple(q) for q in simplify(c["pts"])]:
                    if pts is None and not any(m.get("net") == n["name"] and m.get("at") == [round(A[0], 3), round(A[1], 3)] for m in self.manual):
                        self.manual.append({"net": n["name"], "layer": l, "at": [round(A[0], 3), round(A[1], 3)], "issues": sorted(set(issues)), "reason": "没有找到合法的八方向走法（空间不够或被其他网络挡住）"})
                    continue
                replaced.update(c["edges"])
                added += [[l, a[0], a[1], b[0], b[1], w, False] for a, b in zip(pts, pts[1:])]
                results.append({"net": n["name"], "layer": l, "from": [round(A[0], 3), round(A[1], 3)], "to": [round(B[0], 3), round(B[1], 3)],
                                "issues": sorted(set(issues)), "how": how, "segs_before": len(c["edges"]), "segs_after": len(pts) - 1})
            # 未替换的原始线段：整根保留；被切开且部分被替换的，剩下的碎段单独保留
            hit_src = {g.edges[k]["src"] for k in replaced}
            for i, s in enumerate(segs):
                if i not in hit_src:
                    new_segs.append(s)
            for k, e in enumerate(g.edges):
                if e["src"] in hit_src and k not in replaced:
                    new_segs.append([l, e["a"][0], e["a"][1], e["b"][0], e["b"][1], e["w"], e["arc"]])
            new_segs += added
            changed |= bool(replaced)
        if not changed:
            return []
        trial = dict(n, segs=new_segs)
        if self.chamfer:
            trial["segs"] = self.chamfer_net(trial, clear)
        if components(trial) != before:
            self.manual.append({"net": n["name"], "reason": "修复后连通关系会改变，已回滚", "issues": ["connectivity"]})
            return []
        self.obs.remove_net(n["name"])
        n["segs"] = trial["segs"]
        self.obs.add_net(n)
        return results

    def chamfer_net(self, n, clear):
        """把自由节点处的 90° 拐角斜切成两个 135° 拐角（所有网络类，含电源、地线和射频）。
        斜切段长优先 max(2w, 0.2)，两侧线段不够长时依次退到 max(w, 0.15)、0.6w；仍放不下的留给人工。"""
        out = []
        for l in sorted({s[0] for s in n["segs"]}):
            segs = [s for s in n["segs"] if s[0] == l]
            g = RL.Graph(segs, n["pads"], n["vias"], l)
            done_src = set()
            new = []
            for c in g.chains:
                if c["arc"] or len(c["pts"]) < 3:
                    continue
                pts = list(c["pts"]); w = c["w"]
                cuts = [max(2 * w, 0.2) / SQ2, max(w, 0.15) / SQ2, 0.6 * w / SQ2]
                k = 1
                modified = False
                while k < len(pts) - 1:
                    a, b, d = pts[k - 1], pts[k], pts[k + 1]
                    u, v = (a[0] - b[0], a[1] - b[1]), (d[0] - b[0], d[1] - b[1])
                    if abs(RL.angle_between(u, v) - 90) < 0.5:
                        lu, lv = math.hypot(*u), math.hypot(*v)
                        minseg = max(self.kw * w, self.absmin)
                        need_u = need_v = minseg
                        done = False
                        for cut in cuts:
                            if lu < cut + need_u or lv < cut + need_v:
                                continue
                            p1 = (b[0] + u[0] / lu * cut, b[1] + u[1] / lu * cut)
                            p2 = (b[0] + v[0] / lv * cut, b[1] + v[1] / lv * cut)
                            in_pad = any(RL.pt_in_pad(q[0], q[1], pd, w / 2) for q in (p1, p2) for pd in n["pads"] if pd["l"] in (-1, l) and pd.get("w"))
                            if not in_pad and self.obs.margin((p1[0], p1[1], p2[0], p2[1]), w, n["name"], l, clear) >= 0:
                                pts[k:k + 1] = [p1, p2]
                                modified = done = True
                                k += 2
                                break
                        if done:
                            continue
                    k += 1
                if modified:
                    done_src.update(g.edges[e]["src"] for e in c["edges"])
                    new += [[l, a[0], a[1], b[0], b[1], w, False] for a, b in zip(pts, pts[1:])]
                    c["_replaced"] = True
            for i, s in enumerate(segs):
                if i not in done_src:
                    out.append(s)
            for kk, e in enumerate(g.edges):
                if e["src"] in done_src and not any(kk in c["edges"] and c.get("_replaced") for c in g.chains):
                    out.append([l, e["a"][0], e["a"][1], e["b"][0], e["b"][1], e["w"], e["arc"]])
            out += new
        return out

    def run(self, passes=2):
        allres = []
        order = sorted(self.nets, key=lambda n: RL.PRIORITY.index(self.classes(n)) if self.classes(n) in RL.PRIORITY else 99)
        locked = {x.get("net") for x in self.cons.get("locks", []) if x.get("net")}
        for _ in range(passes):
            got = []
            for n in order:
                cls = self.classes(n)
                if cls == "GND" or not n["segs"] or n["name"] in locked:
                    continue
                got += self.fix_net(n, cls)
            allres += got
            if not got:
                break
        if self.chamfer:
            allres += self.chamfer_all(order, locked)
        return allres

    def chamfer_all(self, order, locked):
        """最后一遍：所有网络（含地线、电源、射频）上剩下的 90° 拐角全部斜切；切不了的列为人工处理。"""
        res = []
        for n in order:
            if not n["segs"] or n["name"] in locked:
                continue
            cls = self.classes(n)
            clear = self.clear_for(cls)
            before = components(n)
            segs = self.chamfer_net(n, clear)
            if sorted(map(tuple, segs)) != sorted(map(tuple, n["segs"])):
                if components(dict(n, segs=segs)) != before:
                    continue
                self.obs.remove_net(n["name"])
                n["segs"] = segs
                self.obs.add_net(n)
                res.append({"net": n["name"], "layer": None, "issues": ["right"], "how": "chamfer"})
            for l in sorted({s[0] for s in n["segs"]}):
                g = RL.Graph([s for s in n["segs"] if s[0] == l], n["pads"], n["vias"], l)
                for key, nd in g.nodes.items():
                    if len(nd["e"]) != 2 or nd["pad"] is not None or nd["via"] or nd["arc"]:
                        continue
                    u, v = g.vec(nd["e"][0], key), g.vec(nd["e"][1], key)
                    if abs(RL.angle_between(u, v) - 90) < 0.5:
                        self.manual.append({"net": n["name"], "layer": l, "at": [round(nd["p"][0], 3), round(nd["p"][1], 3)], "issues": ["right"],
                                            "reason": "直角拐角无法自动斜切（两侧线段太短或旁边没有空间），请拆线按 135° 拐角重布或挪开相邻走线"})
        return res


# ------------------------------------------------------------------ KiCad 读写
def top_level_blocks(text, head):
    """找出顶层 (head ...) 块的 (起, 止) 位置。"""
    spans, i = [], 0
    pat = re.compile(r"\(\s*" + re.escape(head) + r"[\s)]")
    while True:
        m = pat.search(text, i)
        if not m:
            break
        s = m.start(); depth = 0; j = s; instr = False
        while j < len(text):
            ch = text[j]
            if instr:
                if ch == "\\":
                    j += 1
                elif ch == '"':
                    instr = False
            elif ch == '"':
                instr = True
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        spans.append((s, j + 1))
        i = j + 1
    return spans


def seg_key(layer, x1, y1, x2, y2, net):
    a, b = (round(x1, 4), round(y1, 4)), (round(x2, 4), round(y2, 4))
    return (layer, net) + tuple(sorted([a, b]))


def write_kicad(src, dst, b, before, after):
    """before / after：{网络名: segs}（源坐标）。只改动发生变化的走线段，其余文本原样保留。"""
    import extract_copper as X
    text = Path(src).read_text(encoding="utf-8")
    old = {}
    for n, segs in before.items():
        for s in segs:
            if not s[6]:
                k = seg_key(b.layers[s[0]], s[1], s[2], s[3], s[4], n)
                old[k] = old.get(k, 0) + 1
    new = {}
    for n, segs in after.items():
        for s in segs:
            if not s[6]:
                k = seg_key(b.layers[s[0]], s[1], s[2], s[3], s[4], n)
                new[k] = new.get(k, 0) + 1
    remove = {k: c - new.get(k, 0) for k, c in old.items() if c > new.get(k, 0)}
    add = [k for k, c in new.items() for _ in range(c - old.get(k, 0))]
    spans = top_level_blocks(text, "segment")
    netnames = {}
    for nd in X.find(X.sexp(text), "net"):
        if len(nd) >= 3:
            netnames[nd[1]] = nd[2]
    net_tok, cut, removed = {}, [], 0
    for s, e in spans:
        blk = text[s:e]
        node = X.sexp(blk)
        st, en, L, nt = X.first(node, "start"), X.first(node, "end"), X.first(node, "layer"), X.first(node, "net")
        if not (st and en and L and nt):
            continue
        name = nt[2] if len(nt) >= 3 else netnames.get(nt[1], nt[1])
        m = re.search(r"\(net\s+[^()]*\)", blk)
        if m:
            net_tok.setdefault(name, m.group(0))
        k = seg_key(L[1], float(st[1]), float(st[2]), float(en[1]), float(en[2]), name)
        if remove.get(k, 0) > 0:
            remove[k] -= 1
            a = s
            while a > 0 and text[a - 1] in " \t":
                a -= 1
            if a > 0 and text[a - 1] == "\n":
                a -= 1
            cut.append((a, e)); removed += 1
    idkey = "uuid" if re.search(r"\(segment[^()]*(\([^()]*\)[^()]*)*\(uuid", text) or "(uuid" in text else "tstamp"
    out, last = [], 0
    for a, e in sorted(cut):
        out.append(text[last:a]); last = e
    out.append(text[last:])
    text2 = "".join(out).rstrip()
    assert text2.endswith(")")
    lines = []
    for (layer, net, p, q) in add:
        tok = net_tok.get(net) or next((f'(net {k})' for k, v in netnames.items() if v == net), f'(net "{net}")')
        w = next((s[5] for s in after[net] if seg_key(b.layers[s[0]], s[1], s[2], s[3], s[4], net) == (layer, net, p, q)), 0.2)
        lines.append(f'\t(segment (start {p[0]:.4f} {p[1]:.4f}) (end {q[0]:.4f} {q[1]:.4f}) (width {round(w, 4)}) (layer "{layer}") {tok} ({idkey} "{uuid.uuid4()}"))')
    text2 = text2[:-1].rstrip() + "\n" + "\n".join(lines) + ("\n" if lines else "") + ")\n"
    Path(dst).write_text(text2, encoding="utf-8")
    return removed, len(add)


# ------------------------------------------------------------------ 命令行
def snap(n):
    """坐标取到 0.1 µm（KiCad 存 1 nm、文件写 4 位小数）：先写 4 位小数，45° 段两轴变化量相同，仍是严格 45°。"""
    n["segs"] = [[s[0], round(s[1], 4), round(s[2], 4), round(s[3], 4), round(s[4], 4), s[5], s[6]] for s in n["segs"]]


def fix_kicad(path, out=None, cons=None, clearance=0.15, chamfer=True, diff=None, local=False):
    import extract_copper as X
    b = X.parse_kicad(path)
    nets = RL.nets_from_board(b, flip=False)
    before = {n["name"]: [list(s) for s in n["segs"]] for n in nets}
    fx = Fixer(nets, b.layers, cons, clearance, b.outline, chamfer, local=local)
    res = fx.run()
    for n in nets:
        snap(n)
    after = {n["name"]: n["segs"] for n in nets}
    removed = added = 0
    if out:
        removed, added = write_kicad(path, out, b, before, after)
    rep = {"fixed": res, "needs_manual": fx.manual, "removed": removed, "added": added}
    if diff:
        rep["segments"] = {"before": {k: v for k, v in before.items() if before[k] != after.get(k)},
                           "after": {k: after[k] for k in after if before.get(k) != after[k]}}
        Path(diff).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    return rep


def fix_plan(path, out=None, cons=None, clearance=0.15, chamfer=True, diff=None, local=False):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    pack = RL.plan_to_pack(data)
    nets = [RL.norm_net(n) for n in pack["nets"]]
    k = 0.0254 if data.get("units") == "mil" else 1.0
    sy = -1.0 if data.get("ydown") else 1.0
    outline = [(x * k, y * k * sy) for x, y in data.get("outline", [])]
    fx = Fixer(nets, pack["layers"], cons, clearance, outline, chamfer, local=local)
    res = fx.run()
    layers = pack["layers"]
    back = lambda v: round(v / k, 4)
    segs = [[layers[s[0]], back(s[1]), back(s[2] * sy), back(s[3]), back(s[4] * sy), back(s[5]), n["name"]] for n in nets for s in n["segs"]]
    old = {tuple(s[:7]) for s in data.get("segs", [])}
    new = {tuple(s) for s in segs}
    rep = {"fixed": res, "needs_manual": fx.manual, "removed": [list(s) for s in old - new], "added": [list(s) for s in new - old]}
    if out:
        Path(out).write_text(json.dumps(dict(data, segs=segs), ensure_ascii=False, indent=1), encoding="utf-8")
    if diff:
        Path(diff).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    return rep


def main(argv=None):
    ap = argparse.ArgumentParser(description="布线几何修复：任意角度、锐角、抖动、斜出焊盘 → 八方向折线")
    ap.add_argument("file", help=".kicad_pcb 或走线计划 plan.json")
    ap.add_argument("-o", "--output")
    ap.add_argument("--diff")
    ap.add_argument("--constraints")
    ap.add_argument("--clearance", type=float, default=0.15, help="与其他网络的最小间距 mm（默认 0.15，约束文件里网络类的 clearance 优先）")
    ap.add_argument("--no-chamfer", action="store_true", help="不斜切 90° 拐角（不建议：直角拐角是 P0，lint 和闸门都不会通过）")
    ap.add_argument("--brief", help="design-brief.json：G0–G4 必须已由用户确认，否则拒绝修改走线（见 references/19-design-gate.md）")
    ap.add_argument("--local", action="store_true", help="只改 P0（任意角度、锐角、锐角分支、直角），其他走线一根不动。真实板子建议用这个")
    a = ap.parse_args(argv)
    import design_gate as DG
    DG.require_or_exit(a.brief, "route")
    cons = json.loads(Path(a.constraints).read_text(encoding="utf-8")) if a.constraints else None
    src = Path(a.file)
    if src.suffix == ".kicad_pcb":
        out = a.output or str(src.with_name(src.stem + "-fixed.kicad_pcb"))
        rep = fix_kicad(src, out, cons, a.clearance, not a.no_chamfer, a.diff, a.local)
        print(f"已写入 {out}：修复 {len(rep['fixed'])} 段走线，删除 {rep['removed']} 条、新增 {rep['added']} 条线段")
    else:
        out = a.output or str(src.with_name(src.stem + "-fixed.json"))
        rep = fix_plan(src, out, cons, a.clearance, not a.no_chamfer, a.diff, a.local)
        print(f"已写入 {out}：修复 {len(rep['fixed'])} 段走线")
    if rep["needs_manual"]:
        print(f"{len(rep['needs_manual'])} 处需要人工处理（拆线重布或回到布局）：")
        for m in rep["needs_manual"][:20]:
            print(f"  {m.get('net')} L{(m.get('layer') or 0) + 1} {m.get('at', '')} {','.join(m.get('issues', []))}：{m['reason']}")
    print("提醒：在 EDA 里重新填充铺铜，再跑一次 DRC 和 route_lint.py lint。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
