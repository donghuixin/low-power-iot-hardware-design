#!/usr/bin/env python3
"""等长组：检查（RTL-07）+ 局部蛇形线补齐（与扩展 src/core/length.ts 一致）。

    python length_match.py 板子.kicad_pcb|board-pack.json --brief design-brief.json            # 只报告
    python length_match.py 板子 --brief design-brief.json -o 修好的板子 [--diff diff.json]      # 加蛇形线
    python length_match.py 板子 --brief … --group "JTAG:TCK,TMS,TDI,TDO:0.05"                  # 临时指定一组（仍需 G0–G4 放行）

等长组来自设计确认 G4_routing_plan.length_groups：[{name, nets: [...], tol_mm}]，由用户确认（也可以写在约束文件的 length_groups）。
每组以最长的网络为目标；比目标短、超过容差的网络，在它最长的一段直线中部加 N 个凸起，补到与最长的一样长。
蛇形全部是八方向、拐角 135°（没有直角）：45° 斜上 → 竖直 → 45° → 平顶 → 45° → 竖直 → 45° 回到基线，
每个凸起增加 2A − 4c(2 − √2)（A 凸起高度，c 斜切长度 = 线宽），凸起间距 6 倍线宽，高度不超过 12 倍线宽；
差得很少（不到一个完整凸起）时用 45° 梯形小凸起，增加 2A(√2 − 1)。
找不到够长、够空的直线段时列为人工处理，不会去改别的走线。

注意：几 MHz 的烧写口（SWD / JTAG）电气上不需要等长，等长真正要紧的是 DDR、并行高速总线和差分对；
是否等长、容差多少由用户在 G4 里决定，工具不会自己给总线加等长。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_lint as RL  # noqa: E402

SQ2 = math.sqrt(2)


def r4(x):
    return math.floor(x * 10000 + 0.5) / 10000


def net_length(n):
    return sum(math.hypot(s[3] - s[1], s[4] - s[2]) for s in n["segs"])


def length_rows(nets, groups):
    by = {n["name"]: n for n in nets}
    out = []
    for g in groups or []:
        ls = [(x, net_length(by[x])) for x in g.get("nets", []) if x in by]
        if len(ls) < 2:
            continue
        target = max(v for _, v in ls)
        for net, ln in ls:
            out.append({"group": g.get("name", ""), "net": net, "len": r4(ln), "target": r4(target),
                        "deficit": r4(max(0.0, target - ln - float(g.get("tol_mm") or 0)))})
    return out


def length_violations(nets, groups):
    return [{"rule": "RTL-07", "sev": "P1", "net": r["net"], "layer": None,
             "msg": f"等长组“{r['group']}”：{r['net']} 长 {r['len']:.2f} mm，比最长的 {r['target']:.2f} mm 短 {r['target'] - r['len']:.2f} mm（容差内还差 {r['deficit']:.2f} mm）",
             "value": r["deficit"], "metric": "VF-26"} for r in length_rows(nets, groups) if r["deficit"] > 0]


def bump_add(amp, w):
    return 2 * amp - 4 * w * (2 - SQ2) if amp >= 2 * w else 2 * amp * (SQ2 - 1)


def bump_amp(add, w):
    """每个凸起要补 add mm 时的高度（与 bump_add 互逆）。"""
    if add >= bump_add(2 * w, w):
        return (add + 4 * w * (2 - SQ2)) / 2
    return add / (2 * (SQ2 - 1))


def meander(A, B, w, amp, n, s0, side):
    L = math.hypot(B[0] - A[0], B[1] - A[1])
    u = ((B[0] - A[0]) / L, (B[1] - A[1]) / L)
    nv = (-u[1] * side, u[0] * side)
    c = t = w
    at = lambda s, h: (r4(A[0] + u[0] * s + nv[0] * h), r4(A[1] + u[1] * s + nv[1] * h))   # noqa: E731
    pts = [tuple(A)]
    s = s0
    for _ in range(n):
        if amp >= 2 * c:                       # 带竖直段的凸起
            pts += [at(s, 0), at(s + c, c), at(s + c, amp - c), at(s + 2 * c, amp), at(s + 2 * c + t, amp), at(s + 3 * c + t, amp - c),
                    at(s + 3 * c + t, c), at(s + 4 * c + t, 0)]
        else:                                  # 差得很少：45° 梯形小凸起（高 amp）
            pts += [at(s, 0), at(s + amp, amp), at(s + amp + t, amp), at(s + 2 * amp + t, 0)]
        s += pitch(amp, w)
    pts.append(tuple(B))
    return [p for i, p in enumerate(pts) if i == 0 or math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6]


def pitch(amp, w):
    return 6 * w if amp >= 2 * w else 2 * amp + 2 * w


AMPS = (12, 8, 6, 4, 3, 2, 1.5, 1, 0.6, 0.3)


def fit(sg, amp, nb):
    """在线段 sg 上放 nb 个高 amp 的凸起：返回可选的起点 s0 列表（中间优先，再向两端各挪几步），放不下返回 None。"""
    w = sg[5]
    L = math.hypot(sg[3] - sg[1], sg[4] - sg[2])
    margin = max(0.3, 2 * w)                   # 离线段两端（焊盘、过孔、拐角）留一点直线
    span = nb * pitch(amp, w) - w
    if span > L - 2 * margin:
        return None
    mid, room = (L - span) / 2, (L - span) / 2 - margin
    out = [mid]
    for k in range(1, 6):
        d = room * k / 5
        out += [mid - d, mid + d]
    return out


def try_place(sg, A, B, w, amp, nb, s0s, ok, net):
    for s0 in s0s:
        for side in (1, -1):
            pts = meander(A, B, w, r4(amp), nb, s0, side)
            if ok(pts, w, sg[0], net, sg):
                return (sg, nb, amp, pts)
    return None


def place(n, need, ok):
    """把 need mm 分到网络 n 的几段直线上：先试一段补齐，补不齐就每段放能放下的最大凸起，最后一段按剩下的量精确算高度。
    返回 [(线段, 凸起数, 高度, 新折线)]，补不齐返回 None。"""
    cands = sorted((sg for sg in n["segs"] if not sg[6]), key=lambda t: -math.hypot(t[3] - t[1], t[4] - t[2]))
    picks, left = [], need
    for sg in cands:
        if left <= 1e-4:
            break
        w = sg[5]
        A, B = (sg[1], sg[2]), (sg[3], sg[4])
        got = None
        for nb in range(1, 40):                   # 这一段就能补齐：精确高度
            amp = bump_amp(left / nb, w)
            if amp > 12 * w:
                continue
            if amp < 0.3 * w:
                break
            s0s = fit(sg, amp, nb)
            if s0s is None:
                break
            got = try_place(sg, A, B, w, amp, nb, s0s, ok, n["name"])
            if got:
                break
        if got:
            picks.append(got)
            left = 0
            break
        for k in AMPS:                            # 补不齐：这一段放最大的
            amp = k * w
            nb = 1
            while fit(sg, amp, nb + 1) is not None and nb * bump_add(amp, w) < left:
                nb += 1
            s0s = fit(sg, amp, nb)
            if s0s is None or nb * bump_add(amp, w) >= left:
                continue
            got = try_place(sg, A, B, w, amp, nb, s0s, ok, n["name"])
            if got:
                break
        if got:
            picks.append(got)
            left -= got[1] * bump_add(got[2], w)
    return picks if left <= 1e-4 else None


def plan(nets, groups, outline=None, clearance=0.15, only=None):
    rows = length_rows(nets, groups)
    obs = []
    for n in nets:
        for s in n["segs"]:
            obs.append(((s[1], s[2]), (s[3], s[4]), s[5] / 2, s[0], n["name"]))
        for v in n["vias"]:
            obs.append(((v[0], v[1]), (v[0], v[1]), v[2] / 2, -1, n["name"]))
    pads = [(p, n["name"]) for n in nets for p in n["pads"]]
    outline = outline or []

    def touches(pts, a, b):
        return any(math.hypot(e[0] - q[0], e[1] - q[1]) < 1e-6 for e in (pts[0], pts[-1]) for q in (a, b))

    def ok(pts, w, layer, net, skip):
        for p, q in zip(pts, pts[1:]):
            s4 = (p[0], p[1], q[0], q[1])
            if len(outline) > 2 and not (RL.point_in_poly(p[0], p[1], outline) and RL.point_in_poly(q[0], q[1], outline)):
                return False
            for a, b, r, l, nm in obs:
                if l != -1 and l != layer:
                    continue
                if nm == net:
                    if l == layer and (a[0], a[1], b[0], b[1]) == (skip[1], skip[2], skip[3], skip[4]):
                        continue
                    d = RL.seg_seg(s4, (a[0], a[1], b[0], b[1]))
                    if 1e-6 < d < 3 * w and not touches(pts, a, b):
                        return False
                    continue
                if RL.seg_seg(s4, (a[0], a[1], b[0], b[1])) - r - w / 2 < clearance:
                    return False
            for pd, nm in pads:
                if nm == net or pd["l"] not in (-1, layer):
                    continue
                cs = RL.pad_corners(dict(pd, w=pd.get("w") or 0.5, h=pd.get("h") or pd.get("w") or 0.5))
                d = min(RL.seg_seg(s4, (c[0], c[1], cs[(k + 1) % 4][0], cs[(k + 1) % 4][1])) for k, c in enumerate(cs))
                if RL.point_in_poly(p[0], p[1], cs):
                    d = 0
                if d - w / 2 < clearance:
                    return False
        return True

    by = {n["name"]: n for n in nets}
    fixed, manual, changes = [], [], []
    for row in rows:
        if row["deficit"] <= 0 or (only and row["net"] not in only):
            continue
        n = by[row["net"]]
        need = row["target"] - row["len"]
        picks = place(n, need, ok)
        if picks is None:
            manual.append({"net": n["name"], "issues": ["length"], "reason": f"差 {need:.2f} mm，找不到够长、够空的直线段加蛇形线，需要人工绕线"})
            continue
        for sg, nb, amp, pts in picks:
            add = [[sg[0], p[0], p[1], q[0], q[1], sg[5], False] for p, q in zip(pts, pts[1:])]
            changes.append({"net": n["name"], "remove": [list(sg)], "add": add})
            fixed.append({"net": n["name"], "layer": sg[0], "how": f"serpentine ×{nb}，A={amp:.2f} mm，+{nb * bump_add(amp, sg[5]):.2f} mm", "after": pts})
    return {"rows": rows, "fixed": fixed, "manual": manual, "changes": changes}


def apply(nets, changes):
    by = {n["name"]: n for n in nets}
    for ch in changes:
        n = by[ch["net"]]
        for rm in ch["remove"]:
            k = next((i for i, s in enumerate(n["segs"]) if list(s[:6]) == list(rm[:6])), None)
            if k is not None:
                n["segs"].pop(k)
        n["segs"] += [list(s) for s in ch["add"]]


def groups_from(brief, cons, extra):
    gs = []
    if brief:
        v = ((brief.get("G4_routing_plan") or {}).get("length_groups"))
        if isinstance(v, list):
            gs += v
    if cons and isinstance(cons.get("length_groups"), list):
        gs += cons["length_groups"]
    for g in extra or []:
        name, nets, tol = g.split(":")
        gs.append({"name": name, "nets": [x.strip() for x in nets.split(",") if x.strip()], "tol_mm": float(tol)})
    return gs


def main(argv=None):
    ap = argparse.ArgumentParser(description="等长组检查与局部蛇形线补齐")
    ap.add_argument("board", help=".kicad_pcb 或铜皮数据包 JSON（epro_import.py / eda_bridge.py export 的输出）")
    ap.add_argument("--brief", help="design-brief.json（等长组在 G4_routing_plan.length_groups；加蛇形线要求 G0–G4 已确认）")
    ap.add_argument("--constraints")
    ap.add_argument("--group", action="append", help="名字:网络1,网络2,…:容差mm")
    ap.add_argument("-o", "--output", help="写出加了蛇形线的板子（.kicad_pcb 或 JSON）")
    ap.add_argument("--diff", help="写出改动的线段（前后对比）")
    ap.add_argument("--clearance", type=float, default=0.15)
    a = ap.parse_args(argv)
    import design_gate as DG
    brief = DG.require_or_exit(a.brief, "route") if a.output else (DG.load(a.brief) if a.brief else None)
    cons = json.loads(Path(a.constraints).read_text(encoding="utf-8")) if a.constraints else None
    groups = groups_from(brief, cons, a.group)
    if not groups:
        print("没有等长组：在设计确认 G4_routing_plan.length_groups 里写 [{name, nets, tol_mm}] 并请用户确认，或用 --group 指定。")
        return 2
    is_kicad = a.board.endswith(".kicad_pcb")
    if is_kicad:
        import extract_copper as X
        b = X.parse_kicad(a.board)
        nets = RL.nets_from_board(b, flip=False)
        outline = None
    else:
        pack = json.loads(Path(a.board).read_text(encoding="utf-8"))
        nets = [RL.norm_net(n) for n in pack["nets"]]
        outline = ((pack.get("board") or {}).get("outline"))
    res = plan(nets, groups, outline, a.clearance)
    for r in res["rows"]:
        flag = f"差 {r['deficit']:.2f} mm" if r["deficit"] > 0 else "合格"
        print(f"{r['group']}  {r['net']:<14} {r['len']:7.2f} mm / 目标 {r['target']:.2f} mm  {flag}")
    for f in res["fixed"]:
        print(f"  补长 {f['net']}：{f['how']}")
    for m in res["manual"]:
        print(f"  人工 {m['net']}：{m['reason']}")
    if a.output:
        before = {n["name"]: [list(s) for s in n["segs"]] for n in nets}
        apply(nets, res["changes"])
        if is_kicad:
            import route_fix as F
            F.write_kicad(a.board, a.output, b, before, {n["name"]: n["segs"] for n in nets})
        else:
            pack["nets"] = [dict(p, segs=n["segs"]) for p, n in zip(pack["nets"], nets)]
            Path(a.output).write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
        print(f"已写入 {a.output}")
    if a.diff:
        Path(a.diff).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0 if not any(r["deficit"] > 0 for r in res["rows"]) or res["changes"] else 1


if __name__ == "__main__":
    sys.exit(main())
