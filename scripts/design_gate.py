#!/usr/bin/env python3
"""设计确认闸门：布局、布线之前必须拿到的规范性设计信息，以及用户逐级确认的记录。

本 skill 不接受“一句话完成整块板”的用法。布局前必须确认 G0 需求与 G1 机械约束；
布线前必须确认 G0–G4（分区布局已经用户看过截图、布局检查无 P0、布线优先级与
约束已定）；交付前必须确认 G5（布线检查和 DRC 结果 + 用户看过布线截图）。

    python design_gate.py init [-o design-brief.json]          # 生成待填模板
    python design_gate.py status design-brief.json              # 各闸门缺什么、待确认还是已确认
    python design_gate.py summary design-brief.json G2          # 给用户看的摘要 + 确认码
    python design_gate.py confirm design-brief.json G2 --quote "确认 G2-3fa9c1"
    python design_gate.py require design-brief.json --stage place|route|deliver

确认规则：
  - 只有用户能确认。AI 必须把 summary 的内容和确认码发给用户，等用户回复包含确认码的原话，
    再用 --quote 原样记下；不能自己替用户确认，也不能在用户没回复时继续。
  - 每个闸门的确认码由它和前面所有闸门的内容算出。前面任何内容被改，后面的确认自动失效。
  - 在终端里也可以 --tty，由用户亲手输入确认码。
  - require 不通过时退出码为 3；route_fix.py、route_lint.py gate 和 EDA 扩展的写回都会调用它。
"""
from __future__ import annotations

import argparse
import copy
import datetime as _dt
import hashlib
import json
import re
import sys
from pathlib import Path

KIND = "lpiot-design-brief"
GATES = ["G0", "G1", "G2", "G3", "G4", "G5"]
SECTION = {
    "G0": "G0_requirements",
    "G1": "G1_mechanical",
    "G2": "G2_partition",
    "G3": "G3_layout_check",
    "G4": "G4_routing_plan",
    "G5": "G5_acceptance",
}
TITLE = {
    "G0": "需求与工艺",
    "G1": "板框、外壳与固定位置",
    "G2": "功能分区与布局评审",
    "G3": "布局检查",
    "G4": "布线规划：叠层、优先级、约束、验收标准",
    "G5": "交付验收",
}
STAGES = {"place": ["G0", "G1"], "route": ["G0", "G1", "G2", "G3", "G4"], "deliver": GATES}
STAGE_NAME = {"place": "开始摆放器件", "route": "开始布线（含自动布线、自动修复、写入 EDA）", "deliver": "宣布完成 / 交付打样"}

PLACEHOLDER = re.compile(r"^\s*(|待填|待定|tbd|todo|\?+|？+|xx+|n/?a|未知|不知道|随便|都行|你定|你看着办)\s*$", re.I)


def template():
    """待填模板。所有“待填”都必须由用户给出或确认。"""
    return {
        "kind": KIND,
        "version": 1,
        "project": {"name": "待填", "owner": "待填"},
        "roles": {},
        "G0_requirements": {
            "function": "待填：这块板做什么、给谁用、在什么场景下用（不少于一句完整的话）",
            "power": {"source": "待填：如 CR2032 / 1S 锂电 500 mAh / USB 5 V", "peak_ma": "待填", "sleep_ua": "待填"},
            "wireless": "待填：BLE / Wi-Fi / LoRa / 无",
            "environment": "待填：温度、佩戴/固定方式、防水等",
            "fab": {"layers": "待填", "thickness_mm": "待填", "fab": "待填：如 JLC", "tier": "待填：standard / 加价档"},
        },
        "G1_mechanical": {
            "outline": {"shape": "待填：rect / round / dxf", "w_mm": "待填", "h_mm": "待填", "file": ""},
            "enclosure": {"material": "待填：塑料 / 金属 / 无外壳", "max_height_top_mm": "待填", "max_height_bottom_mm": "待填"},
            "holes": "待填：固定孔列表 [{x_mm,y_mm,d_mm}]，没有就写 无",
            "fixed": "待填：位置被外壳决定的器件 [{ref, what, edge: left/right/top/bottom, along_mm, tol_mm, side, reason}]",
            "keepouts": "待填：禁布区 [{rect_mm:[x0,y0,x1,y1] 或 rect_frac, reason}]，没有就写 无",
        },
        "G2_partition": {
            "blocks": "待填：功能块 [{name, parts:[位号…], region, why}]，region 可写 left/right/top/bottom/top-left… 或 [fx0,fy0,fx1,fy1]（板框比例，y 向上）",
            "signal_flow": "待填：电源和信号从哪里进、经过哪些块、到哪里去，例如 USB(左) → 充电 → LDO → MCU(中) → 射频与天线(右)",
            "layout_review": {"screenshot": "待填：用户看过并认可的布局截图文件名", "notes": ""},
        },
        "G3_layout_check": {
            "report": "待填：layout_lint.py 生成的 JSON 报告路径",
            "accepted_exceptions": "待填：用户同意保留的 P1/P2 问题 [{rule, refs, why}]，没有就写 无",
        },
        "G4_routing_plan": {
            "stackup": "待填：每层用途 [{layer, use}]，例如 B.Cu 完整地平面",
            "priorities": "待填：布线顺序 [{tier, class, nets:[…], method: 手工/工具辅助, rules}]，先射频、晶振、开关回路、高速差分",
            "diff_pairs": "待填：差分对 [{p, n, impedance_ohm, skew_mm}]，没有就写 无",
            "power_nets": "待填：电源网络 [{net, current_ma, width_mm}]",
            "acceptance": {"route_lint_min_score": 80, "drc_zero": True, "human_review": True},
        },
        "G5_acceptance": {
            "route_report": "待填：route_lint.py lint --json 的报告路径",
            "drc_errors": "待填：EDA 原生 DRC 的错误数",
            "screenshots": "待填：用户看过的布线截图 [文件名…]",
        },
        "confirmations": {},
    }


# ------------------------------------------------------------------ 取值与校验
def get(d, path):
    cur = d
    for k in path.split("."):
        if not isinstance(cur, dict) or k not in cur:
            return None
        cur = cur[k]
    return cur


def is_blank(v):
    return v is None or (isinstance(v, str) and (PLACEHOLDER.match(v) or v.strip().startswith("待填")))


def is_none_word(v):
    return isinstance(v, str) and v.strip() in ("无", "没有", "none", "None", "NONE")


def num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.strip())
        except ValueError:
            return None
    return None


def req_text(path, label, min_len=1):
    def chk(b, base=None):
        v = get(b, path)
        if is_blank(v) or not isinstance(v, str) or len(v.strip()) < min_len:
            return [f"{label}（{path}）" + (f"：至少 {min_len} 个字，说清楚" if min_len > 1 else "")]
        return []
    return chk


def req_num(path, label, lo=None):
    def chk(b, base=None):
        v = num(get(b, path))
        if v is None:
            return [f"{label}（{path}）：要一个数字"]
        if lo is not None and v < lo:
            return [f"{label}（{path}）：不能小于 {lo}"]
        return []
    return chk


def req_list(path, label, min_items=1, item_keys=(), allow_none=False):
    def chk(b, base=None):
        v = get(b, path)
        if allow_none and (is_none_word(v) or v == []):
            return []
        if not isinstance(v, list) or len(v) < min_items:
            return [f"{label}（{path}）：至少 {min_items} 项" + ("；确实没有就写 无" if allow_none else "")]
        out = []
        for i, it in enumerate(v):
            if item_keys and not isinstance(it, dict):
                out.append(f"{label} 第 {i + 1} 项应写成对象，含 {'、'.join(item_keys)}")
                continue
            for k in item_keys:
                x = it.get(k)
                if is_blank(x) if not isinstance(x, list) else not x:
                    out.append(f"{label} 第 {i + 1} 项缺 {k}")
        return out
    return chk


def req_outline(b, base=None):
    o = get(b, "G1_mechanical.outline") or {}
    f = o.get("file")
    if isinstance(f, str) and f.strip() and not is_blank(f):
        return []
    if num(o.get("w_mm")) and num(o.get("h_mm")):
        return []
    return ["板框（G1_mechanical.outline）：给出外形尺寸 w_mm × h_mm，或外壳图纸导出的 DXF 文件"]


def req_fixed_edges(b, base=None):
    v = get(b, "G1_mechanical.fixed")
    out = []
    if isinstance(v, list):
        for i, it in enumerate(v):
            if isinstance(it, dict) and it.get("edge") not in (None, "left", "right", "top", "bottom", "inner"):
                out.append(f"固定件第 {i + 1} 项 edge 只能是 left/right/top/bottom/inner")
    return out


def req_stackup_layers(b, base=None):
    st, n = get(b, "G4_routing_plan.stackup"), num(get(b, "G0_requirements.fab.layers"))
    if isinstance(st, list) and n and len(st) < int(n):
        return [f"叠层（G4_routing_plan.stackup）只写了 {len(st)} 层，但工艺是 {int(n)} 层板，每层都要写用途"]
    return []


def req_min_score(b, base=None):
    v = num(get(b, "G4_routing_plan.acceptance.route_lint_min_score"))
    if v is None or v < 75:
        return ["验收分数（G4_routing_plan.acceptance.route_lint_min_score）：不低于 75"]
    return []


def _load_report(b, key_path, key_result, base):
    """报告可以是文件路径（命令行），也可以直接内嵌（EDA 扩展写入的 result 对象）。返回 (报告, 错误列表)。"""
    emb = get(b, key_result)
    if isinstance(emb, dict):
        return emb, []
    p = get(b, key_path)
    if is_blank(p) or not isinstance(p, str):
        return None, []
    path = Path(p) if base is None or Path(p).is_absolute() else Path(base) / p
    if not path.exists():
        return None, [f"报告 {p} 不存在"]
    try:
        return json.loads(path.read_text(encoding="utf-8")), []
    except Exception:
        return None, [f"报告 {p} 读不出来"]


def req_layout_report(b, base=None):
    rep, err = _load_report(b, "G3_layout_check.report", "G3_layout_check.result", base)
    if err:
        return [e + "：先运行 layout_lint.py --brief … --json <报告>" for e in err]
    if rep is None:
        return ["布局检查报告（G3_layout_check.report）：运行 layout_lint.py --brief design-brief.json --json layout-lint.json，或在扩展“布局”页记录"]
    out = []
    if rep.get("kind") != "lpiot-layout-lint":
        out.append("布局检查报告不是 layout_lint.py / 扩展生成的")
    if rep.get("p0", 1) > 0:
        out.append(f"布局检查还有 {rep.get('p0')} 个 P0：改完布局重新检查")
    if rep.get("brief_hash") != gate_hash(b, "G2"):
        out.append("布局检查报告是按旧的 G0–G2 内容生成的：重新运行 layout_lint.py")
    return out


def req_route_report(b, base=None):
    rep, err = _load_report(b, "G5_acceptance.route_report", "G5_acceptance.route_result", base)
    if err:
        return [e + "：运行 route_lint.py lint 板子 --json <报告>" for e in err]
    if rep is None:
        return ["布线检查报告（G5_acceptance.route_report）：运行 route_lint.py lint 板子 --json route-lint.json，或在扩展里记录"]
    out = []
    score = rep.get("score")
    need = num(get(b, "G4_routing_plan.acceptance.route_lint_min_score")) or 80
    if rep.get("p0", 0) > 0 or rep.get("pass") is False:
        out.append("布线检查有 P0：不能交付")
    if score is None or score < need:
        out.append(f"布线得分 {score} 低于验收线 {need:g}")
    return out


def req_drc_zero(b, base=None):
    v = num(get(b, "G5_acceptance.drc_errors"))
    if v is None:
        return ["DRC 错误数（G5_acceptance.drc_errors）：在 EDA 里跑一次 DRC 填数字"]
    if v > 0 and get(b, "G4_routing_plan.acceptance.drc_zero") is not False:
        return [f"DRC 还有 {int(v)} 个错误"]
    return []


REQUIRE = {
    "G0": [
        req_text("project.name", "项目名"),
        req_text("G0_requirements.function", "产品功能与使用场景", 10),
        req_text("G0_requirements.power.source", "供电方式"),
        req_num("G0_requirements.power.peak_ma", "峰值电流 mA", 0),
        req_text("G0_requirements.wireless", "无线方式（没有写 无）"),
        req_text("G0_requirements.environment", "使用环境"),
        req_num("G0_requirements.fab.layers", "层数", 1),
        req_num("G0_requirements.fab.thickness_mm", "板厚 mm", 0.2),
        req_text("G0_requirements.fab.fab", "板厂"),
    ],
    "G1": [
        req_outline,
        req_text("G1_mechanical.enclosure.material", "外壳材料（没有外壳写 无外壳）"),
        req_num("G1_mechanical.enclosure.max_height_top_mm", "顶面限高 mm", 0),
        req_list("G1_mechanical.holes", "固定孔", allow_none=True),
        req_list("G1_mechanical.fixed", "固定位置的器件（接口、按键、灯、天线、电池、传感器开窗）", 1, ("ref", "edge", "reason")),
        req_fixed_edges,
        req_list("G1_mechanical.keepouts", "禁布区", allow_none=True),
    ],
    "G2": [
        req_list("G2_partition.blocks", "功能块", 2, ("name", "parts", "region")),
        req_text("G2_partition.signal_flow", "信号与电源流向", 10),
        req_text("G2_partition.layout_review.screenshot", "用户看过的布局截图"),
    ],
    "G3": [
        req_layout_report,
        req_list("G3_layout_check.accepted_exceptions", "保留的问题", allow_none=True),
    ],
    "G4": [
        req_list("G4_routing_plan.stackup", "叠层用途", 1, ("layer", "use")),
        req_stackup_layers,
        req_list("G4_routing_plan.priorities", "布线优先级", 1, ("tier", "nets", "method")),
        req_list("G4_routing_plan.diff_pairs", "差分对", allow_none=True),
        req_list("G4_routing_plan.power_nets", "电源网络与电流", 1, ("net", "current_ma")),
        req_min_score,
    ],
    "G5": [
        req_route_report,
        req_drc_zero,
        req_list("G5_acceptance.screenshots", "用户看过的布线截图", 1),
    ],
}


def missing(b, gate, base=None):
    out = []
    for f in REQUIRE[gate]:
        out += f(b, base)
    return out


# ------------------------------------------------------------------ 哈希与确认
def _norm(v):
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
        return int(v)
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_norm(x) for x in v]
    return v


def canonical(v):
    """与扩展 src/core/brief.ts 的 canonical() 一致：键排序、无空格、不转义中文。"""
    return json.dumps(_norm(v), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def gate_hash(b, gate):
    """该闸门及其之前所有闸门（含 project、roles）的内容哈希。"""
    i = GATES.index(gate)
    payload = {"project": b.get("project"), "roles": b.get("roles") or {}}
    for g in GATES[: i + 1]:
        payload[SECTION[g]] = b.get(SECTION[g])
    return hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()


def code_of(b, gate):
    return f"{gate}-{gate_hash(b, gate)[:6]}"


def gate_state(b, gate, base=None):
    """返回 (状态, 细节)。状态：missing / blocked / pending / confirmed / stale。"""
    miss = missing(b, gate, base)
    if miss:
        return "missing", miss
    i = GATES.index(gate)
    for g in GATES[:i]:
        st, _ = gate_state(b, g, base)
        if st != "confirmed":
            return "blocked", [f"先确认 {g}"]
    c = (b.get("confirmations") or {}).get(gate)
    if not c:
        return "pending", [code_of(b, gate)]
    if c.get("hash") != gate_hash(b, gate):
        return "stale", ["确认之后内容被改过，需要重新确认：" + code_of(b, gate)]
    return "confirmed", [c.get("code", "")]


STATE_ZH = {"missing": "缺信息", "blocked": "等前一级", "pending": "待用户确认", "confirmed": "已确认", "stale": "已失效"}


def load(path):
    b = json.loads(Path(path).read_text(encoding="utf-8"))
    if b.get("kind") != KIND:
        raise SystemExit(f"{path} 不是设计确认文件（kind 应为 {KIND}）；用 init 生成模板")
    return b


def save(path, b):
    Path(path).write_text(json.dumps(b, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def pretty(v, ind=0):
    pad = "  " * ind
    if isinstance(v, dict):
        return "\n".join(f"{pad}{k}: " + (("\n" + pretty(x, ind + 1)) if isinstance(x, (dict, list)) and x else str(x)) for k, x in v.items())
    if isinstance(v, list):
        return "\n".join(f"{pad}- " + (json.dumps(x, ensure_ascii=False) if isinstance(x, (dict, list)) else str(x)) for x in v)
    return pad + str(v)


def status_text(b, base=None):
    lines = [f"设计确认状态：{(b.get('project') or {}).get('name', '')}"]
    for g in GATES:
        st, det = gate_state(b, g, base)
        lines.append(f"  {g} {TITLE[g]}：{STATE_ZH[st]}")
        if st in ("missing",):
            lines += [f"      · 缺：{m}" for m in det]
        elif st in ("pending", "stale"):
            lines.append(f"      · 确认码 {det[0].split('：')[-1]}；用 summary 把内容发给用户，等用户回复“确认 {code_of(b, g)}”")
        elif st == "blocked":
            lines.append(f"      · {det[0]}")
    for s, gs in STAGES.items():
        ok = all(gate_state(b, g, base)[0] == "confirmed" for g in gs)
        lines.append(f"  {'✓' if ok else '✗'} {STAGE_NAME[s]}（需要 {'、'.join(gs)}）")
    return "\n".join(lines)


def summary_text(b, gate, base=None):
    st, det = gate_state(b, gate, base)
    head = f"【{gate} {TITLE[gate]}】"
    if st == "missing":
        return head + "还不能确认，缺以下信息（请向用户逐项询问，不要替用户编）：\n" + "\n".join(f"  · {m}" for m in det)
    if st == "blocked":
        return head + det[0]
    body = pretty(b.get(SECTION[gate]))
    if gate == "G0":
        body = pretty(b.get("project")) + "\n" + body
    code = code_of(b, gate)
    return (f"{head}\n{body}\n\n"
            f"请逐项核对上面的内容。全部正确，请回复：确认 {code}\n"
            f"有任何不对或不确定，请直接指出，我改完会重新生成确认码。")


def confirm(b, gate, quote, by="user", base=None):
    st, det = gate_state(b, gate, base)
    if st == "missing":
        raise SystemExit("不能确认：\n" + "\n".join(f"  · {m}" for m in det))
    if st == "blocked":
        raise SystemExit(f"不能确认：{det[0]}")
    code = code_of(b, gate)
    if not quote or code.lower() not in re.sub(r"\s+", "", quote).lower():
        raise SystemExit(f"不能确认：用户的原话里没有确认码 {code}。把 summary 发给用户，等用户自己回复“确认 {code}”。")
    b.setdefault("confirmations", {})[gate] = {
        "code": code, "hash": gate_hash(b, gate), "quote": quote.strip()[:500], "by": by,
        "at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
    }
    # 后面的确认基于旧内容，统一清掉
    for g in GATES[GATES.index(gate) + 1:]:
        c = (b.get("confirmations") or {}).get(g)
        if c and c.get("hash") != gate_hash(b, g):
            del b["confirmations"][g]
    return code


def require(b, stage, base=None):
    """返回未满足的条目列表；空列表表示可以进入该阶段。"""
    out = []
    for g in STAGES[stage]:
        st, det = gate_state(b, g, base)
        if st != "confirmed":
            out.append(f"{g} {TITLE[g]}：{STATE_ZH[st]}" + (f"（{det[0]}）" if det and st != "pending" else ""))
    return out


def require_or_exit(brief_path, stage):
    """给其他脚本调用：不满足就打印原因并退出 3。"""
    if not brief_path:
        sys.stderr.write(
            f"拒绝{STAGE_NAME[stage]}：没有设计确认文件。\n"
            "本 skill 要求布线前先和用户逐级确认需求、机械约束、功能分区、布局检查和布线规划，\n"
            "运行 python scripts/design_gate.py init 生成模板，按 references/19-design-gate.md 和用户一起填写确认，\n"
            "再用 --brief design-brief.json 调用。\n")
        raise SystemExit(3)
    b = load(brief_path)
    miss = require(b, stage, Path(brief_path).parent)
    if miss:
        sys.stderr.write(f"拒绝{STAGE_NAME[stage]}：以下闸门未通过——\n" + "\n".join(f"  · {m}" for m in miss)
                         + f"\n运行 python scripts/design_gate.py status {brief_path} 查看缺什么。\n")
        raise SystemExit(3)
    return b


def main(argv=None):
    ap = argparse.ArgumentParser(description="设计确认闸门：布局布线前的强制确认流程")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init", help="生成待填模板")
    p.add_argument("-o", "--output", default="design-brief.json")
    p.add_argument("--force", action="store_true")
    p = sub.add_parser("status", help="各闸门的状态")
    p.add_argument("brief")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("summary", help="生成发给用户核对的摘要和确认码")
    p.add_argument("brief")
    p.add_argument("gate", choices=GATES)
    p = sub.add_parser("confirm", help="记录用户的确认（必须带用户原话）")
    p.add_argument("brief")
    p.add_argument("gate", choices=GATES)
    p.add_argument("--quote", help="用户回复的原话，必须包含确认码")
    p.add_argument("--tty", action="store_true", help="在终端里由用户亲手输入确认码")
    p.add_argument("--by", default="user")
    p = sub.add_parser("require", help="检查能否进入某阶段，不满足退出 3")
    p.add_argument("brief")
    p.add_argument("--stage", choices=list(STAGES), required=True)
    p = sub.add_parser("code", help="只打印某闸门当前的确认码")
    p.add_argument("brief")
    p.add_argument("gate", choices=GATES)
    a = ap.parse_args(argv)

    if a.cmd == "init":
        out = Path(a.output)
        if out.exists() and not a.force:
            raise SystemExit(f"{out} 已存在；加 --force 覆盖")
        save(out, template())
        print(f"已生成 {out}。所有“待填”都要由用户给出或确认，不能由 AI 自行编造。")
        return 0
    b = load(a.brief)
    base = Path(a.brief).parent
    if a.cmd == "status":
        if a.json:
            print(json.dumps({g: dict(zip(("state", "detail"), gate_state(b, g, base))) for g in GATES}, ensure_ascii=False, indent=2))
        else:
            print(status_text(b, base))
        return 0
    if a.cmd == "summary":
        print(summary_text(b, a.gate, base))
        return 0
    if a.cmd == "code":
        print(code_of(b, a.gate))
        return 0
    if a.cmd == "confirm":
        quote = a.quote
        if a.tty:
            if not sys.stdin.isatty():
                raise SystemExit("--tty 只能由用户在终端里运行")
            print(summary_text(b, a.gate, base))
            quote = input("\n请输入确认码：")
        code = confirm(b, a.gate, quote, a.by, base)
        save(a.brief, b)
        print(f"已记录 {a.gate} 的确认（{code}）。")
        return 0
    if a.cmd == "require":
        miss = require(b, a.stage, base)
        if miss:
            print(f"✗ 不能{STAGE_NAME[a.stage]}：")
            print("\n".join(f"  · {m}" for m in miss))
            return 3
        print(f"✓ 可以{STAGE_NAME[a.stage]}")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
