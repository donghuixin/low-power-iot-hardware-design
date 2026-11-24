#!/usr/bin/env python3
"""设计规则与板厂工艺：读取、对照、生成。

  show     查看工艺档案（默认内置的嘉立创档案）及其价格档位
  template 输出一份空白工艺表（CSV），给用户或 Claude 填写
  import   把用户提供的工艺表（JSON / CSV / TSV / Markdown 表格 / 键值文本 / xlsx）转成工艺档案
  read     读出一个设计的规则与实际用到的最小值（.kicad_pro、.kicad_pcb、.kicad_dru、铜皮数据包）
  check    把设计与工艺档案对照：落在哪个价格档、是哪个参数决定的、怎么改能降档、哪些超出能力
  emit     按某个档位生成规则：KiCad 自定义规则（.kicad_dru）和网络类建议表

用法:
    python fab_rules.py show
    python fab_rules.py import 我的板厂工艺.csv -o myfab.json
    python fab_rules.py read board.kicad_pro board.kicad_pcb
    python fab_rules.py check board.kicad_pro board.kicad_pcb [--profile myfab.json] [--layers 4] [--copper 1] [-o report.md]
    python fab_rules.py emit --tier standard --layers 4 -o rules/

只依赖 Python 标准库（读 xlsx 时需要 openpyxl）。长度单位一律为 mm。
"""
import argparse
import csv
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE = ROOT / "assets" / "fab-profiles" / "jlcpcb.json"
TOL = 0.003          # 比较容差：约 0.1 mil，避免 6 mil 与 0.15 mm 这类换算差被判成不同档
TIER_KEYS = ["track_width", "clearance", "via_drill", "via_diameter"]

# 规则键：中文名、别名（用于导入用户的工艺表）
KEYS = {
    "track_width": ("最小线宽", ["线宽", "trace width", "track width", "min trace", "min track", "线路宽度"]),
    "clearance": ("最小线距", ["线距", "线隙", "间距", "spacing", "clearance", "trace space", "min space"]),
    "via_drill": ("过孔最小孔径", ["过孔内径", "过孔孔径", "最小过孔", "via hole", "via drill", "min via hole", "导通孔孔径"]),
    "via_diameter": ("过孔最小外径", ["过孔外径", "过孔焊盘", "via diameter", "via pad", "via size"]),
    "via_annular": ("过孔单边焊环", ["过孔焊环", "via annular", "via ring"]),
    "pth_annular": ("插件孔单边焊环", ["插件孔焊环", "焊环", "孔环", "annular ring", "pth annular"]),
    "pth_drill": ("插件孔最小孔径", ["最小钻孔", "最小孔径", "min drill", "pth hole", "drill"]),
    "npth_drill": ("非金属化孔最小孔径", ["npth", "无铜孔", "非金属化孔"]),
    "hole_to_hole_via": ("过孔孔边到孔边", ["过孔间距", "via to via", "hole to hole"]),
    "hole_to_hole_pad": ("插件孔孔边到孔边", ["插件孔间距", "pad hole to hole"]),
    "via_hole_to_track": ("过孔孔边到走线", ["孔到线", "via to track", "hole to track", "via hole to track"]),
    "pth_hole_to_track": ("插件孔孔边到走线", ["pth to track", "插件孔到线"]),
    "npth_to_track": ("非金属化孔到走线", ["npth to track"]),
    "pad_to_track": ("焊盘到走线", ["pad to track", "焊盘到线"]),
    "smd_pad_to_pad": ("贴片焊盘间距", ["pad to pad", "焊盘间距"]),
    "same_net_spacing": ("同网导体缝隙", ["同网络间距", "same net"]),
    "copper_to_edge": ("铜到板边（铣边）", ["板边距", "铜到板边", "copper to edge", "edge clearance", "board edge"]),
    "copper_to_vcut": ("铜到 V 割边", ["v割", "v-cut", "vcut"]),
    "min_smd_pad": ("最小贴片焊盘", ["最小焊盘", "min smd pad"]),
    "bga_pad": ("BGA 焊盘最小直径", ["bga"]),
    "mask_bridge": ("阻焊桥", ["阻焊桥", "solder mask bridge", "mask bridge", "绿油桥"]),
    "silk_width": ("丝印最小线宽", ["字符线宽", "丝印线宽", "silkscreen width", "legend width"]),
    "silk_height": ("丝印最小字高", ["字符高度", "丝印字高", "text height", "silkscreen height"]),
    "silk_to_pad": ("丝印到焊盘", ["字符到焊盘", "silk to pad"]),
    "slot_plated": ("金属化槽最小宽度", ["金属化槽", "plated slot"]),
    "slot_npth": ("非金属化槽最小宽度", ["非金属化槽", "non-plated slot", "铣槽"]),
    "castellated_hole": ("半孔最小孔径", ["半孔", "castellated"]),
    "track_tolerance_pct": ("线宽公差 %", ["线宽公差", "trace tolerance"]),
}
CN = {k: v[0] for k, v in KEYS.items()}


# ---------------------------------------------------------------- 通用
def sexp(text):
    tok = re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+', text)
    stack, cur = [], []
    for t in tok:
        if t == "(":
            stack.append(cur); cur = []
        elif t == ")":
            done = cur; cur = stack.pop(); cur.append(done)
        else:
            cur.append(t[1:-1] if t.startswith('"') else t)
    return cur[0] if cur else []


def find(node, key):
    return [c for c in node if isinstance(c, list) and c and c[0] == key]


def first(node, key):
    r = find(node, key)
    return r[0] if r else None


def to_mm(text):
    """'3.5mil'、'0.09 mm'、'6 mil(0.15mm)'、'18um' → mm。有括号里的 mm 值时优先用它。"""
    s = str(text).strip().lower().replace("㎜", "mm").replace("毫米", "mm").replace("微米", "um").replace("μ", "u")
    m = re.search(r"(\d+(?:\.\d+)?)\s*mm", s)
    if m:
        return float(m.group(1))
    m = re.search(r"(\d+(?:\.\d+)?)\s*mil", s)
    if m:
        return round(float(m.group(1)) * 0.0254, 4)
    m = re.search(r"(\d+(?:\.\d+)?)\s*um", s)
    if m:
        return round(float(m.group(1)) / 1000, 4)
    m = re.search(r"(\d+(?:\.\d+)?)\s*%", s)
    if m:
        return float(m.group(1))
    m = re.fullmatch(r"[≥>=~约 ]*(\d+(?:\.\d+)?)", s)
    return float(m.group(1)) if m else None


def match_key(name):
    n = re.sub(r"[\s（）()：:_\-/]", "", str(name).lower())
    if name in KEYS:
        return name
    best = None
    for k, (cn, alias) in KEYS.items():
        for a in [cn] + alias:
            a2 = re.sub(r"[\s（）()：:_\-/]", "", a.lower())
            if a2 and a2 in n and (best is None or len(a2) > best[0]):
                best = (len(a2), k)
    return best[1] if best else None


def load_profile(path=None):
    p = json.loads(Path(path or DEFAULT_PROFILE).read_text(encoding="utf-8"))
    if p.get("kind") != "fab-profile" or not p.get("tiers"):
        raise SystemExit(f"{path} 不是工艺档案（kind 应为 fab-profile，且至少有一个档位）")
    return p


def lk(layers):
    return "2" if int(layers) <= 2 else "multi"


def tier_rules(profile, tier, layers, copper=1):
    r = dict(tier["rules"].get(lk(layers)) or tier["rules"].get("multi") or tier["rules"].get("2") or {})
    cu = (profile.get("copper") or {}).get(str(int(copper)) if float(copper).is_integer() else str(copper))
    if cu:
        for k in ("track_width", "clearance"):
            v = cu.get(k)
            v = v.get(lk(layers)) if isinstance(v, dict) else v
            if v:
                r[k] = max(r.get(k, 0), v)
    return r


def common_value(profile, key, layers=2):
    c = (profile.get("common") or {}).get(key)
    if c is None:
        return None, None
    if isinstance(c, dict):
        return c.get("value"), c.get("rec")
    return c, None


# ---------------------------------------------------------------- 导入用户工艺
def table_rows(path):
    p = Path(path)
    if p.suffix.lower() in (".xlsx", ".xlsm"):
        try:
            import openpyxl
        except ImportError:
            raise SystemExit("读取 xlsx 需要 openpyxl：pip install openpyxl，或另存为 CSV")
        wb = openpyxl.load_workbook(p, data_only=True)
        return [[("" if c is None else str(c)) for c in row] for ws in wb for row in ws.iter_rows(values_only=True)]
    text = p.read_text(encoding="utf-8-sig", errors="replace")
    rows = []
    if p.suffix.lower() in (".csv", ".tsv"):
        return [r for r in csv.reader(io.StringIO(text), delimiter="\t" if p.suffix.lower() == ".tsv" else ",")]
    for line in text.splitlines():
        line = line.strip()
        if not line or set(line) <= set("|-: "):
            continue
        if "|" in line:
            rows.append([c.strip() for c in line.strip("|").split("|")])
        else:
            m = re.split(r"\s*[:：=,，\t]\s*|\s{2,}", line, maxsplit=3)
            rows.append([c for c in m if c != ""])
    return rows


def import_profile(path, name=None):
    """把用户的工艺表转成工艺档案。返回 (档案, 没认出来的行)。"""
    p = Path(path)
    if p.suffix.lower() == ".json":
        d = json.loads(p.read_text(encoding="utf-8"))
        if d.get("kind") == "fab-profile":
            return load_profile(p), []
        rows = [[k, v] for k, v in d.items()]
    else:
        rows = table_rows(p)
    rows = [r for r in rows if r and any(str(c).strip() for c in r)]
    header = None
    if rows and all(to_mm(c) is None for c in rows[0][1:]) and len(rows[0]) > 1 and match_key(rows[0][0]) is None:
        header = [str(c).strip() for c in rows[0]]
        rows = rows[1:]
    if header:                                             # 去掉"备注 / 说明"列
        drop = [i for i, h in enumerate(header) if i and re.search(r"备注|说明|note|remark|comment", h, re.I)]
        for i in sorted(drop, reverse=True):
            header.pop(i)
            for r in rows:
                if len(r) > i: r.pop(i)
    ncol = max((len(r) for r in rows), default=2) - 1
    names = (header[1:1 + ncol] if header else []) + [f"档位 {k + 1}" for k in range(ncol)]
    tiers = [{"id": f"t{k + 1}" if ncol > 1 else "standard", "name": names[k] if header else ("标准" if ncol == 1 else names[k]),
              "cost": "", "rules": {"2": {}, "multi": {}}} for k in range(ncol)]
    common, unknown = {}, []
    for r in rows:
        key = match_key(r[0])
        vals = [to_mm(c) for c in r[1:1 + ncol]]
        if key is None or all(v is None for v in vals):
            unknown.append(" | ".join(str(c) for c in r))
            continue
        if key in TIER_KEYS:
            last = None
            for t, v in zip(tiers, vals + [None] * ncol):
                last = v if v is not None else last
                if last is not None:
                    t["rules"]["2"][key] = t["rules"]["multi"][key] = last
        else:
            common[key] = {"value": next(v for v in vals if v is not None)}
    tiers = [t for t in tiers if t["rules"]["2"]]
    if not tiers:
        raise SystemExit("没有读到线宽、线距或过孔参数。用 `fab_rules.py template` 生成空白表，按表填写后再导入。")
    missing = [CN[k] for k in TIER_KEYS if k not in tiers[0]["rules"]["2"]]
    prof = {"kind": "fab-profile", "version": 1, "id": re.sub(r"\W+", "-", p.stem).strip("-") or "user", "name": name or p.stem,
            "retrieved": None, "units": "mm", "sources": [{"id": "user", "title": f"用户提供：{p.name}", "url": None}],
            "notes": ["由用户提供的工艺表导入；档位从便宜到贵排列。" + (f"缺少：{'、'.join(missing)}。" if missing else "")],
            "tiers": tiers, "common": common, "pricing": []}
    return prof, unknown


def template_csv():
    out = ["参数,常规（不加价）,加价,极限,备注"]
    for k in TIER_KEYS:
        out.append(f"{CN[k]},,,,必填；写明单位 mm 或 mil")
    for k, (cn, _) in KEYS.items():
        if k not in TIER_KEYS:
            out.append(f"{cn},,,,")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- 读取设计
def read_kicad_pro(path):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    ds = (d.get("board") or {}).get("design_settings") or {}
    r = ds.get("rules") or {}
    rules = {"clearance": r.get("min_clearance"), "track_width": r.get("min_track_width"), "via_diameter": r.get("min_via_diameter"),
             "via_drill": r.get("min_through_hole_diameter"), "via_annular": r.get("min_via_annular_width"),
             "copper_to_edge": r.get("min_copper_edge_clearance"), "hole_to_hole_via": r.get("min_hole_to_hole"),
             "via_hole_to_track": r.get("min_hole_clearance"), "silk_height": r.get("min_text_height"), "silk_width": r.get("min_text_thickness")}
    classes = [{"name": c.get("name"), "clearance": c.get("clearance"), "track_width": c.get("track_width"),
                "via_diameter": c.get("via_diameter"), "via_drill": c.get("via_drill")} for c in (d.get("net_settings") or {}).get("classes") or []]
    sev = ds.get("rule_severities") or {}
    return {"rules": {k: v for k, v in rules.items() if v is not None}, "netclasses": classes, "severities": sev}


def read_kicad_pcb(path):
    root = sexp(Path(path).read_text(encoding="utf-8"))
    netname = {n[1]: n[2] for n in find(root, "net") if len(n) >= 3}
    lay = first(root, "layers")
    n_cu = sum(1 for L in (lay[1:] if lay else []) if isinstance(L, list) and len(L) > 1 and str(L[1]).endswith(".Cu"))

    def netof(node):
        n = first(node, "net")
        return "" if not n else (n[2] if len(n) >= 3 else netname.get(n[1], n[1]))
    tracks = {}
    for s in find(root, "segment") + find(root, "arc"):
        w = first(s, "width")
        if w:
            w = float(w[1]); e = tracks.setdefault(w, [0, netof(s)]); e[0] += 1
    vias = {}
    for v in find(root, "via"):
        sz, dr = first(v, "size"), first(v, "drill")
        if sz and dr:
            k = (float(sz[1]), float(dr[1])); e = vias.setdefault(k, [0, netof(v)]); e[0] += 1
    pth = []
    for fp in find(root, "footprint") + find(root, "module"):
        for pd in find(fp, "pad"):
            dr = first(pd, "drill")
            if dr and len(pd) > 2 and pd[2] in ("thru_hole", "np_thru_hole"):
                nums = [float(x) for x in dr[1:] if isinstance(x, str) and re.fullmatch(r"[\d.]+", x)]
                size = first(pd, "size")
                if nums:
                    pth.append((min(nums), pd[2], min(float(size[1]), float(size[2])) if size else None))
    actual = {"layers": n_cu or None,
              "tracks": sorted(([w, c, n] for w, (c, n) in tracks.items())),
              "vias": sorted(([d, h, c, n] for (d, h), (c, n) in vias.items()), key=lambda t: (t[1], t[0]))}
    plated = [p for p in pth if p[1] == "thru_hole"]
    if plated:
        actual["pth_drill"] = min(p[0] for p in plated)
        rings = [(p[2] - p[0]) / 2 for p in plated if p[2]]
        if rings:
            actual["pth_annular"] = round(min(rings), 4)
    if any(p[1] == "np_thru_hole" for p in pth):
        actual["npth_drill"] = min(p[0] for p in pth if p[1] == "np_thru_hole")
    return {"actual": actual}


def read_kicad_dru(path):
    text = "(" + Path(path).read_text(encoding="utf-8") + ")"
    out = []
    for r in find(sexp(text), "rule"):
        cons = []
        for c in find(r, "constraint"):
            lim = {x[0]: x[1] for x in c[2:] if isinstance(x, list) and len(x) > 1}
            cons.append({"type": c[1], **{k: to_mm(v) if to_mm(v) is not None else v for k, v in lim.items()}})
        cond = first(r, "condition")
        out.append({"name": r[1], "constraints": cons, "condition": cond[1] if cond else None})
    return {"custom_rules": out}


def read_copper_pack(path):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    tracks = {}
    for n in d.get("nets", []):
        for s in n.get("segs", []):
            e = tracks.setdefault(float(s[5]), [0, n["name"]]); e[0] += 1
    return {"actual": {"layers": len(d.get("layers", [])) or None, "tracks": sorted([w, c, n] for w, (c, n) in tracks.items()), "vias": [],
                       "note": "铜皮数据包里的过孔尺寸不可靠（Gerber 路线为占位值），过孔请另行确认"}}


def read_design(paths):
    out = {"files": [], "rules": {}, "netclasses": [], "severities": {}, "custom_rules": [], "actual": {}}
    for p in paths:
        p = Path(p); suf = p.suffix.lower()
        if suf == ".kicad_pro": part = read_kicad_pro(p)
        elif suf == ".kicad_pcb": part = read_kicad_pcb(p)
        elif suf == ".kicad_dru": part = read_kicad_dru(p)
        elif suf == ".json":
            d = json.loads(p.read_text(encoding="utf-8"))
            if d.get("kind") == "copper-pack": part = read_copper_pack(p)
            elif "net_settings" in d or "board" in d: part = read_kicad_pro(p)
            else: part = {"rules": {match_key(k): to_mm(v) for k, v in d.items() if match_key(k) and to_mm(v) is not None}}
        else:
            rows = table_rows(p)                      # 其他 EDA 导出的规则表：按参数名匹配
            part = {"rules": {match_key(r[0]): to_mm(r[1]) for r in rows if len(r) > 1 and match_key(r[0]) and to_mm(r[1]) is not None}}
        out["files"].append(p.name)
        for k, v in part.items():
            if isinstance(v, dict): out[k].update(v)
            else: out[k] += v
    return out


# ---------------------------------------------------------------- 对照
def via_tier(profile, layers, copper, dia, drill):
    for i, t in enumerate(profile["tiers"]):
        r = tier_rules(profile, t, layers, copper)
        if drill >= r.get("via_drill", 0) - TOL and dia >= r.get("via_diameter", 0) - TOL:
            return i
    return None


def scalar_tier(profile, layers, copper, key, value):
    for i, t in enumerate(profile["tiers"]):
        if value >= tier_rules(profile, t, layers, copper).get(key, 0) - TOL:
            return i
    return None


def check(design, profile, layers=None, copper=1):
    a = design.get("actual") or {}
    layers = layers or a.get("layers") or 2
    tiers = profile["tiers"]
    items, findings = [], []

    def add(key, label, value, ti, where=""):
        items.append({"key": key, "label": label, "value": value, "tier": ti, "where": where})

    # 实际用到的最小值
    if a.get("tracks"):
        w, cnt, net = a["tracks"][0]
        add("track_width", "实际最小线宽", w, scalar_tier(profile, layers, copper, "track_width", w), f"{cnt} 段，例如网络 {net or '（无名）'}")
    for dia, drill, cnt, net in a.get("vias") or []:
        add("via", f"过孔 {drill:g}/{dia:g}（孔径/外径）", (drill, dia), via_tier(profile, layers, copper, dia, drill), f"{cnt} 个")
        ring, (mn, rec) = (dia - drill) / 2, common_value(profile, "via_annular")
        if mn is not None and ring < mn - 1e-9:
            findings.append(("P0", f"过孔 {drill:g}/{dia:g} 的单边焊环只有 {ring:.3f} mm，小于工艺下限 {mn} mm", "加大过孔外径"))
        elif rec is not None and ring < rec - 1e-9:
            findings.append(("P2", f"过孔 {drill:g}/{dia:g} 的单边焊环 {ring:.3f} mm，小于建议值 {rec} mm", "外径至少比孔径大 0.2–0.3 mm"))
    # 规则里允许的最小值（规则比实际松，说明以后可能掉进更贵的档）
    rules = dict(design.get("rules") or {})
    ncs = [c for c in design.get("netclasses") or [] if c.get("track_width") or c.get("clearance")]
    eff = {}
    for k in ("track_width", "clearance"):
        vals = [v for v in [rules.get(k)] + [c.get(k) for c in ncs] if v]
        if vals:
            eff[k] = min(vals)
    floor = {k: rules.get(k) for k in ("track_width", "clearance") if rules.get(k)}
    for k in ("track_width", "clearance"):
        if k in eff:
            add(k, f"规则允许的{CN[k]}（网络类与全局下限取小）", eff[k], scalar_tier(profile, layers, copper, k, eff[k]))
    nv = [(c["via_diameter"], c["via_drill"], c["name"]) for c in design.get("netclasses") or [] if c.get("via_diameter") and c.get("via_drill")]
    for dia, drill, name in nv:
        add("via", f"网络类 {name} 的过孔 {drill:g}/{dia:g}", (drill, dia), via_tier(profile, layers, copper, dia, drill))
    # 其余规则逐项与下限、建议值对照
    merged = {**rules, **{k: v for k, v in a.items() if k in KEYS}}
    for k, v in merged.items():
        if k in TIER_KEYS or v is None or k not in KEYS:
            continue
        mn, rec = common_value(profile, k)
        if mn is None:
            continue
        src = "实际" if k in a else "规则"
        if v < mn - 1e-9:
            findings.append(("P0" if src == "实际" else "P1", f"{src}的{CN[k]}为 {v:g} mm，小于工艺下限 {mn:g} mm", f"改到 {rec or mn:g} mm 以上"))
        elif rec and v < rec - 1e-9:
            findings.append(("P3", f"{src}的{CN[k]}为 {v:g} mm，在下限 {mn:g} 与建议值 {rec:g} mm 之间", "有空间时按建议值"))
    # 档位
    worst = None
    for it in items:
        if it["tier"] is None:
            findings.append(("P0", f"{it['label']}超出工艺档案里最贵一档的能力", "加大到至少" + tiers[-1]["name"] + "档的数值，或换板厂"))
        elif worst is None or it["tier"] > worst:
            worst = it["tier"]
    beyond = any(i["tier"] is None for i in items)
    actual_items = [i for i in items if i["label"].startswith(("实际", "过孔"))]
    act_worst = max((i["tier"] for i in actual_items if i["tier"] is not None), default=None)
    drivers = [i for i in items if i["tier"] == worst and worst] if worst else []
    tips = []
    if worst:
        prev = tier_rules(profile, tiers[worst - 1], layers, copper)
        for it in drivers:
            if it["key"] == "via":
                tips.append(f"{it['label']}：改成不小于 {prev['via_drill']:g}/{prev['via_diameter']:g} 可回到「{tiers[worst - 1]['name']}」档")
            else:
                tips.append(f"{it['label']} {it['value']:g} mm：改到 ≥ {prev[it['key']]:g} mm 可回到「{tiers[worst - 1]['name']}」档")
    if act_worst is not None and worst is not None and act_worst < worst:
        findings.append(("P2", f"板上实际用到的尺寸落在「{tiers[act_worst]['name']}」档，但规则允许到「{tiers[worst]['name']}」档",
                         "把规则下限收紧到实际需要的数值，避免以后改板时不知不觉掉进更贵的档"))
    # 网络类自洽
    for c in design.get("netclasses") or []:
        if c.get("via_diameter") and c.get("via_drill") and c["via_diameter"] - c["via_drill"] < 0.2 - 1e-9:
            findings.append(("P2", f"网络类 {c['name']} 的过孔外径只比孔径大 {c['via_diameter'] - c['via_drill']:.2f} mm", "外径至少比孔径大 0.2 mm"))
        for k in ("track_width", "clearance"):
            if c.get(k) and floor.get(k) and c[k] < floor[k] - 1e-9:
                findings.append(("P1", f"网络类 {c['name']} 的{CN[k]} {c[k]:g} mm 小于全局下限 {floor[k]:g} mm，两条规则互相矛盾", "改网络类或改全局下限，让二者一致"))
    sev = design.get("severities") or {}
    quiet = [k for k in ("track_dangling", "via_dangling", "hole_to_hole", "isolated_copper", "copper_sliver", "net_conflict", "connection_width") if sev.get(k) in ("warning", "ignore")]
    if quiet:
        findings.append(("P3", "这些检查项在工程里不是「错误」级：" + "、".join(quiet), "交付前把悬空线头、悬空过孔、孔间距、孤立铜至少当作必须清零的项目来看"))
    for k in ("track_width", "clearance"):
        if k in rules and rules[k] == 0:
            findings.append(("P2", f"全局{CN[k]}下限为 0，等于没有设", "按目标档位填入下限"))
    if not (a.get("tracks") or eff):
        findings.append(("P1", "没有读到线宽或线距", "提供 .kicad_pro 和 .kicad_pcb，或导出规则表"))
    order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    findings.sort(key=lambda f: order[f[0]])
    return {"profile": profile["name"], "retrieved": profile.get("retrieved"), "layers": layers, "copper_oz": copper,
            "tier": None if (worst is None or beyond) else tiers[worst]["id"],
            "tier_name": "超出能力" if beyond else (None if worst is None else tiers[worst]["name"]),
            "tier_cost": "有项目超出这份工艺档案的能力，见下面的问题" if beyond else (None if worst is None else tiers[worst].get("cost", "")),
            "actual_tier_name": None if act_worst is None else tiers[act_worst]["name"],
            "items": [{**i, "tier_name": None if i["tier"] is None else tiers[i["tier"]]["name"]} for i in items],
            "drivers": [i["label"] for i in drivers], "tips": tips,
            "findings": [{"sev": s, "title": t, "advice": adv} for s, t, adv in findings]}


def report_md(rep, profile):
    L = [f"# 设计规则与工艺对照", "", f"- 工艺档案：{rep['profile']}（检索日期 {rep['retrieved'] or '未注明'}）", f"- 按 {rep['layers']} 层、{rep['copper_oz']} oz 铜对照",
         f"- **价格档位：{rep['tier_name'] or '无法判断'}**" + (f" — {rep['tier_cost']}" if rep.get("tier_cost") else "")]
    if rep["drivers"] and rep["tier"] != profile["tiers"][0]["id"]:
        L.append(f"- 决定档位的参数：{'；'.join(rep['drivers'])}")
    for t in rep["tips"]:
        L.append(f"- 降档办法：{t}")
    L += ["", "| 项目 | 数值 | 落在的档位 | 说明 |", "|---|---|---|---|"]
    for i in rep["items"]:
        v = i["value"]
        v = f"{v[0]:g}/{v[1]:g} mm" if isinstance(v, tuple) else f"{v:g} mm"
        L.append(f"| {i['label']} | {v} | {i['tier_name'] or '超出能力'} | {i['where']} |")
    L += ["", "## 问题", ""]
    L += [f"- **{f['sev']}** {f['title']}。{f['advice']}。" for f in rep["findings"]] or ["- 没有发现问题。"]
    L += ["", "价格和工艺能力会调整，下单前以板厂下单系统的实时审核和报价为准。", ""]
    return "\n".join(L)


# ---------------------------------------------------------------- 展示与生成
def show_md(profile, layers=None):
    L = [f"# {profile['name']}", "", f"检索日期：{profile.get('retrieved') or '未注明'}", ""]
    for key, title in (("2", "1–2 层"), ("multi", "4 层及以上")):
        if layers and lk(layers) != key:
            continue
        L += [f"## 价格档位（{title}）", "", "| 档位 | 线宽 | 线距 | 过孔 孔径/外径 | 成本 |", "|---|---|---|---|---|"]
        for t in profile["tiers"]:
            r = t["rules"].get(key) or {}
            L.append(f"| {t['name']} | {r.get('track_width', '—')} | {r.get('clearance', '—')} | {r.get('via_drill', '—')}/{r.get('via_diameter', '—')} | {t.get('cost', '')} |")
        L.append("")
    conds = [f"- {t['name']}：{'；'.join(t['conditions'])}" for t in profile["tiers"] if t.get("conditions")]
    if conds:
        L += ["档位的附加条件：", ""] + conds + [""]
    if profile.get("common"):
        L += ["## 其余下限（各档相同）", "", "| 项目 | 下限 mm | 建议 mm | 备注 |", "|---|---|---|---|"]
        for k, c in profile["common"].items():
            c = c if isinstance(c, dict) else {"value": c}
            L.append(f"| {CN.get(k, k)} | {c.get('value', '')} | {c.get('rec', '')} | {c.get('note', '')} |")
        L.append("")
    if profile.get("pricing"):
        L += ["## 价格参考", "", "| 项目 | 价格 | 日期 | 备注 |", "|---|---|---|---|"]
        for q in profile["pricing"]:
            val = "—" if q.get("value") is None else f"{q['value']} {q.get('unit', '')}"
            L.append(f"| {q['item']} | {val} | {q.get('as_of', '')} | {q.get('note', '')} |")
        L.append("")
    if profile.get("options"):
        L += ["## 可选项", ""] + [f"- {k}：{json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v}" for k, v in profile["options"].items()] + [""]
    L += ["## 说明", ""] + [f"- {n}" for n in profile.get("notes", [])]
    src = [f"- [{s['title']}]({s['url']})" if s.get("url") else f"- {s['title']}" for s in profile.get("sources", [])]
    if src:
        L += ["", "## 来源", ""] + src
    return "\n".join(L) + "\n"


def emit(profile, tier_id, layers, copper=1, margin=0.0):
    """按档位生成规则。margin：在工艺下限上再加的余量（mm），用于线宽、线距。"""
    tier = next((t for t in profile["tiers"] if t["id"] == tier_id or t["name"] == tier_id), None)
    if tier is None:
        raise SystemExit(f"没有档位 {tier_id}；可选：{', '.join(t['id'] for t in profile['tiers'])}")
    r = tier_rules(profile, tier, layers, copper)
    cv = lambda k, d=None: (common_value(profile, k)[1] or common_value(profile, k)[0] or d)
    tw, cl = round(r["track_width"] + margin, 3), round(r["clearance"] + margin, 3)
    ring = common_value(profile, "via_annular")[0] or 0.05
    head = f"# {profile['name']} · {tier['name']}档 · {layers} 层 · {copper} oz（由 fab_rules.py 生成，检索日期 {profile.get('retrieved')}）\n# 这些是板厂下限。电气要求（电流、阻抗、高压间距）另写规则，并且只能比这里更严。\n"
    rules = [("线宽下限", f"(constraint track_width (min {tw}mm))", None),
             ("线距下限", f"(constraint clearance (min {cl}mm))", None),
             ("过孔外径与孔径", f"(constraint via_diameter (min {r['via_diameter']}mm))\n  (constraint hole_size (min {r['via_drill']}mm))", "A.Type == 'Via'"),
             ("过孔焊环", f"(constraint annular_width (min {ring}mm))", "A.Type == 'Via'")]
    opt = [("pth_annular", "插件孔焊环", "annular_width", "A.Type == 'Pad' && A.Pad_Type == 'Through-hole'"),
           ("copper_to_edge", "铜到板边", "edge_clearance", None), ("hole_to_hole_via", "孔到孔", "hole_to_hole", None),
           ("via_hole_to_track", "孔到铜", "hole_clearance", None), ("silk_height", "丝印字高", "text_height", None), ("silk_width", "丝印线宽", "text_thickness", None)]
    for k, name, cons, cond in opt:
        v = cv(k)
        if v:
            rules.append((name, f"(constraint {cons} (min {v}mm))", cond))
    dru = head + "(version 1)\n\n" + "\n".join(
        f'(rule "板厂：{n}"\n  {c}' + (f'\n  (condition "{cond}")' if cond else "") + ")\n" for n, c, cond in rules)
    sig_w, sig_c = max(tw, 0.15 if tier["id"] != "extreme" else tw), max(cl, 0.15 if tier["id"] != "extreme" else cl)
    vd, vh = r["via_diameter"], r["via_drill"]
    classes = [
        {"name": "Default（信号）", "track_width": sig_w, "clearance": sig_c, "via_diameter": max(vd, vh + 0.25), "via_drill": vh, "note": "日常信号；密集处可局部用到下限"},
        {"name": "Power（电源）", "track_width": max(0.4, sig_w), "clearance": sig_c, "via_diameter": max(0.6, vd), "via_drill": max(0.3, vh), "note": "线宽按电流核算（IPC-2221），这里只是起点"},
        {"name": "RF（射频）", "track_width": None, "clearance": max(sig_c, 0.2), "via_diameter": max(vd, vh + 0.25), "via_drill": vh, "note": "线宽由叠层按 50 Ω 计算后填入"},
        {"name": "Fine（细间距扇出）", "track_width": tw, "clearance": cl, "via_diameter": vd, "via_drill": vh, "note": "只用在 BGA / QFN 扇出区域，用区域规则限定范围"}]
    md = [f"# 网络类建议：{profile['name']} · {tier['name']}档 · {layers} 层", "", f"板厂下限：线宽 {r['track_width']} / 线距 {r['clearance']} / 过孔 {vh}/{vd} mm" + (f"；已加余量 {margin} mm" if margin else ""), "",
          "| 网络类 | 线宽 | 线距 | 过孔 孔径/外径 | 说明 |", "|---|---|---|---|---|"]
    for c in classes:
        md.append(f"| {c['name']} | {c['track_width'] if c['track_width'] else '按阻抗'} | {c['clearance']} | {c['via_drill']}/{round(c['via_diameter'], 3)} | {c['note']} |")
    md += ["", "在嘉立创 EDA 里：设计 → 设计规则，把上表填进对应的规则和网络类。", "在 KiCad 里：电路板设置 → 网络类填上表；自定义规则里粘贴 `fab.kicad_dru` 的内容，并用 KiCad 的语法检查确认。", ""]
    return dru, "\n".join(md), classes


# ---------------------------------------------------------------- 命令行
def main(argv=None):
    ap = argparse.ArgumentParser(description="设计规则与板厂工艺：读取、对照、生成")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("show"); s.add_argument("--profile"); s.add_argument("--layers", type=int)
    sub.add_parser("template")
    s = sub.add_parser("import"); s.add_argument("file"); s.add_argument("-o", "--output"); s.add_argument("--name")
    s = sub.add_parser("read"); s.add_argument("files", nargs="+")
    s = sub.add_parser("check"); s.add_argument("files", nargs="+"); s.add_argument("--profile"); s.add_argument("--layers", type=int)
    s.add_argument("--copper", type=float, default=1); s.add_argument("-o", "--output"); s.add_argument("--json")
    s = sub.add_parser("emit"); s.add_argument("--profile"); s.add_argument("--tier", default="standard"); s.add_argument("--layers", type=int, default=4)
    s.add_argument("--copper", type=float, default=1); s.add_argument("--margin", type=float, default=0.0); s.add_argument("-o", "--output", default=".")
    a = ap.parse_args(argv)
    if a.cmd == "show":
        print(show_md(load_profile(a.profile), a.layers))
    elif a.cmd == "template":
        sys.stdout.write(template_csv())
    elif a.cmd == "import":
        prof, unknown = import_profile(a.file, a.name)
        out = Path(a.output or Path(a.file).with_suffix(".fab.json"))
        out.write_text(json.dumps(prof, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"已写入 {out}：{len(prof['tiers'])} 个档位，{len(prof['common'])} 项其余下限")
        if unknown:
            print("没有认出来的行（请核对，必要时改用模板里的参数名）：")
            for u in unknown: print("  " + u)
    elif a.cmd == "read":
        print(json.dumps(read_design(a.files), ensure_ascii=False, indent=1))
    elif a.cmd == "check":
        prof = load_profile(a.profile)
        rep = check(read_design(a.files), prof, a.layers, a.copper)
        md = report_md(rep, prof)
        if a.output: Path(a.output).write_text(md, encoding="utf-8")
        if a.json: Path(a.json).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
        print(md)
        return 1 if any(f["sev"] == "P0" for f in rep["findings"]) else 0
    elif a.cmd == "emit":
        prof = load_profile(a.profile)
        dru, md, _ = emit(prof, a.tier, a.layers, a.copper, a.margin)
        out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
        (out / "fab.kicad_dru").write_text(dru, encoding="utf-8")
        (out / "netclasses.md").write_text(md, encoding="utf-8")
        print(f"已写入 {out / 'fab.kicad_dru'} 和 {out / 'netclasses.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
