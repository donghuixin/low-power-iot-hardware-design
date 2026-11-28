#!/usr/bin/env python3
"""走线原则检查：就近原则（RTP）、差分线原则（RTD）、布线优先级与隔离（RTO、RTS-06），以及推荐布线顺序。

由 route_lint.analyze() 调用；原则与阈值见 references/17-routing-principles.md。单独使用：

  python route_lint.py lint board.kicad_pcb         # 报告里含本文件的检查
  python route_lint.py order board.kicad_pcb        # 按优先级给出布线顺序

器件角色按位号和所连网络推断：C* 一端接地一端接电源 = 去耦 / 储能电容（按容值区分），C* 一端接晶振网络一端接地 = 负载电容，
D* / TVS* / ESD* 一端接地一端接连到接口的信号 = ESD 器件，R* 两端各只连一个芯片引脚 = 串联电阻；J* / CN* / USB* = 接口，U* / IC* = 芯片。
"""
import heapq
import math
import re
import statistics

import route_lint as RL

# ------------------------------------------------------------------ 布线优先级
# 档位越小越先布。同档内：先布所在器件引脚最多的（最密的器件先扇出），再按八方向最短距离从短到长。
TIERS = [
    (1, "射频与天线", ["RF50"], "照抄参考设计，最短最直、0 过孔、不分叉，先占住最好的位置"),
    (2, "时钟源", ["XTAL"], "晶振线 ≤ 5 mm、0 过孔，负载电容贴着晶振，下方完整地"),
    (3, "开关回路与高压", ["SW", "HV"], "热回路面积最小、开关节点铜最小；高压先定间距和爬电"),
    (4, "高速差分", ["USB90", "DIFF100"], "成对、同层、等距、等长，过孔成对"),
    (5, "单端时钟", ["CLK"], "短、少过孔、远离模拟和射频，有完整参考平面"),
    (6, "模拟敏感", ["ANALOG"], "远离攻击网络，走在地的正上方，必要时包地"),
    (7, "电源", ["PWR_MAIN", "PWR_LOW"], "先干线后支路，宽线或铺铜；去耦电容就近到引脚"),
    (8, "一般信号", ["SIG"], "总线成束等距，按层主方向走"),
    (9, "地", ["GND"], "铺铜和缝合过孔放在最后，补齐被切开的地"),
]
TIER_OF = {c: t for t, _, cs, _ in TIERS for c in cs}
TIER_NAME = {t: n for t, n, _, _ in TIERS}

AGGRESSOR = {"SW", "CLK", "USB90", "DIFF100", "HV"}
VICTIM = {"ANALOG", "XTAL", "RF50"}
POWER = {"PWR_LOW", "PWR_MAIN"}

# 差分对内长度差 [建议, 上限] mm 与严重度
PAIR_SKEW = {"USB90": (0.5, 1.25), "DIFF100": (0.13, 0.5)}
PAIR_DEFAULT_SKEW = (1.0, 2.5)


def tier_of(cls):
    return TIER_OF.get(cls, 8)


def is_ic(ref):
    return bool(re.match(r"^(U|IC)\d", str(ref)))


def parse_value(v):
    """电容值字符串 → 法拉（"100nF"、"0.1uF"、"4u7"、"10u/16V"）；认不出返回 None。"""
    if not v:
        return None
    s = str(v).replace("µ", "u").replace("μ", "u").strip()
    m = re.match(r"^(\d+(?:\.\d+)?)\s*([pnum])(\d*)", s, re.I)
    if not m:
        return None
    k = {"p": 1e-12, "n": 1e-9, "u": 1e-6, "m": 1e-3}[m.group(2).lower()]
    x = float(m.group(1))
    if m.group(3):
        x += float("0." + m.group(3))
    return x * k


# ------------------------------------------------------------------ 网络铜皮图（跨层，求走线路径长度）
class NetPaths:
    """一个网络的铜皮连通图：节点 = 各层走线端点、过孔、焊盘；边长 = 走线长度（过孔、焊盘内部为 0）。"""

    def __init__(self, n):
        self.n = n
        self.adj = {}
        self.pos = {}
        layers = sorted({s[0] for s in n["segs"]})
        for l in layers:
            g = RL.Graph([s for s in n["segs"] if s[0] == l], n["pads"], n["vias"], l)
            for e in g.edges:
                a, b = ("s", l) + e["ka"], ("s", l) + e["kb"]
                self.pos[a], self.pos[b] = e["a"], e["b"]
                L = math.dist(e["a"], e["b"])
                self._link(a, b, L)
            for key, nd in g.nodes.items():
                k = ("s", l) + key
                x, y = nd["p"]
                for i, v in enumerate(n["vias"]):
                    if math.hypot(x - v[0], y - v[1]) <= v[2] / 2 + 1e-3:
                        self.pos[("v", i)] = (v[0], v[1]); self._link(k, ("v", i), 0.0)
                for i, p in enumerate(n["pads"]):
                    if p["l"] in (-1, l) and RL.pt_in_pad(x, y, p):
                        self.pos[("p", i)] = (p["x"], p["y"]); self._link(k, ("p", i), 0.0)
        for i, p in enumerate(n["pads"]):
            self.pos.setdefault(("p", i), (p["x"], p["y"]))
            for j, v in enumerate(n["vias"]):
                if RL.pt_in_pad(v[0], v[1], p, v[2] / 2):
                    self.pos.setdefault(("v", j), (v[0], v[1])); self._link(("p", i), ("v", j), 0.0)

    def _link(self, a, b, L):
        self.adj.setdefault(a, []).append((b, L))
        self.adj.setdefault(b, []).append((a, L))

    def path(self, i, j):
        """焊盘 i → 焊盘 j 的最短走线路径：(长度, 折线点)；不连通返回 (None, None)。"""
        L, keys = self.path_keys(i, j)
        return (None, None) if keys is None else (L, [self.pos[k] for k in keys])

    def path_keys(self, i, j):
        """同 path，但返回节点序列（含 ("v", 序号) 过孔节点）。"""
        src, dst = ("p", i), ("p", j)
        if src not in self.adj or dst not in self.adj:
            return None, None
        dist, prev, pq = {src: 0.0}, {}, [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if u == dst:
                break
            if d > dist.get(u, 1e18):
                continue
            for v, L in self.adj.get(u, ()):
                nd = d + L
                if nd < dist.get(v, 1e18) - 1e-12:
                    dist[v] = nd; prev[v] = u
                    heapq.heappush(pq, (nd, v))
        if dst not in dist:
            return None, None
        keys, u = [], dst
        while True:
            keys.append(u)
            if u == src:
                break
            u = prev[u]
        return dist[dst], keys[::-1]


def dist_along(pts, x, y):
    """点到折线的最短距离，以及垂足处从折线起点量起的长度。"""
    best, at, acc = 1e18, 0.0, 0.0
    for a, b in zip(pts, pts[1:]):
        L = math.dist(a, b)
        d = RL.pt_seg(x, y, a[0], a[1], b[0], b[1])
        if d < best:
            t = 0.0 if L < 1e-12 else max(0.0, min(1.0, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / (L * L)))
            best, at = d, acc + t * L
        acc += L
    return best, at


def pad_half(p):
    return max(p.get("w") or 0.5, p.get("h") or 0.5) / 2


# ------------------------------------------------------------------ 就近原则
def check_proximity(ctx, nets, classes, values, nL, has_plane):
    by = {n["name"]: n for n in nets}
    paths = {}
    def P(name):
        if name not in paths:
            paths[name] = NetPaths(by[name])
        return paths[name]
    # 每个器件的焊盘
    comp = {}
    for n in nets:
        for i, p in enumerate(n["pads"]):
            comp.setdefault(p["ref"], []).append((n["name"], i, p))
    gnd_vias = [(v[0], v[1], v[2]) for n in nets if classes[n["name"]] == "GND" for v in n["vias"]]
    gnd_vias += [(p["x"], p["y"], 0.0) for n in nets if classes[n["name"]] == "GND" for p in n["pads"] if p["l"] == -1]

    def route_len(net, i, j):
        n = by[net]
        L, _ = P(net).path(i, j) if not n.get("zone") else (None, None)
        a, b = n["pads"][i], n["pads"][j]
        return (L, "走线") if L is not None else (math.dist((a["x"], a["y"]), (b["x"], b["y"])), "直线")

    for ref, pads in comp.items():
        nets_of = [classes[nm] for nm, _, _ in pads]
        # ---- 去耦 / 储能电容
        if re.match(r"^C\d", ref) and len(pads) == 2 and "GND" in nets_of and any(c in POWER for c in nets_of):
            (pn, pi, pp), (gn, gi, gp) = sorted(pads, key=lambda t: classes[t[0]] == "GND")
            if classes[pn] not in POWER:
                continue
            cands = [(j, q) for j, q in enumerate(by[pn]["pads"]) if is_ic(q["ref"])]
            if cands:
                j, q = min(cands, key=lambda t: math.dist((t[1]["x"], t[1]["y"]), (pp["x"], pp["y"])))
                L, how = route_len(pn, pi, j)
                cap = parse_value(values.get(ref))
                bulk = cap is not None and cap > 1.01e-6
                # RTP-08（TI ZHCAAE6B）：电容与芯片同层，之间不经过过孔；过孔打在电容焊盘上再去电源平面
                if not bulk:
                    if pp["l"] != -1 and q["l"] != -1 and pp["l"] != q["l"]:
                        ctx.add("RTP-08", "P2", pn, pp["l"], (pp["x"], pp["y"]), f"去耦电容 {ref} 与 {q['ref']} 不在同一层：电流要经过过孔，回路电感变大", metric="VF-29")
                    elif not by[pn].get("zone"):
                        _, keys = P(pn).path_keys(pi, j)
                        nv = sum(1 for k in (keys or [])[1:-1] if k[0] == "v")
                        if nv:
                            ctx.add("RTP-08", "P2", pn, pp["l"], (pp["x"], pp["y"]), f"去耦电容 {ref} 到 {q['ref']}.{q['pin']} 之间经过 {nv} 个过孔（电容与芯片之间不打过孔，过孔打在电容焊盘外侧）", nv, metric="VF-29")
                if bulk:
                    if L > 10.0:
                        ctx.add("RTP-02", "P3", pn, pp["l"], (pp["x"], pp["y"]), f"储能电容 {ref}（{values.get(ref)}）到 {q['ref']}.{q['pin']} {how}距离 {L:.1f} mm（建议 ≤ 10 mm）", round(L, 2), metric="VF-29")
                else:
                    sev = "P1" if L > 6.0 else ("P2" if L > 3.0 else None)
                    if sev and cap is None:
                        sev = "P2"
                    if sev:
                        ctx.add("RTP-01", sev, pn, pp["l"], (pp["x"], pp["y"]),
                                f"去耦电容 {ref}{'（' + str(values.get(ref)) + '）' if values.get(ref) else ''} 到 {q['ref']}.{q['pin']} 的{how}距离 {L:.1f} mm（焊盘中心之间，≤ 3 mm）", round(L, 2), metric="VF-29")
            if has_plane and gp["l"] != -1:
                d = min((max(0.0, RL.seg_pad((x, y, x, y), gp) - r) for x, y, r in gnd_vias), default=None)
                if d is None or d > 1.5:
                    ctx.add("RTP-03", "P2", gn, gp["l"], (gp["x"], gp["y"]), f"电容 {ref} 的地焊盘 {'附近没有地过孔' if d is None else f'离最近的地过孔 {d:.1f} mm'}（≤ 0.5 mm，回流要短）", round(d, 2) if d else None, metric="VF-29")
                elif d > 0.5:
                    ctx.add("RTP-03", "P3", gn, gp["l"], (gp["x"], gp["y"]), f"电容 {ref} 的地焊盘离最近的地过孔 {d:.1f} mm（建议 ≤ 0.5 mm）", round(d, 2), metric="VF-29")
        # ---- 晶振负载电容
        if re.match(r"^C\d", ref) and len(pads) == 2 and "GND" in nets_of and "XTAL" in nets_of:
            xn, xi, xp = next(t for t in pads if classes[t[0]] == "XTAL")
            ys = [(j, q) for j, q in enumerate(by[xn]["pads"]) if re.match(r"^(Y|X)\d", str(q["ref"]))]
            if ys:
                j, q = min(ys, key=lambda t: math.dist((t[1]["x"], t[1]["y"]), (xp["x"], xp["y"])))
                L, how = route_len(xn, xi, j)
                if L > 3.0:
                    ctx.add("RTP-04", "P2" if L <= 6 else "P1", xn, xp["l"], (xp["x"], xp["y"]), f"晶振负载电容 {ref} 到 {q['ref']}.{q['pin']} 的{how}距离 {L:.1f} mm（≤ 3 mm，贴着晶振）", round(L, 2), metric="VF-29")
        # ---- ESD / TVS
        if re.match(r"^(D|TVS|ESD|ZD)\d", ref) and "GND" in nets_of:
            for sn, si, sp in pads:
                if classes[sn] == "GND":
                    continue
                n = by[sn]
                conns = [(j, q) for j, q in enumerate(n["pads"]) if re.match(r"^(J|CN|USB)\d", str(q["ref"]))]
                ics = [(j, q) for j, q in enumerate(n["pads"]) if is_ic(q["ref"])]
                if not conns:
                    continue
                cj, cq = min(conns, key=lambda t: math.dist((t[1]["x"], t[1]["y"]), (sp["x"], sp["y"])))
                L, how = route_len(sn, si, cj)
                if L > 5.0:
                    ctx.add("RTP-05", "P2" if L <= 10 else "P1", sn, sp["l"], (sp["x"], sp["y"]), f"ESD 器件 {ref} 离接口 {cq['ref']}.{cq['pin']} {how}距离 {L:.1f} mm（≤ 5 mm，放在接口处）", round(L, 2), metric="VF-29")
                if ics and not n.get("zone"):
                    ij, iq = min(ics, key=lambda t: math.dist((t[1]["x"], t[1]["y"]), (cq["x"], cq["y"])))
                    Lci, pts = P(sn).path(cj, ij)
                    if pts:
                        d, s = dist_along(pts, sp["x"], sp["y"])
                        stub = max(0.0, d - pad_half(sp))
                        if stub > 1.0:
                            ctx.add("RTP-06", "P2", sn, sp["l"], (sp["x"], sp["y"]), f"ESD 器件 {ref} 不在接口到芯片的路径上，桩线约 {stub:.1f} mm（应串在线上，桩线 ≤ 1 mm）", round(stub, 2), metric="VF-29")
                        elif s > 0.5 * Lci:
                            ctx.add("RTP-06", "P2", sn, sp["l"], (sp["x"], sp["y"]), f"ESD 器件 {ref} 在路径上更靠近芯片（离接口 {s:.1f} mm、离芯片 {Lci - s:.1f} mm）：浪涌会先到芯片", round(s, 2), metric="VF-29")
        # ---- 串联电阻
        if re.match(r"^R\d", ref) and len(pads) == 2 and all(classes[nm] not in POWER | {"GND"} for nm, _, _ in pads):
            ends = []
            for nm, i, p in pads:
                others = [(j, q) for j, q in enumerate(by[nm]["pads"]) if q["ref"] != ref]
                if len(others) != 1 or not is_ic(others[0][1]["ref"]):
                    break
                L, how = route_len(nm, i, others[0][0])
                ends.append((L, how, others[0][1]))
            else:
                if len(ends) == 2 and min(e[0] for e in ends) > 3.0:
                    (La, ha, qa), (Lb, hb, qb) = ends
                    p0 = pads[0][2]
                    ctx.add("RTP-07", "P3", pads[0][0], p0["l"], (p0["x"], p0["y"]), f"串联电阻 {ref} 离两端芯片都远（{qa['ref']} {La:.1f} mm、{qb['ref']} {Lb:.1f} mm）：源端匹配电阻应贴着驱动端（≤ 3 mm）", round(min(La, Lb), 2), metric="VF-29")


# ------------------------------------------------------------------ 差分线原则
def pair_names(names):
    """按命名找差分对：_P/_N、+/-、DP/DM、DP/DN、P/N 结尾。返回 [(正, 负)]。"""
    out, used = [], set()
    pats = [("_P", "_N"), ("+", "-"), ("_DP", "_DM"), ("_DP", "_DN"), ("DP", "DM"), ("DP", "DN"), ("_H", "_L"), ("P", "N")]
    S = set(names)
    for nm in sorted(names):
        if nm in used:
            continue
        for a, b in pats:
            if nm.upper().endswith(a) and len(nm) > len(a) + 1:
                m = nm[: len(nm) - len(a)] + (b if nm.endswith(a) else b.lower())
                if m in S and m not in used:
                    if a == "P" and not re.search(r"(TX|RX|CK|CLK|D\d|LVDS|DAT\d*|IN|OUT)P$", nm.upper()):
                        continue
                    out.append((nm, m)); used.update((nm, m))
                    break
    return out


class SegIndex:
    def __init__(self, items, cell=1.0):
        self.cell, self.items, self.grid = cell, items, {}
        for k, it in enumerate(items):
            s = it[1]
            for i in range(int(math.floor(min(s[1], s[3]) / cell)), int(math.floor(max(s[1], s[3]) / cell)) + 1):
                for j in range(int(math.floor(min(s[2], s[4]) / cell)), int(math.floor(max(s[2], s[4]) / cell)) + 1):
                    self.grid.setdefault((s[0], i, j), []).append(k)

    def near(self, layer, x, y, r):
        c = self.cell
        seen = set()
        for i in range(int(math.floor((x - r) / c)), int(math.floor((x + r) / c)) + 1):
            for j in range(int(math.floor((y - r) / c)), int(math.floor((y + r) / c)) + 1):
                for k in self.grid.get((layer, i, j), ()):
                    if k not in seen:
                        seen.add(k)
                        yield self.items[k]


def samples(segs, step=0.2):
    for s in segs:
        if s[6]:
            continue
        L = RL.seg_len(s)
        k = max(1, int(L / step))
        for i in range(k):
            t = (i + 0.5) / k
            yield s, s[1] + t * (s[3] - s[1]), s[2] + t * (s[4] - s[2]), L / k


def nearest_on(segs, x, y):
    best = None
    for s in segs:
        d = RL.pt_seg(x, y, s[1], s[2], s[3], s[4])
        if best is None or d < best[0]:
            best = (d, s)
    return best


def proj(x, y, s):
    dx, dy = s[3] - s[1], s[4] - s[2]
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 < 1e-18 else max(0.0, min(1.0, ((x - s[1]) * dx + (y - s[2]) * dy) / L2))
    return s[1] + t * dx, s[2] + t * dy


def check_diff_pairs(ctx, nets, classes, routed_len):
    by = {n["name"]: n for n in nets}
    cons_pairs = [(p["p"], p["n"]) for p in (ctx.cons.get("pairs") or []) if p.get("p") in by and p.get("n") in by]
    pairs = cons_pairs or pair_names([n["name"] for n in nets if n["segs"]])
    others = [(n["name"], s) for n in nets for s in n["segs"] if not s[6] and classes[n["name"]] != "GND"]
    idx = SegIndex(others)
    found = []
    for a, b in pairs:
        A, B = by.get(a), by.get(b)
        if not A or not B or not A["segs"] or not B["segs"]:
            continue
        cls = classes[a] if classes[a] in PAIR_SKEW else (classes[b] if classes[b] in PAIR_SKEW else classes[a])
        imped = cls in PAIR_SKEW
        found.append({"p": a, "n": b, "class": cls})
        nm = f"{a}/{b}"
        lb = lambda s: "P1" if imped else "P2"
        # RTD-01 同层
        la, lb_ = {s[0] for s in A["segs"]}, {s[0] for s in B["segs"]}
        if la != lb_:
            ctx.add("RTD-01", lb(0), nm, None, None, f"差分对 {nm} 两根线用的层不同（{sorted(x + 1 for x in la)} 对 {sorted(x + 1 for x in lb_)}）：应同层同时换层", metric="VF-28")
        # 采样：耦合、间距一致、对内穿线、对外间距
        pitch, coupled, total, worst = [], 0.0, 0.0, None
        intr = {}
        tight = {}
        w = statistics.median([s[5] for s in A["segs"]])
        for s, x, y, dl in samples(A["segs"]):
            total += dl
            same = [t for t in B["segs"] if t[0] == s[0] and not t[6]]
            if not same:
                continue
            d, t = nearest_on(same, x, y)
            u, v = (s[3] - s[1], s[4] - s[2]), (t[3] - t[1], t[4] - t[2])
            ang = RL.angle_between(u, v)
            if min(ang, 180 - ang) <= 2.0 and d <= max(1.2, 6 * w):
                pitch.append((d, x, y, dl, s, t))
        if pitch:
            med = statistics.median(p[0] for p in pitch)
            lim = max(med * 1.3, med + 0.05)
            cp = [p for p in pitch if p[0] <= lim]
            coupled = sum(p[3] for p in cp)
            ds = [p[0] for p in cp]
            dev = max(abs(x - med) for x in ds) if ds else 0
            if len(ds) >= 3 and dev > max(0.1 * med, 0.03):
                p = max(cp, key=lambda q: abs(q[0] - med))
                ctx.add("RTD-03", "P2" if imped else "P3", nm, p[4][0], (p[1], p[2]), f"差分对 {nm} 间距不一致：中心距中位数 {med:.2f} mm，最大偏差 {dev:.2f} mm（≤ 10%）", round(dev, 3), metric="VF-28")
            for d, x, y, dl, s, t in cp:                  # 对内穿线：A 上一点到 B 上最近点的连线被其他网络的铜穿过
                qx, qy = proj(x, y, t)
                for on, o in idx.near(s[0], (x + qx) / 2, (y + qy) / 2, d / 2 + 1.0):
                    if on in (a, b):
                        continue
                    if RL.seg_seg((x, y, qx, qy), (o[1], o[2], o[3], o[4])) < o[5] / 2 - 1e-6:
                        intr.setdefault(on, (x, y, s[0]))
                for on, o in idx.near(s[0], x, y, 3 * w + 1.0):   # 对外间距
                    if on in (a, b):
                        continue
                    e = RL.pt_seg(x, y, o[1], o[2], o[3], o[4]) - (o[5] + s[5]) / 2
                    if e < max(2 * (d - s[5]), 3 * s[5]) - 1e-6:
                        r = tight.setdefault(on, [0.0, (x, y, s[0]), e])
                        r[0] += dl
                        r[2] = min(r[2], e)
        un = total - coupled
        if total > 0 and un > max(4.0, 0.15 * total):
            ctx.add("RTD-02", "P2" if imped else "P3", nm, None, None, f"差分对 {nm} 只有 {coupled / total:.0%} 的长度是并行耦合的（未耦合 {un:.1f} mm；出焊盘的分开段合计 ≤ 4 mm）", round(coupled / total, 2), metric="VF-28")
        for on, (x, y, l) in intr.items():
            ctx.add("RTD-06", "P1", nm, l, (x, y), f"差分对 {nm} 中间穿过了 {on}", metric="VF-28")
        for on, (L, (x, y, l), e) in tight.items():
            if L >= 2.0:
                ctx.add("RTD-07", "P3", nm, l, (x, y), f"差分对 {nm} 与 {on} 并行 {L:.1f} mm、边距 {e:.2f} mm（建议 ≥ 2 倍对内线距且 ≥ 3 倍线宽）", round(e, 3), metric="VF-28")
        # RTD-04 对内长度差
        lo, hi = PAIR_SKEW.get(cls, PAIR_DEFAULT_SKEW)
        skew = abs(routed_len.get(a, 0) - routed_len.get(b, 0))
        if skew > hi:
            ctx.add("RTD-04", "P1" if imped else "P2", nm, None, None, f"差分对 {nm} 长度差 {skew:.2f} mm（{cls} 上限 {hi}）", round(skew, 2), metric="VF-28")
        elif skew > lo:
            ctx.add("RTD-04", "P2" if imped else "P3", nm, None, None, f"差分对 {nm} 长度差 {skew:.2f} mm（{cls} 建议 ≤ {lo}）", round(skew, 2), metric="VF-28")
        # RTD-05 过孔成对
        va, vb = A["vias"], B["vias"]
        if len(va) != len(vb):
            ctx.add("RTD-05", "P1" if imped else "P2", nm, None, (va or vb)[0][:2], f"差分对 {nm} 过孔不成对（{len(va)} 对 {len(vb)}）", metric="VF-28")
        else:
            for v in va:
                d = min((math.hypot(v[0] - u[0], v[1] - u[1]) for u in vb), default=1e9)
                if d > 1.5:
                    ctx.add("RTD-05", "P2", nm, None, (v[0], v[1]), f"差分对 {nm} 的过孔没有并排放（最近的对侧过孔 {d:.1f} mm，≤ 1.5 mm）", round(d, 2), metric="VF-28")
                    break
    return found


# ------------------------------------------------------------------ 优先级与隔离
def check_priority(ctx, nets, classes, clear=0.15):
    by = {n["name"]: n for n in nets}
    troubled = {}
    for v in ctx.out:
        if v["rule"] in ("RTV-01", "RTL-02", "RTL-01", "RTL-03") and v.get("net") in by:
            troubled.setdefault(v["net"], v["rule"])
    segs = [(n["name"], s) for n in nets for s in n["segs"] if not s[6]]
    idx = SegIndex(segs, 1.0)
    pads_all = [(n["name"], p) for n in nets for p in n["pads"]]
    for name, why in troubled.items():
        n = by[name]
        t0 = tier_of(classes[name])
        if t0 > 6:
            continue
        w = statistics.median([s[5] for s in n["segs"]]) if n["segs"] else 0.2
        pts = [(p["x"], p["y"], p) for p in n["pads"]]
        done = False
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                if done or pts[i][2]["ref"] == pts[j][2]["ref"]:
                    continue
                P, Q = pts[i][:2], pts[j][:2]
                if math.dist(P, Q) > 25:
                    continue
                layer = pts[i][2]["l"] if pts[i][2]["l"] != -1 else 0
                cands = elbows(P, Q)
                lower, placement, ok = set(), False, False
                for c in cands:
                    blk = set()
                    for a, b in zip(c, c[1:]):
                        mx, my, r = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, math.dist(a, b) / 2 + 1.0
                        for on, s in idx.near(layer, mx, my, r):
                            if on != name and RL.seg_seg((a[0], a[1], b[0], b[1]), s[1:5]) < (s[5] + w) / 2 + clear:
                                blk.add(on)
                    pb = any(on != name and q["l"] in (-1, layer) and q.get("w") and q["ref"] not in (pts[i][2]["ref"], pts[j][2]["ref"])
                             and any(RL.seg_pad((a[0], a[1], b[0], b[1]), q) < w / 2 + clear for a, b in zip(c, c[1:])) for on, q in pads_all)
                    if not blk and not pb:
                        ok = True
                        break
                    placement |= pb
                    lower |= blk
                if ok or not lower or placement:
                    continue
                if all(tier_of(classes.get(on, "SIG")) > t0 for on in lower):
                    names = "、".join(sorted(lower)[:3])
                    ctx.add("RTO-01", "P2", name, layer, ((P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2),
                            f"优先级倒挂：{TIER_NAME[t0]}网络 {name}（{why}）的直连通道被低优先级网络 {names} 占了，应先布 {name}，再让 {names} 绕开", metric="VF-30")
                    done = True


def elbows(P, Q):
    dx, dy = Q[0] - P[0], Q[1] - P[1]
    if RL.is_octi(dx, dy, 1e-6):
        return [[P, Q]]
    ax, ay = abs(dx), abs(dy)
    sx, sy = math.copysign(1, dx), math.copysign(1, dy)
    d = min(ax, ay); r = max(ax, ay) - d
    m1 = (P[0] + sx * d, P[1] + sy * d)
    m2 = (P[0] + sx * r, P[1]) if ax > ay else (P[0], P[1] + sy * r)
    return [[P, m1, Q], [P, m2, Q]]


def check_isolation(ctx, nets, classes):
    """攻击网络（开关节点、时钟、高速差分、高压）与敏感网络（模拟、晶振、射频）同层并行。"""
    agg = [(n["name"], s) for n in nets if classes[n["name"]] in AGGRESSOR for s in n["segs"] if not s[6]]
    vic = [(n["name"], s) for n in nets if classes[n["name"]] in VICTIM for s in n["segs"] if not s[6]]
    acc = {}
    for an, a in agg:
        for vn, v in vic:
            if a[0] != v[0]:
                continue
            u, w_ = (a[3] - a[1], a[4] - a[2]), (v[3] - v[1], v[4] - v[2])
            ang = RL.angle_between(u, w_)
            if min(ang, 180 - ang) > 2.0:
                continue
            La = math.hypot(*u)
            if La < 1e-6:
                continue
            ux, uy = u[0] / La, u[1] / La
            t1 = (v[1] - a[1]) * ux + (v[2] - a[2]) * uy
            t2 = (v[3] - a[1]) * ux + (v[4] - a[2]) * uy
            ov = min(La, max(t1, t2)) - max(0.0, min(t1, t2))
            if ov <= 0:
                continue
            gap = abs((v[1] - a[1]) * uy - (v[2] - a[2]) * ux) - (a[5] + v[5]) / 2
            if gap < max(0.5, 3 * v[5]):
                r = acc.setdefault((an, vn), [0.0, gap, (a[1] + ux * max(0, min(t1, t2)), a[2] + uy * max(0, min(t1, t2))), a[0]])
                r[0] += ov; r[1] = min(r[1], gap)
    for (an, vn), (L, gap, at, l) in acc.items():
        if L > 5.0:
            ctx.add("RTS-06", "P2" if L <= 10 else "P1", f"{an}/{vn}", l, at, f"攻击网络 {an}（{classes[an]}）与敏感网络 {vn}（{classes[vn]}）同层并行 {L:.1f} mm、边距 {gap:.2f} mm（≤ 5 mm 或拉开到 ≥ 3h，中间加地）", round(L, 1), metric="VF-30")


def routing_order(nets, classes):
    """推荐布线顺序：[(档位, 档名, 网络, 类, 焊盘数, 八方向最短长度, 理由)]。"""
    pins = {}
    for n in nets:
        for p in n["pads"]:
            pins[p["ref"]] = pins.get(p["ref"], 0) + 1
    rows = []
    for n in nets:
        if not n["pads"]:
            continue
        c = classes[n["name"]]
        t = tier_of(c)
        dense = max((pins.get(p["ref"], 0) for p in n["pads"] if is_ic(p["ref"])), default=0)
        L = RL.oct_mst([(p["x"], p["y"]) for p in n["pads"]])
        rows.append((t, -dense, L, n["name"], c, len(n["pads"])))
    rows.sort()
    why = {t: r for t, _, _, r in TIERS}
    return [{"tier": t, "tier_name": TIER_NAME[t], "net": nm, "class": c, "pads": k, "len": round(L, 1), "why": why[t]} for t, _, L, nm, c, k in rows]


def check_ground(ctx, nets, classes, nL):
    """裸露焊盘过孔（RTV-08，ADI AN-1142 / TI ZHCAAE6B）与多个地网络（RTY-06）。"""
    gnds = [n for n in nets if classes[n["name"]] == "GND"]
    for n in gnds:
        for p in n["pads"]:
            if p["l"] == -1 or not p.get("w") or not is_ic(p["ref"]):
                continue
            area = p["w"] * p["h"]
            if area < 4.0:
                continue
            need = max(4, round(area / 1.5))
            got = sum(1 for g in gnds for v in g["vias"] if RL.pt_in_pad(v[0], v[1], p, 0))
            if got < need and nL >= 2:
                ctx.add("RTV-08", "P2" if got else "P1", n["name"], p["l"], (p["x"], p["y"]),
                        f"{p['ref']} 的裸露焊盘（{p['w']:.1f} × {p['h']:.1f} mm）只有 {got} 个地过孔，建议 ≥ {need}（约每 1.5 mm² 一个，阵列排布、塞孔）：它是芯片所有地的汇集点和主散热路径", got, metric="VF-20")
    names = sorted(n["name"] for n in gnds if n["segs"] or n["vias"] or n.get("zone") or len(n["pads"]) > 1)
    if len(names) > 1:
        ctx.add("RTY-06", "P3", "、".join(names[:4]), None, None,
                f"板上有 {len(names)} 个地网络（{'、'.join(names[:4])}）：确认没有把地平面切开，只在转换器下方或功率星点一处相连；一般单一完整地加分区布局更好", len(names))


def analyze(ctx, nets, classes, values, nL, has_plane, routed_len):
    check_ground(ctx, nets, classes, nL)
    check_proximity(ctx, nets, classes, values, nL, has_plane)
    pairs = check_diff_pairs(ctx, nets, classes, routed_len)
    check_isolation(ctx, nets, classes)
    check_priority(ctx, nets, classes)
    return pairs
