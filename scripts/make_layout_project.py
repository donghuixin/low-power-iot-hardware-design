#!/usr/bin/env python3
"""校验布局规划器的项目 JSON，并生成该项目专用的单文件页面。

用法:
    python make_layout_project.py project.json [-o out.html]
    python make_layout_project.py project.json --check      # 只校验，不输出
    python make_layout_project.py project.json --verifier   # 生成布局布线验证器页面（布线前估计）
    python make_layout_project.py project.json --verifier --copper copper-pack.json   # 布线后验证

项目 JSON 的格式见 references/12-layout-planner.md，示例见 assets/layout-project-example.json。
校验规则与页面内 model.js 的 validate() 一致。只依赖 Python 标准库。
"""
import argparse
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "assets" / "layout-planner.html"
VERIFIER_TEMPLATE = ROOT / "assets" / "layout-verifier.html"

ROLES = {"soc_rf", "mcu", "rf_module", "antenna", "imu", "magnetometer", "temp_humidity", "barometer",
         "microphone", "optical", "dcdc", "ldo", "charger", "inductor", "battery", "connector", "button",
         "led", "flash", "motor_driver", "other"}
SAT_KINDS = {"decoupling", "bulk", "crystal", "xtal_load", "rf_match", "dcdc_inductor", "dcdc_cap",
             "series_r", "pull", "esd", "divider"}
NET_CLASSES = {"rf", "power", "switch_node", "high_speed", "analog", "clock", "bus", "misc"}
PIN_SIDES = {"N", "E", "S", "W", "C"}


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _pos(v):
    return _num(v) and v > 0


def _int_ge1(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 1


def _check_placed(pl, at, err):
    if pl is None:
        return
    if not isinstance(pl, dict):
        err(at, "必须是对象或 null")
        return
    if not _num(pl.get("x")) or not _num(pl.get("y")):
        err(at, "需要数值 x、y")
    if "rot" in pl and pl["rot"] not in (0, 90, 180, 270):
        err(f"{at}.rot", "必须是 0、90、180 或 270")
    if "side" in pl and pl["side"] not in ("top", "bottom"):
        err(f"{at}.side", '必须是 "top" 或 "bottom"')


def validate(p):
    """返回 [(路径, 说明)]；空列表表示通过。"""
    errs = []

    def err(path, msg):
        errs.append((path, msg))

    if not isinstance(p, dict):
        err("", "项目数据必须是 JSON 对象")
        return errs
    if p.get("version") != 1:
        err("version", "必须为 1")
    if not isinstance(p.get("name"), str) or not p["name"].strip():
        err("name", "必须是非空字符串")

    b = p.get("board")
    if not isinstance(b, dict):
        err("board", "缺少 board")
    else:
        o = b.get("outline")
        if not isinstance(o, dict):
            err("board.outline", "缺少板框")
        elif o.get("type") == "rect":
            if not _pos(o.get("w")):
                err("board.outline.w", "必须为正数")
            if not _pos(o.get("h")):
                err("board.outline.h", "必须为正数")
            if "corner_r" in o and not (_num(o["corner_r"]) and o["corner_r"] >= 0):
                err("board.outline.corner_r", "必须为非负数")
        elif o.get("type") == "circle":
            if not _pos(o.get("d")):
                err("board.outline.d", "必须为正数")
        elif o.get("type") == "polygon":
            pts = o.get("points")
            if not isinstance(pts, list) or len(pts) < 3:
                err("board.outline.points", "至少需要 3 个顶点")
            else:
                for i, q in enumerate(pts):
                    if not (isinstance(q, list) and len(q) == 2 and _num(q[0]) and _num(q[1])):
                        err(f"board.outline.points[{i}]", "必须是 [x, y]")
        else:
            err("board.outline.type", "必须是 rect、circle 或 polygon")
        if "layers" in b and b["layers"] not in (1, 2, 4, 6, 8):
            err("board.layers", "必须是 1、2、4、6 或 8")
        for k in ("thickness", "track", "space", "via_d"):
            if k in b and not _pos(b[k]):
                err(f"board.{k}", "必须为正数")
        if "two_sided" in b and not isinstance(b["two_sided"], bool):
            err("board.two_sided", "必须是 true 或 false")
        for i, h in enumerate(b.get("holes") or []):
            if not (isinstance(h, dict) and _num(h.get("x")) and _num(h.get("y")) and _pos(h.get("d"))):
                err(f"board.holes[{i}]", "需要 x、y 和正数 d")
        for i, k in enumerate(b.get("keepouts") or []):
            if not (isinstance(k, dict) and _num(k.get("x")) and _num(k.get("y")) and _pos(k.get("w")) and _pos(k.get("h"))):
                err(f"board.keepouts[{i}]", "需要 x、y 和正数 w、h")

    refs, pins_of = set(), {}
    parts = p.get("parts")
    if not isinstance(parts, list) or not parts:
        err("parts", "至少需要一个主器件")
        parts = []
    for i, pt in enumerate(parts):
        at = f"parts[{i}]"
        if not isinstance(pt, dict):
            err(at, "必须是对象")
            continue
        ref = pt.get("ref")
        if not isinstance(ref, str) or not ref:
            err(f"{at}.ref", "必须是非空字符串")
        elif ref in refs:
            err(f"{at}.ref", f"位号 {ref} 重复")
        else:
            refs.add(ref)
        if pt.get("role") not in ROLES:
            err(f"{at}.role", f'未知角色 "{pt.get("role")}"')
        if not _pos(pt.get("w")):
            err(f"{at}.w", "必须为正数")
        if not _pos(pt.get("h")):
            err(f"{at}.h", "必须为正数")
        if "z" in pt and not _pos(pt["z"]):
            err(f"{at}.z", "必须为正数")
        if "sides" in pt and (not isinstance(pt["sides"], list) or not pt["sides"] or any(s not in ("top", "bottom") for s in pt["sides"])):
            err(f"{at}.sides", '只能包含 "top" 或 "bottom"')
        ids = set()
        if not isinstance(pt.get("pins"), list):
            err(f"{at}.pins", "必须是数组")
        else:
            for j, pn in enumerate(pt["pins"]):
                pa = f"{at}.pins[{j}]"
                pid = pn.get("id") if isinstance(pn, dict) else None
                if not isinstance(pid, str) or not pid:
                    err(f"{pa}.id", "必须是非空字符串")
                elif pid in ids:
                    err(f"{pa}.id", f"引脚组 {pid} 重复")
                else:
                    ids.add(pid)
                side = pn.get("side") if isinstance(pn, dict) else None
                if side not in PIN_SIDES:
                    err(f"{pa}.side", "必须是 N、E、S、W 或 C")
                if side != "C" and not (isinstance(pn, dict) and _num(pn.get("pos")) and 0 <= pn["pos"] <= 1):
                    err(f"{pa}.pos", "必须在 0 到 1 之间")
                if isinstance(pn, dict) and "count" in pn and not _int_ge1(pn["count"]):
                    err(f"{pa}.count", "必须是正整数")
        if isinstance(ref, str) and ref:
            pins_of[ref] = ids
        if "edge_face" in pt and pt["edge_face"] not in ("N", "E", "S", "W"):
            err(f"{at}.edge_face", "必须是 N、E、S 或 W")
        _check_placed(pt.get("placed"), f"{at}.placed", err)

    names = set()
    for i, n in enumerate(p.get("nets") or []):
        at = f"nets[{i}]"
        if not isinstance(n, dict):
            err(at, "必须是对象")
            continue
        name = n.get("name")
        if not isinstance(name, str) or not name:
            err(f"{at}.name", "必须是非空字符串")
        elif name in names:
            err(f"{at}.name", f"网络 {name} 重复")
        else:
            names.add(name)
        if n.get("class") not in NET_CLASSES:
            err(f"{at}.class", f'未知类别 "{n.get("class")}"')
        if "width" in n and not _int_ge1(n["width"]):
            err(f"{at}.width", "必须是正整数")
        if "max_len" in n and not _pos(n["max_len"]):
            err(f"{at}.max_len", "必须为正数")
        pl = n.get("pins")
        if not isinstance(pl, list) or len(pl) < 2:
            err(f"{at}.pins", "至少连接两个引脚组")
        else:
            for j, q in enumerate(pl):
                if not (isinstance(q, list) and len(q) == 2):
                    err(f"{at}.pins[{j}]", "必须是 [位号, 引脚组]")
                elif q[0] not in pins_of:
                    err(f"{at}.pins[{j}]", f"位号 {q[0]} 不存在")
                elif q[1] not in pins_of[q[0]]:
                    err(f"{at}.pins[{j}]", f"{q[0]} 没有引脚组 {q[1]}")

    sats = p.get("satellites") or []
    sat_refs = {s.get("ref") for s in sats if isinstance(s, dict) and isinstance(s.get("ref"), str)}
    seen = set()
    for i, s in enumerate(sats):
        at = f"satellites[{i}]"
        if not isinstance(s, dict):
            err(at, "必须是对象")
            continue
        ref = s.get("ref")
        if not isinstance(ref, str) or not ref:
            err(f"{at}.ref", "必须是非空字符串")
        elif ref in refs or ref in seen:
            err(f"{at}.ref", f"位号 {ref} 重复")
        else:
            seen.add(ref)
        if s.get("kind") not in SAT_KINDS:
            err(f"{at}.kind", f'未知类别 "{s.get("kind")}"')
        par = s.get("parent")
        if not (isinstance(par, list) and len(par) == 2):
            err(f"{at}.parent", "必须是 [位号, 引脚组]")
        elif par[0] not in pins_of:
            err(f"{at}.parent", f"位号 {par[0]} 不存在")
        elif par[1] not in pins_of[par[0]]:
            err(f"{at}.parent", f"{par[0]} 没有引脚组 {par[1]}")
        if not _pos(s.get("w")):
            err(f"{at}.w", "必须为正数")
        if not _pos(s.get("h")):
            err(f"{at}.h", "必须为正数")
        if "max_dist" in s and not _pos(s["max_dist"]):
            err(f"{at}.max_dist", "必须为正数")
        if "near" in s and (s["near"] == ref or s["near"] not in sat_refs):
            err(f"{at}.near", f'卫星 {s["near"]} 不存在')
        _check_placed(s.get("placed"), f"{at}.placed", err)

    rules = p.get("rules", [])
    if not isinstance(rules, list):
        err("rules", "必须是数组")
    else:
        for i, r in enumerate(rules):
            if not isinstance(r, dict) or not (isinstance(r.get("id"), str) or isinstance(r.get("type"), str)):
                err(f"rules[{i}]", "需要 id（覆盖默认规则）或 type（新增规则）")
    return errs


def inject(template_html, project, node="project-data", indent=1):
    """把数据写入模板中的 <script type="application/json" id="<node>"> 节点。"""
    data = json.dumps(project, ensure_ascii=False, indent=indent, separators=None if indent else (",", ":")).replace("</", "<\\/")
    pat = re.compile(r'(<script type="application/json" id="' + node + r'">)(.*?)(</script>)', re.S)
    if not pat.search(template_html):
        raise SystemExit(f"模板中找不到 {node} 节点，请先运行 scripts/build_layout_planner.py / build_layout_verifier.py")
    return pat.sub(lambda m: m.group(1) + data + m.group(3), template_html, count=1)


def main():
    ap = argparse.ArgumentParser(description="校验布局规划器项目 JSON，并生成该项目专用的页面")
    ap.add_argument("project", help="项目 JSON 路径")
    ap.add_argument("-o", "--output", help="输出 HTML 路径（默认：<项目文件名>-layout.html，与项目 JSON 同目录）")
    ap.add_argument("--check", action="store_true", help="只校验，不生成页面")
    ap.add_argument("--template", help="页面模板（默认 assets/layout-planner.html；加 --verifier 时为 assets/layout-verifier.html）")
    ap.add_argument("--verifier", action="store_true", help="生成布局布线验证器页面（<项目>-verify.html），而不是布局规划器")
    ap.add_argument("--copper", help="铜皮数据包（scripts/extract_copper.py 的输出），给出时验证器直接进入布线后验证")
    args = ap.parse_args()
    if args.copper and not args.verifier:
        ap.error("--copper 需要和 --verifier 一起用")

    src = Path(args.project)
    try:
        project = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"无法读取 {src}: {e}", file=sys.stderr)
        return 2
    errs = validate(project)
    if errs:
        print(f"{src} 有 {len(errs)} 处问题：", file=sys.stderr)
        for path, msg in errs:
            print(f"  {path or '(根)'}: {msg}", file=sys.stderr)
        return 1
    n_parts = len(project["parts"])
    n_sats = len(project.get("satellites") or [])
    n_nets = len(project.get("nets") or [])
    print(f"校验通过：{project['name']}，{n_parts} 个主器件、{n_sats} 个卫星器件、{n_nets} 组网络")
    if args.check:
        return 0
    suffix = "-verify.html" if args.verifier else "-layout.html"
    out = Path(args.output) if args.output else src.with_name(src.stem + suffix)
    template = Path(args.template) if args.template else (VERIFIER_TEMPLATE if args.verifier else TEMPLATE)
    html = inject(template.read_text(encoding="utf-8"), project)
    if args.copper:
        pack = json.loads(Path(args.copper).read_text(encoding="utf-8"))
        if pack.get("kind") != "copper-pack":
            print(f"{args.copper} 不是铜皮数据包（kind 应为 copper-pack）", file=sys.stderr)
            return 2
        html = inject(html, pack, "copper-data", indent=None)
    out.write_text(html, encoding="utf-8")
    print(f"已生成 {out}（{out.stat().st_size / 1024:.0f} KB），双击即可在浏览器中打开")
    return 0


if __name__ == "__main__":
    sys.exit(main())
