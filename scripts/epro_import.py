#!/usr/bin/env python3
"""嘉立创 EDA 专业版工程（.epro2 / .eprj2 导出的 .epro2 压缩包，或解开后的 .epru）→ 检查用的数据。

    python epro_import.py 工程.epro2 -o board-pack.json [--finish finish-model.json] [--pcb PCB1]

输出：
  board-pack.json    铜皮数据包（route_lint.py lint / layout_lint.py / design_gate.py priorities 直接读）
  finish-model.json  出图前检查的中间模型（finish_lint.py 直接读）：位号与丝印文字、封装丝印线、泪滴

工程文件是逐行的 JSON 记录（DOCHEAD 分隔各文档）。用到的记录：PCB 文档的 LAYER、LINE、ARC、POLY（铜线 / 板框）、VIA、
COMPONENT、PAD_NET、ATTR（位号）、STRING、TEARDROP、POUR / LAYER_FILL；FOOTPRINT 文档的 PAD 和丝印 POLY；DEVICE 的属性。
单位 mil，y 向上；输出单位 mm，原点在板框左下角。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

MIL = 0.0254
COPPER_TYPES = ("TOP", "SIGNAL", "PLANE", "BOTTOM")


def read_docs(path):
    """返回 [(docType, uuid, title, records)]，records = [(type, id, body)]。"""
    p = Path(path)
    if p.suffix.lower() in (".epro2", ".zip", ".epro"):
        with zipfile.ZipFile(p) as z:
            name = next(n for n in z.namelist() if n.endswith(".epru"))
            text = z.read(name).decode("utf-8")
    else:
        text = p.read_text(encoding="utf-8")
    docs, cur = [], None
    for ln in text.split("\n"):
        if not ln.strip():
            continue
        head, _, rest = ln.partition("||")
        try:
            h = json.loads(head)
        except json.JSONDecodeError:
            continue
        body = rest[:-1] if rest.endswith("|") else rest
        if h.get("type") == "DOCHEAD":
            d = json.loads(body)
            cur = [d.get("docType"), d.get("uuid"), "", []]
            docs.append(cur)
            continue
        if cur is None:
            continue
        try:
            b = json.loads(body) if body else {}
        except json.JSONDecodeError:
            b = {}
        if h.get("type") == "META" and isinstance(b, dict):
            cur[2] = b.get("title", "")
        cur[3].append((h.get("type"), h.get("id"), b))
    return docs


def path_points(path, n_arc=6):
    """EasyEDA 路径 [x, y, "L", x, y, …, "ARC", angle, x, y, …] → 点列（圆弧细分）。"""
    pts, i, mode = [], 0, "L"
    while i < len(path):
        t = path[i]
        if t in ("L", "ARC", "CARC"):
            mode = t
            i += 1
            continue
        if mode == "ARC" and isinstance(t, (int, float)) and i + 2 < len(path) + 1 and pts:
            ang, x, y = path[i], path[i + 1], path[i + 2]
            pts += arc_pts(pts[-1], (x, y), ang, n_arc)[1:]
            i += 3
            continue
        if isinstance(t, (int, float)) and i + 1 < len(path):
            pts.append((path[i], path[i + 1]))
            i += 2
            continue
        i += 1
    return pts


def arc_pts(a, b, ang, n=6):
    """从 a 到 b、圆心角 ang 度（正为逆时针）的圆弧点列；首尾就是 a、b。"""
    if abs(ang) < 1e-6:
        return [a, b]
    th = math.radians(ang)
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy)
    if L < 1e-9:
        return [a, b]
    k = (L / 2) / math.tan(th / 2)                 # 弦中点到圆心的有向距离（左法向为正）
    cx, cy = (a[0] + b[0]) / 2 - dy / L * k, (a[1] + b[1]) / 2 + dx / L * k
    r = math.hypot(a[0] - cx, a[1] - cy)
    a0 = math.atan2(a[1] - cy, a[0] - cx)
    pts = [(cx + r * math.cos(a0 + th * i / n), cy + r * math.sin(a0 + th * i / n)) for i in range(n + 1)]
    pts[0], pts[-1] = a, b
    return pts


def rect_path(path):
    """["R", x, y, w, h, rot, r]：左上角 (x, y)，向右 w、向下 h（y 向上的坐标里是 y - h）。"""
    _, x, y, w, h = path[:5]
    return [(x, y), (x + w, y), (x + w, y - h), (x, y - h)]


def import_epro(path, pcb_title=None):
    docs = read_docs(path)
    pcbs = [d for d in docs if d[0] == "PCB"]
    if not pcbs:
        raise SystemExit("工程里没有 PCB 文档")
    pcb = next((d for d in pcbs if d[2] == pcb_title), pcbs[0]) if pcb_title else pcbs[0]
    fps = {d[1]: d for d in docs if d[0] == "FOOTPRINT"}
    devices = {d[1]: d for d in docs if d[0] == "DEVICE"}
    recs = pcb[3]

    # 铜层顺序：顶层、内层（按 LAYER_PHYS 的 zIndex，没有就按 id）、底层
    layer_info = {b["layerId"]: b for t, _, b in recs if t == "LAYER" and b.get("use")}
    phys = {}
    for t, i, b in recs:
        if t == "LAYER_PHYS":
            try:
                phys[json.loads(i)[1]] = b.get("zIndex", 0)
            except (ValueError, IndexError):
                pass
    inner = sorted([lid for lid, b in layer_info.items() if b.get("layerType") in ("SIGNAL", "PLANE")], key=lambda l: (phys.get(l, l), l))
    order = [1] + inner + [2]
    lidx = {lid: k for k, lid in enumerate(order)}
    layer_names = ["F.Cu"] + [f"In{k}.Cu" for k in range(1, len(inner) + 1)] + ["B.Cu"]
    layer_use = {layer_names[lidx[lid]]: layer_info.get(lid, {}).get("layerName", "") for lid in order}

    # 板框与坐标原点
    outline = []
    for t, _, b in recs:
        if t == "POLY" and b.get("layerId") == 11:
            pth = b.get("path") or []
            outline = rect_path(pth) if pth and pth[0] == "R" else path_points(pth)
            break
    if not outline:
        raise SystemExit("没有找到板框（Board Outline Layer）")
    x0, y0 = min(p[0] for p in outline), min(p[1] for p in outline)
    M = lambda x, y: (round((x - x0) * MIL, 4), round((y - y0) * MIL, 4))   # noqa: E731

    nets = {}

    def net(name):
        if name not in nets:
            nets[name] = {"name": name, "segs": [], "vias": [], "pads": [], "zone": False}
        return nets[name]

    for t, i, b in recs:
        nm = b.get("netName") if isinstance(b, dict) else None
        if t == "LINE" and nm and b.get("layerId") in lidx:
            (ax, ay), (bx, by) = M(b["startX"], b["startY"]), M(b["endX"], b["endY"])
            net(nm)["segs"].append([lidx[b["layerId"]], ax, ay, bx, by, round(b["width"] * MIL, 4), False])
        elif t == "ARC" and nm and b.get("layerId") in lidx:
            pts = arc_pts((b["startX"], b["startY"]), (b["endX"], b["endY"]), b.get("angle", 0), 6)
            for p, q in zip(pts, pts[1:]):
                net(nm)["segs"].append([lidx[b["layerId"]], *M(*p), *M(*q), round(b["width"] * MIL, 4), True])
        elif t == "POLY" and nm and b.get("layerId") in lidx and b.get("polyType") == "NORMAL":
            pts = path_points(b.get("path") or [])
            arc = "ARC" in (b.get("path") or [])
            for p, q in zip(pts, pts[1:]):
                net(nm)["segs"].append([lidx[b["layerId"]], *M(*p), *M(*q), round(b.get("width", 10) * MIL, 4), arc])
        elif t == "VIA" and nm:
            net(nm)["vias"].append([*M(b["centerX"], b["centerY"]), round(b["viaDiameter"] * MIL, 4)])
        elif t in ("POUR",) and nm and b.get("layerId") in lidx:
            net(nm)["zone"] = True

    # 平面层（LAYER_FILL）：按填充外框估计地覆盖
    planes = []
    board_area = (max(p[0] for p in outline) - x0) * (max(p[1] for p in outline) - y0)
    for t, i, b in recs:
        if t != "LAYER_FILL":
            continue
        for f in b.get("fill") or []:
            lid = f.get("layerId")
            if lid not in lidx or not f.get("netName"):
                continue
            net(f["netName"])["zone"] = True
            pts = [q for ring in (f.get("path") or []) for q in path_points(ring if isinstance(ring, list) else [])]
            if pts and "GND" in f["netName"].upper():
                area = (max(p[0] for p in pts) - min(p[0] for p in pts)) * (max(p[1] for p in pts) - min(p[1] for p in pts))
                planes.append({"layer": lidx[lid], "gnd_frac": round(min(1.0, area / board_area), 3), "frag": 0})

    # 器件与焊盘
    pad_net = {}
    for t, i, b in recs:
        if t == "PAD_NET":
            k = json.loads(i)
            pad_net[(k[1], k[3] if len(k) > 3 else k[2])] = b.get("padNet") or ""
            pad_net[(k[1], "#" + str(k[2]))] = b.get("padNet") or ""
    attrs = {}
    for t, i, b in recs:
        if t == "ATTR" and b.get("parentId"):
            attrs.setdefault(b["parentId"], {})[b["key"]] = b
    parts, texts, lines_silk, counts = [], [], [], {}
    for t, cid, b in recs:
        if t != "COMPONENT":
            continue
        a = attrs.get(cid, {})
        ref = (a.get("Designator") or {}).get("value") or ""
        if not ref:
            continue
        counts[ref] = counts.get(ref, 0) + 1
        fp = fps.get((a.get("Footprint") or {}).get("value"))
        dev = devices.get((a.get("Device") or {}).get("value"))
        dattr = {}
        if dev:
            for tt, _, bb in dev[3]:
                if tt == "META":
                    dattr = bb.get("attributes") or {}
        value = next((v for v in (dattr.get("Value"), dattr.get("Name"), dattr.get("Manufacturer Part"), dev[2] if dev else "")
                      if isinstance(v, str) and v.strip() and not v.strip().startswith("={")), "")
        bottom = b.get("layerId") == 2
        ang = float(b.get("angle") or 0)
        cx, cy = b["x"], b["y"]

        def place(px, py, cx=cx, cy=cy, ang=ang, bottom=bottom):
            if bottom:
                px = -px
            r = math.radians(ang)
            return cx + px * math.cos(r) - py * math.sin(r), cy + px * math.sin(r) + py * math.cos(r)
        xs, ys = [], []
        if fp:
            for tt, pid, pb in fp[3]:
                if tt == "PAD":
                    d = pb.get("defaultPad") or {}
                    w, h = (d.get("width") or 10), (d.get("height") or d.get("width") or 10)
                    if d.get("padType") in ("ELLIPSE", "OVAL") and not d.get("height"):
                        h = w
                    gx, gy = place(pb["centerX"], pb["centerY"])
                    rot = (float(pb.get("padAngle") or 0) * (-1 if bottom else 1) + ang) % 360
                    lid = pb.get("layerId")
                    l = -1 if lid == 12 or pb.get("hole") else (len(order) - 1 if bottom else 0)
                    nm = pad_net.get((cid, pid)) or pad_net.get((cid, "#" + str(pb.get("num"))))
                    (mx, my) = M(gx, gy)
                    pad = [ref, str(pb.get("num")), l, mx, my, round(w * MIL, 4), round(h * MIL, 4), round(rot, 3),
                           "circle" if d.get("padType") == "ELLIPSE" else "rect"]
                    hw, hh = w * MIL / 2, h * MIL / 2
                    if abs((rot % 180) - 90) < 45:
                        hw, hh = hh, hw
                    xs += [mx - hw, mx + hw]
                    ys += [my - hh, my + hh]
                    if nm:
                        net(nm)["pads"].append(pad)
                elif tt == "POLY" and pb.get("layerId") in (3, 4):
                    pts = path_points(pb.get("path") or []) if (pb.get("path") or [None])[0] != "R" else rect_path(pb["path"]) + [rect_path(pb["path"])[0]]
                    side = "bottom" if (pb.get("layerId") == 3) == bottom else "top"
                    for p, q in zip(pts, pts[1:]):
                        (ax, ay), (bx, by) = M(*place(*p)), M(*place(*q))
                        lines_silk.append({"side": side, "x1": ax, "y1": ay, "x2": bx, "y2": by, "w": round((pb.get("width") or 6) * MIL, 4), "owner": ref})
        mx, my = M(cx, cy)
        rect = [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)] if xs else [mx - 0.5, my - 0.5, mx + 0.5, my + 0.5]
        parts.append({"ref": ref, "x": mx, "y": my, "rect": rect, "side": "bottom" if bottom else "top", "value": value})
        # 位号丝印
        da = a.get("Designator") or {}
        if da.get("layerId") in (3, 4) and da.get("x") is not None:
            texts.append(silk_text(da, ref, "ref", ref, M))
    for t, _, b in recs:
        if t == "STRING" and b.get("layerId") in (3, 4):
            texts.append(silk_text(b, b.get("text", ""), "text", "", M))
        elif t == "POLY" and b.get("layerId") in (3, 4):
            pts = path_points(b.get("path") or [])
            for p, q in zip(pts, pts[1:]):
                (ax, ay), (bx, by) = M(*p), M(*q)
                lines_silk.append({"side": "top" if b["layerId"] == 3 else "bottom", "x1": ax, "y1": ay, "x2": bx, "y2": by, "w": round((b.get("width") or 6) * MIL, 4), "owner": ""})

    tears = []
    for t, _, b in recs:
        if t == "TEARDROP" and b.get("layerId") in lidx:
            tears.append({"net": b.get("netName", ""), "layer": layer_names[lidx[b["layerId"]]], "poly": [list(M(*p)) for p in path_points(b.get("path") or [], 4)]})

    W = round((max(p[0] for p in outline) - x0) * MIL, 4)
    H = round((max(p[1] for p in outline) - y0) * MIL, 4)
    pack = {"kind": "copper-pack", "version": 1, "source": f"epro_import {Path(path).name} / {pcb[2]}", "units": "mm", "frame": None,
            "board": {"w": W, "h": H, "outline": [list(M(*p)) for p in outline]}, "layers": layer_names, "layer_use": layer_use,
            "nets": sorted(nets.values(), key=lambda n: n["name"]), "parts": parts, "checks": {"planes": planes}}
    return pack, {"texts": texts, "lines": lines_silk, "tears": tears, "ref_counts": counts}


ORIGIN = {"LEFT_TOP": (0, 1), "LEFT_MIDDLE": (0, 0.5), "LEFT_BOTTOM": (0, 0), "CENTER_TOP": (0.5, 1), "CENTER_MIDDLE": (0.5, 0.5), "CENTER": (0.5, 0.5),
          "CENTER_BOTTOM": (0.5, 0), "RIGHT_TOP": (1, 1), "RIGHT_MIDDLE": (1, 0.5), "RIGHT_BOTTOM": (1, 0)}


def silk_text(b, s, kind, owner, M):
    import finish_lint as FL
    h = (b.get("fontSize") or 45) * MIL
    w = (b.get("strokeWidth") or 6) * MIL
    ang = float(b.get("angle") or 0) % 360
    ax, ay = ORIGIN.get(str(b.get("origin") or "LEFT_BOTTOM").upper(), (0, 0))
    x, y = M(b["x"], b["y"])
    mirror = bool(b.get("mirror"))
    hidden = kind == "ref" and b.get("valueVisible") is False
    box = FL.text_bbox(x, y, max(1, len(s)) * h * 0.62, h, ang, 1 - ax if mirror else ax, ay)
    return {"text": s, "kind": kind, "owner": owner, "side": "top" if b.get("layerId") == 3 else "bottom", "x": x, "y": y, "h": round(h, 4),
            "w": round(w, 4), "rot": round(ang, 3), "mirror": mirror, "hidden": hidden, "bbox": box}


def finish_model(pack, silk):
    import finish_lint as FL
    m = FL.build_model(pack, silk["texts"], silk["lines"], silk["tears"], "epro", "full")
    m["ref_counts"] = silk["ref_counts"]
    return m


def main(argv=None):
    ap = argparse.ArgumentParser(description="嘉立创 EDA 专业版工程 → 铜皮数据包 + 出图前检查模型")
    ap.add_argument("project", help=".epro2 工程包，或解开后的 .epru")
    ap.add_argument("-o", "--output", default="board-pack.json")
    ap.add_argument("--finish", help="同时写出出图前检查模型（finish_lint.py 读）")
    ap.add_argument("--pcb", help="工程里有多块 PCB 时，按标题选一块")
    a = ap.parse_args(argv)
    pack, silk = import_epro(a.project, a.pcb)
    Path(a.output).write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
    n_seg = sum(len(n["segs"]) for n in pack["nets"])
    print(f"已写入 {a.output}：{pack['board']['w']} × {pack['board']['h']} mm，{len(pack['layers'])} 层，{len(pack['parts'])} 个器件，"
          f"{len(pack['nets'])} 个网络，{n_seg} 段走线，{sum(len(n['vias']) for n in pack['nets'])} 个过孔")
    if a.finish:
        Path(a.finish).write_text(json.dumps(finish_model(pack, silk), ensure_ascii=False), encoding="utf-8")
        print(f"已写入 {a.finish}：{len(silk['texts'])} 段丝印文字，{len(silk['lines'])} 段丝印线，{len(silk['tears'])} 个泪滴")
    return 0


if __name__ == "__main__":
    sys.exit(main())
