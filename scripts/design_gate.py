#!/usr/bin/env python3
"""设计确认闸门：布局、布线之前必须拿到的规范性设计信息，以及用户逐级确认的记录。

本 skill 不接受“一句话完成整块板”的用法。布局前必须确认 G0 需求与 G1 机械约束；
布线前必须确认 G0–G4（分区布局已经用户看过截图、布局检查无 P0、布线优先级与
约束已定）；出图前必须确认 G5（丝印、位号编号、泪滴：逐项问过用户的决定 + finish_lint.py
检查无 P0、P1 都改了或由用户同意保留 + 用户看过丝印截图）；交付前必须确认 G6（布线检查和
DRC 结果 + 用户看过布线截图）。

    python design_gate.py init [-o design-brief.json]          # 生成待填模板
    python design_gate.py status design-brief.json              # 各闸门缺什么、待确认还是已确认
    python design_gate.py summary design-brief.json G2          # 给用户看的摘要 + 确认码
    python design_gate.py ask design-brief.json G5              # G5 的引导问题：每一项的选项、推荐值和为什么要问
    python design_gate.py confirm design-brief.json G2 --quote "确认 G2-3fa9c1"
    python design_gate.py require design-brief.json --stage place|route|deliver
    python design_gate.py priorities design-brief.json --board board.kicad_pcb --write   # 按板子功能梳理网络优先级草稿
    python design_gate.py summary design-brief.json T1        # 第 1 档的网络、理由、走法和确认码
    python design_gate.py confirm-tier design-brief.json 1 --quote "确认 T1-xxxxxx"

确认规则：
  - 只有用户能确认。AI 必须把 summary 的内容和确认码发给用户，等用户回复包含确认码的原话，
    再用 --quote 原样记下；不能自己替用户确认，也不能在用户没回复时继续。
  - 每个闸门的确认码由它和前面所有闸门的内容算出。前面任何内容被改，后面的确认自动失效。
  - 在终端里也可以 --tty，由用户亲手输入确认码。
  - require 不通过时退出码为 3；route_fix.py、route_lint.py gate 和 EDA 扩展的写回都会调用它。
  - 布线优先级按档位逐档确认：第 n 档的确认码由第 1…n 档的内容算出，必须先确认前一档；
    所有档位确认后 G4 才算信息齐全，再整体确认 G4。
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
GATES = ["G0", "G1", "G2", "G3", "G4", "G5", "G6"]
SECTION = {
    "G0": "G0_requirements",
    "G1": "G1_mechanical",
    "G2": "G2_partition",
    "G3": "G3_layout_check",
    "G4": "G4_routing_plan",
    "G5": "G5_finish",
    "G6": "G6_acceptance",
}
TITLE = {
    "G0": "需求与工艺",
    "G1": "板框、外壳与固定位置",
    "G2": "功能分区与布局评审",
    "G3": "布局检查",
    "G4": "布线规划：叠层、优先级、约束、验收标准",
    "G5": "丝印、位号编号与泪滴",
    "G6": "交付验收",
}
STAGES = {"place": ["G0", "G1"], "route": ["G0", "G1", "G2", "G3", "G4"], "finish": ["G0", "G1", "G2", "G3", "G4", "G5"], "deliver": GATES}
STAGE_NAME = {"place": "开始摆放器件", "route": "开始布线（含自动布线、自动修复、写入 EDA）", "finish": "导出 Gerber / 坐标文件",
              "deliver": "宣布完成 / 交付打样"}

PLACEHOLDER = re.compile(r"^\s*(|待填|待定|tbd|todo|\?+|？+|xx+|n/?a|未知|不知道|随便|都行|你定|你看着办)\s*$", re.I)


def template():
    """待填模板。所有“待填”都必须由用户给出或确认。"""
    return {
        "kind": KIND,
        "version": 2,
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
            "length_groups": "无",
            "acceptance": {"route_lint_min_score": 80, "drc_zero": True, "human_review": True},
        },
        "G5_finish": finish_template(),
        "G6_acceptance": {
            "route_report": "待填：route_lint.py lint --json 的报告路径",
            "drc_errors": "待填：EDA 原生 DRC 的错误数",
            "screenshots": "待填：用户看过的布线截图 [文件名…]",
        },
        "confirmations": {},
    }


# ------------------------------------------------------------------ G5：丝印、位号编号、泪滴的引导问题
# (路径, 问题, 选项, 推荐, 为什么要问)。选项为空表示自由填写；每一项都要用户回答，不能由 AI 代填。
FINISH_QUESTIONS = [
    ("silk.process", "丝印用什么工艺？", ["标准丝印", "高精度丝印", "镂空字"], "标准丝印",
     "决定最小线宽和字高：嘉立创标准丝印线宽 ≥ 0.153 mm、字高 ≥ 1.0 mm；高精度可到 0.1 mm / 0.8 mm（看板厂是否支持、是否加价）；镂空字要 0.2 mm / 1.5 mm"),
    ("silk.text_height_mm", "位号和文字的字高（mm）？", [], "1.0",
     "小于工艺下限会糊成一团；板子很挤可以只印关键器件，而不是把字缩到印不出来"),
    ("silk.line_width_mm", "文字线宽（mm）？", [], "0.153",
     "字高与线宽约 6:1 最清楚；线太细会断笔"),
    ("silk.pad_clearance_mm", "丝印离焊盘至少多远（mm）？", [], "0.2",
     "板厂会把压到焊盘的丝印自动裁掉（字会残缺），至少 0.15 mm，建议 0.2–0.25 mm"),
    ("silk.designators", "位号怎么印？", ["全部显示", "只印关键器件", "不印（用装配图）"], "全部显示",
     "全部显示方便调试和维修；板子太小可以只印芯片、接口、晶振、按键、二极管、电池等，阻容靠装配图"),
    ("silk.orientation", "文字方向怎么统一？", ["0° 和 90°", "全部 0°"], "0° 和 90°",
     "全板只用两种读向（从下往上、从左往右），装配和维修时不用转板；倒着或斜着的字最容易看错"),
    ("silk.polarity", "极性和 1 脚怎么标？", [], "芯片 1 脚圆点，二极管和 LED 阴极横杠，电解或钽电容 + 号，接口 1 脚三角",
     "贴片和手焊最常见的错误就是贴反；标记要在贴片后还看得到（不要只画在器件下面）"),
    ("silk.labels", "哪些接口、按键、指示灯、测试点要印说明？", [], "[{ref: J1, text: USB}, {ref: SW1, text: RST}, …]，没有写 无",
     "用户和测试人员只看丝印认接口；写成 [{ref, text}] 列表，检查时会在器件旁边找这段文字"),
    ("silk.board_marking", "板名、版本号（可加日期、作者）？", [], "{name: 板名, version: V1.0}",
     "改版后最怕分不清哪块板是哪一版；版本号每次改板都要改"),
    ("silk.warnings", "要不要警示标注（电池极性、高压、禁止热插拔、ESD 敏感）？", [], "无",
     "有电池座、外部电源输入或高压时建议加；写成文字列表，没有写 无"),
    ("silk.compliance", "要不要认证或回收标志（CE、FCC ID、WEEE、UL 94V-0 等）？", [], "无",
     "量产或出口才需要；位置和尺寸按认证要求，没有写 无"),
    ("silk.jlc_order_no", "嘉立创订单号印在哪里？", ["板厂默认位置", "指定位置", "不加"], "指定位置",
     "默认会落在空白处，可能在外壳开窗或导光柱下；指定位置就放一行 JLCJLCJLCJLC 占位；不加可能要加价，以下单页为准"),
    ("silk.bottom_silk", "底面要不要丝印？", ["需要", "不需要"], "需要",
     "底面有器件、测试点或要写板名时需要；底面文字要镜像"),
    ("annotation.scheme", "位号编号用什么方式？", ["按位置重新编号", "按原理图顺序", "保持现状"], "按位置重新编号",
     "按位置（从上到下、从左到右）编号，维修时按位号找器件最快；重新编号后必须反标回原理图，BOM 和坐标文件才对得上"),
    ("annotation.back_annotated", "位号改动是否已经反标回原理图，BOM 和坐标文件重新导出？", ["是", "没有改动"], "是",
     "PCB 和原理图位号不一致时，贴片厂会按错的 BOM 贴料"),
    ("teardrops.policy", "泪滴怎么加？", ["全部焊盘与过孔", "仅过孔和插件孔", "不加"], "全部焊盘与过孔",
     "泪滴加固线和焊盘、过孔的连接，钻孔偏位或热应力时线不容易断；细线（≤ 0.2 mm）进大焊盘尤其要加"),
    ("teardrops.exclude_rf_diff", "射频和差分线上要不要去掉泪滴？", ["去掉", "保留"], "去掉",
     "泪滴会让线宽在焊盘前突变，影响 50 Ω 射频和差分阻抗；一般不加"),
    ("teardrops.done", "泪滴执行了吗？（执行后要重新铺铜）", ["已执行并重新铺铜", "不加泪滴"], "已执行并重新铺铜",
     "泪滴要在布线定稿后执行，之后改线要重新执行；嘉立创扩展读不到泪滴，靠这一项和截图确认"),
    ("silk.review.screenshot", "用户看过的丝印截图（只开丝印层和焊盘，或 3D 预览）", [], "silk-top.png",
     "工具查不出“看起来乱”“指认不清”这种问题，必须用户自己看一遍"),
    ("silk.review.polarity_checked", "是否已对照原理图逐个核对极性器件和 1 脚标记？", ["已核对"], "已核对",
     "封装库里的 1 脚标记可能是错的，或者被位号挡住；工具只能找到“有没有标记”，标得对不对要人看"),
]
FINISH_DEFAULT = {"silk.process": "标准丝印"}
FINISH_FREEFORM = {"silk.labels", "silk.warnings", "silk.board_marking", "silk.text_height_mm", "silk.line_width_mm", "silk.pad_clearance_mm"}


def finish_template():
    t = {"silk": {"review": {}}, "annotation": {}, "teardrops": {}}
    for path, q, opts, rec, why in FINISH_QUESTIONS:
        cur = t
        keys = path.split(".")
        for k in keys[:-1]:
            cur = cur.setdefault(k, {})
        cur[keys[-1]] = "待填：" + q + (f"（{' / '.join(opts)}）" if opts else "")
    t["annotation"]["bom"] = ""
    t["report"] = "待填：finish_lint.py --json 的报告路径"
    t["accepted_exceptions"] = "待填：用户同意保留的 P1 问题 [{rule, refs, why}]，没有就写 无"
    return t


FINISH_VOLATILE = (("report",), ("result",), ("accepted_exceptions",), ("silk", "review"), ("teardrops", "done"), ("annotation", "back_annotated"))


def finish_rules_hash(b):
    """G5 里影响检查结果的决定（去掉报告、截图、保留问题、执行记录）的哈希；finish_lint.py 写进报告，用来判断报告是否过期。"""
    d = copy.deepcopy(get(b, "G5_finish") or {})
    for path in FINISH_VOLATILE:
        cur = d
        for k in path[:-1]:
            cur = cur.get(k) if isinstance(cur, dict) else None
        if isinstance(cur, dict):
            cur.pop(path[-1], None)
    return hashlib.sha256(canonical(d).encode("utf-8")).hexdigest()


def migrate(b):
    """旧版（G5 是交付验收）→ 新版：G5 丝印 / 位号 / 泪滴，G6 交付验收。旧的 G5 确认作废。"""
    if isinstance(b, dict) and "G5_acceptance" in b and "G6_acceptance" not in b:
        b["G6_acceptance"] = b.pop("G5_acceptance")
        conf = b.get("confirmations") or {}
        if "G5" in conf:
            conf["G6_legacy"] = conf.pop("G5")
        b.setdefault("G5_finish", finish_template())
        b["version"] = max(2, int(b.get("version") or 1))
    return b


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
    rep, err = _load_report(b, "G6_acceptance.route_report", "G6_acceptance.route_result", base)
    if err:
        return [e + "：运行 route_lint.py lint 板子 --json <报告>" for e in err]
    if rep is None:
        return ["布线检查报告（G6_acceptance.route_report）：运行 route_lint.py lint 板子 --json route-lint.json，或在扩展里记录"]
    out = []
    score = rep.get("score")
    need = num(get(b, "G4_routing_plan.acceptance.route_lint_min_score")) or 80
    if rep.get("p0", 0) > 0 or rep.get("pass") is False:
        out.append("布线检查有 P0：不能交付")
    if score is None or score < need:
        out.append(f"布线得分 {score} 低于验收线 {need:g}")
    return out


def req_drc_zero(b, base=None):
    v = num(get(b, "G6_acceptance.drc_errors"))
    if v is None:
        return ["DRC 错误数（G6_acceptance.drc_errors）：在 EDA 里跑一次 DRC 填数字"]
    if v > 0 and get(b, "G4_routing_plan.acceptance.drc_zero") is not False:
        return [f"DRC 还有 {int(v)} 个错误"]
    return []


def req_finish_answers(b, base=None):
    """G5 每一个引导问题都要有用户的回答。"""
    out = []
    for path, q, opts, rec, why in FINISH_QUESTIONS:
        v = get(b, "G5_finish." + path)
        if isinstance(v, bool) or (isinstance(v, (int, float)) and not isinstance(v, bool)):
            continue
        if isinstance(v, (list, dict)) and v:
            continue
        if is_blank(v) or (isinstance(v, str) and not v.strip()) or v == [] or v == {}:
            out.append(f"{q}（G5_finish.{path}）" + (f"：选 {' / '.join(opts)}" if opts else "") + f"，推荐 {rec}")
            continue
        if opts and path not in FINISH_FREEFORM and isinstance(v, str) and v.strip() not in opts:
            out.append(f"{q}（G5_finish.{path}）：只能选 {' / '.join(opts)}，现在是“{v}”")
    return out


def req_finish_values(b, base=None):
    """数值是否满足所选工艺的下限；板名、版本、标注列表的格式。"""
    out = []
    f = get(b, "G5_finish") or {}
    s = f.get("silk") or {}
    proc = {"标准丝印": (0.153, 1.0), "高精度丝印": (0.1, 0.8), "镂空字": (0.2, 1.5)}.get(s.get("process"))
    if proc:
        h, w, c = num(s.get("text_height_mm")), num(s.get("line_width_mm")), num(s.get("pad_clearance_mm"))
        if s.get("text_height_mm") is not None and not is_blank(s.get("text_height_mm")) and (h is None or h < proc[1]):
            out.append(f"字高（G5_finish.silk.text_height_mm）：{s.get('process')} 至少 {proc[1]:g} mm")
        if s.get("line_width_mm") is not None and not is_blank(s.get("line_width_mm")) and (w is None or w < proc[0] - 0.005):
            out.append(f"线宽（G5_finish.silk.line_width_mm）：{s.get('process')} 至少 {proc[0]:g} mm")
        if s.get("pad_clearance_mm") is not None and not is_blank(s.get("pad_clearance_mm")) and (c is None or c < 0.15):
            out.append("丝印离焊盘（G5_finish.silk.pad_clearance_mm）：至少 0.15 mm")
    bm = s.get("board_marking")
    if isinstance(bm, dict):
        for k, zh in (("name", "板名"), ("version", "版本号")):
            if is_blank(bm.get(k)) or not str(bm.get(k)).strip():
                out.append(f"{zh}（G5_finish.silk.board_marking.{k}）")
    elif bm is not None and not is_blank(bm):
        out.append("板名与版本（G5_finish.silk.board_marking）：写成 {name, version}")
    lb = s.get("labels")
    if isinstance(lb, list):
        for i, it in enumerate(lb):
            if not isinstance(it, dict) or is_blank(it.get("ref")) or is_blank(it.get("text")):
                out.append(f"说明丝印第 {i + 1} 项（G5_finish.silk.labels）：写成 {{ref, text}}")
    elif lb is not None and not is_blank(lb) and not is_none_word(lb):
        out.append("说明丝印（G5_finish.silk.labels）：写成 [{ref, text}] 列表，没有写 无")
    wn = s.get("warnings")
    if wn is not None and not is_blank(wn) and not is_none_word(wn) and not isinstance(wn, list):
        out.append("警示标注（G5_finish.silk.warnings）：写成文字列表，没有写 无")
    td = f.get("teardrops") or {}
    if td.get("policy") == "不加" and td.get("done") == "已执行并重新铺铜":
        out.append("泪滴策略是“不加”，执行记录却是“已执行”：两项要一致")
    if td.get("policy") in ("全部焊盘与过孔", "仅过孔和插件孔") and td.get("done") == "不加泪滴":
        out.append("泪滴策略要求加泪滴，执行记录却是“不加泪滴”：执行泪滴并重新铺铜后再填")
    return out


def finish_unresolved(rep, b):
    """报告里的 P1 减去用户同意保留的（按当前 G5_finish.accepted_exceptions 重新算）。"""
    acc = get(b, "G5_finish.accepted_exceptions")
    acc = acc if isinstance(acc, list) else []
    keys = set()
    for a in acc:
        if isinstance(a, dict) and not is_blank(a.get("why")) and a.get("rule"):
            r = a.get("refs")
            keys.add((a["rule"], (r[0] if isinstance(r, list) and r else (r if isinstance(r, str) else ""))))
    out = []
    for v in rep.get("issues") or []:
        if v.get("sev") != "P1":
            continue
        k0 = (v.get("refs") or [""])[0]
        if (v.get("rule"), k0) in keys or (v.get("rule"), "") in keys:
            continue
        out.append(v)
    return out


def req_finish_report(b, base=None):
    rep, err = _load_report(b, "G5_finish.report", "G5_finish.result", base)
    if err:
        return ["出图前检查报告（G5_finish.report）：" + e + "，运行 finish_lint.py 板子 --brief design-brief.json --json finish-lint.json" for e in err]
    if rep is None:
        return ["出图前检查报告（G5_finish.report）：运行 finish_lint.py 板子 --brief design-brief.json --json finish-lint.json，或在扩展“丝印”页记录"]
    out = []
    if rep.get("kind") != "lpiot-finish-lint":
        return ["出图前检查报告不是 finish_lint.py / 扩展生成的"]
    if rep.get("rules_hash") != finish_rules_hash(b):
        out.append("出图前检查报告是按旧的 G5 决定生成的（或生成时没带 --brief）：重新检查")
    if rep.get("p0", 1) > 0:
        out.append(f"出图前检查还有 {rep.get('p0')} 个 P0（位号未编号或重复）：在原理图里重新编号，更新到 PCB 再检查")
    un = finish_unresolved(rep, b)
    if un:
        ex = "；".join(f"{v.get('rule')} {'、'.join(v.get('refs') or [])}" for v in un[:4])
        out.append(f"还有 {len(un)} 个 P1 没改也没有用户同意保留：{ex}{' 等' if len(un) > 4 else ''}（改掉，或把用户同意保留的写进 accepted_exceptions，附原因）")
    td = get(b, "G5_finish.teardrops") or {}
    if rep.get("teardrop_source") in (None, "none") and td.get("policy") not in (None, "不加") and td.get("done") != "已执行并重新铺铜":
        out.append("读不到泪滴：在 EDA 里执行泪滴并重新铺铜，再把 G5_finish.teardrops.done 填成“已执行并重新铺铜”")
    return out


# ------------------------------------------------------------------ 能力边界：只布用户点名的网络
MAX_SCOPE_NETS = 8
WILDCARD = re.compile(r"^\s*(\*|all|any|rest|others?|全部|所有|全板|剩下的?|其余|其他|其它|剩余|everything)\s*$", re.I)
BOUNDARY = ("本 skill 的能力边界是检查图、改图，不是完全自由的自动布线。布线上只做两件事：检查已有布线（含几何修复），以及按用户点名的网络逐批布线（每批不超过 "
            f"{MAX_SCOPE_NETS} 个网络，且都在已确认的布线优先级里）。“全局布线”“把剩下的全布了”这类需要大范围搜索的任务"
            "做不了，也不执行：请用户点名这一批要布的网络，或者用 EDA 自带的自动布线器自己布，再回来做检查。")


def route_scope(b, nets, plan_nets=None):
    """检查这一批要布的网络是否在能力边界内。返回问题列表；空表示可以布。"""
    out = []
    names = [n.strip() for n in (nets or []) if isinstance(n, str) and n.strip()]
    if not names:
        return ["没有点名要布的网络。" + BOUNDARY]
    wild = [n for n in names if WILDCARD.match(n)]
    if wild:
        return [f"“{'、'.join(wild)}”不是网络名。" + BOUNDARY]
    if len(names) > MAX_SCOPE_NETS:
        out.append(f"一次点名了 {len(names)} 个网络，超过 {MAX_SCOPE_NETS} 个：这已经是大范围布线，拆成几批，每批由用户点名。")
    explicit, star = set(), False
    sts = {str(t): st for t, _, st, _ in tier_states(b)}
    for i, t in enumerate(tier_list(b)):
        if sts.get(str(t.get("tier", i + 1))) != "confirmed":
            continue
        for n in t.get("nets") or []:
            if n == "*":
                star = True
            else:
                explicit.add(n)
    unknown = [n for n in names if n not in explicit and not star]
    if unknown:
        out.append(f"{'、'.join(unknown[:6])} 不在已确认的布线优先级里：先把它们排进 G4 的某一档并请用户确认。")
    if plan_nets is not None:
        extra = sorted(set(plan_nets) - set(names))
        if extra:
            out.append(f"走线里还有没点名的网络：{'、'.join(extra[:6])}{' 等' if len(extra) > 6 else ''}。只能写用户点名的网络。")
    return out


def req_length_groups(b, base=None):
    """等长组（可选）：[{name, nets: [≥ 2 个], tol_mm}]，没有写 无。由用户决定哪些线要等长。"""
    v = get(b, "G4_routing_plan.length_groups")
    if v is None or is_blank(v) or is_none_word(v) or v == []:
        return []
    if not isinstance(v, list):
        return ["等长组（G4_routing_plan.length_groups）：写成 [{name, nets, tol_mm}]，没有写 无"]
    out = []
    for i, g in enumerate(v):
        if not isinstance(g, dict) or is_blank(g.get("name")) or not isinstance(g.get("nets"), list) or len(g["nets"]) < 2 \
                or num(g.get("tol_mm")) is None or num(g.get("tol_mm")) < 0:
            out.append(f"等长组第 {i + 1} 项：要有 name、至少 2 个 nets 和 tol_mm（mm，≥ 0）")
    return out


def tier_list(b):
    v = get(b, "G4_routing_plan.priorities")
    return [t for t in v if isinstance(t, dict)] if isinstance(v, list) else []


def tier_hash(b, idx):
    """第 idx 档（从 0 数）的哈希：第 1…idx+1 档的内容，外加 G0–G3 的哈希（前面改了，档位确认也作废）。"""
    tiers = [{k: v for k, v in t.items() if k != "confirmed"} for t in tier_list(b)[: idx + 1]]
    return hashlib.sha256(canonical({"base": gate_hash(b, "G3"), "tiers": tiers}).encode("utf-8")).hexdigest()


def tier_code(b, idx):
    t = tier_list(b)[idx]
    return f"T{t.get('tier', idx + 1)}-{tier_hash(b, idx)[:6]}"


def tier_states(b):
    """[(档位, 档名, 状态, 确认码)]，状态：confirmed / pending / blocked / stale。"""
    out, prev_ok = [], True
    conf = (b.get("confirmations") or {}).get("tiers") or {}
    for i, t in enumerate(tier_list(b)):
        key = str(t.get("tier", i + 1))
        c = conf.get(key)
        code = tier_code(b, i)
        if c and c.get("hash") == tier_hash(b, i):
            st = "confirmed"
        elif not prev_ok:
            st = "blocked"
        else:
            st = "stale" if c else "pending"
        out.append((t.get("tier", i + 1), t.get("name", ""), st, code))
        prev_ok = st == "confirmed"
    return out


def req_tiers_confirmed(b, base=None):
    sts = tier_states(b)
    left = [f"第 {t} 档{('（' + n + '）') if n else ''}" for t, n, st, _ in sts if st != "confirmed"]
    if sts and left:
        return [f"布线优先级还要逐档确认：{'、'.join(left[:4])}{' 等' if len(left) > 4 else ''}（design_gate.py summary <brief> T<档位>）"]
    return []


def confirm_tier(b, tier, quote, by="user"):
    tiers = tier_list(b)
    idx = next((i for i, t in enumerate(tiers) if str(t.get("tier", i + 1)) == str(tier)), None)
    if idx is None:
        raise SystemExit(f"没有第 {tier} 档；先用 priorities 梳理或在 G4_routing_plan.priorities 里写好")
    for i, (t, n, st, _) in enumerate(tier_states(b)[:idx]):
        if st != "confirmed":
            raise SystemExit(f"不能确认：先确认第 {t} 档（{n}）")
    code = tier_code(b, idx)
    if not quote or code.lower() not in re.sub(r"\s+", "", quote).lower():
        raise SystemExit(f"不能确认：用户的原话里没有确认码 {code}")
    b.setdefault("confirmations", {}).setdefault("tiers", {})[str(tier)] = {
        "code": code, "hash": tier_hash(b, idx), "quote": quote.strip()[:500], "by": by,
        "at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")}
    return code


def tier_summary(b, tier):
    tiers = tier_list(b)
    idx = next((i for i, t in enumerate(tiers) if str(t.get("tier", i + 1)) == str(tier)), None)
    if idx is None:
        return f"没有第 {tier} 档"
    t = tiers[idx]
    st = dict(((str(x[0]), x[2]) for x in tier_states(b)))[str(t.get("tier", idx + 1))]
    lines = [f"【第 {t.get('tier')} 档 · {t.get('name', '')}】（{ {'confirmed': '已确认', 'pending': '待确认', 'blocked': '先确认前一档', 'stale': '内容改过，需要重新确认'}[st] }）",
             f"网络：{'、'.join(t.get('nets', []))}", f"为什么排在这一档：{t.get('why', '')}"]
    for nm, why in (t.get("notes") or {}).items():
        lines.append(f"  · {nm}：{why}")
    lines += [f"走法：{t.get('method', '')}", f"规则：{t.get('rules', '')}"]
    if st in ("pending", "stale"):
        lines += ["", f"网络归档、走法和规则都同意，请回复：确认 {tier_code(b, idx)}；要调整（挪档、改走法）请直接说。"]
    return "\n".join(lines)


CLASS_ZH = {"RF50": "射频 50 Ω", "XTAL": "晶振", "SW": "开关节点", "HV": "高压", "USB90": "USB 差分", "DIFF100": "100 Ω 差分",
            "CLK": "时钟", "ANALOG": "模拟", "PWR_MAIN": "主电源", "PWR_LOW": "电源", "SIG": "一般信号", "GND": "地"}
ROLE_ZH = {"antenna": "天线", "rf_match": "射频匹配", "crystal": "晶振", "inductor": "电感", "connector": "接口", "cap": "电容", "res": "电阻",
           "diode": "二极管", "ic": "芯片", "soc_rf": "无线 SoC", "dcdc": "DCDC", "ldo": "LDO", "charger": "充电", "imu": "IMU", "button": "按键",
           "testpoint": "测试点", "battery": "电池", "magnetometer": "磁力计", "temp_humidity": "温湿度", "rf_module": "无线模组"}

RULES_BY_CLASS = {
    "RF50": "50 Ω 共面波导（线宽按叠层计算），不打过孔、不分支，两侧密打地过孔，拐角 135° 或圆弧",
    "XTAL": "≤ 5 mm、不打过孔，负载电容贴晶振，下方完整地，远离开关节点和时钟",
    "SW": "热回路面积最小，开关节点铜皮最小，线宽 ≥ 0.6 mm",
    "HV": "先按电压定间距和爬电距离，再布线",
    "USB90": "90 Ω 差分，同层、并行、等距、对内等长 ≤ 0.5 mm，过孔成对",
    "DIFF100": "100 Ω 差分，同层、并行、等距、对内等长 ≤ 0.13 mm，过孔成对",
    "CLK": "串阻贴驱动端，少拐弯少过孔，远离模拟和射频",
    "ANALOG": "远离攻击网络，走在完整地正上方，必要时包地",
    "PWR_MAIN": "按电流定线宽（见电源网络表），先干线后支路，去耦就近",
    "PWR_LOW": "按电流定线宽（见电源网络表），去耦电容贴引脚",
    "SIG": "八方向、拐角只用 135°，总线成束等距",
    "GND": "最后铺铜、补缝合过孔，修补被切开的地",
}


def draft_priorities(pack):
    """按网络类和布线优先级档位梳理草稿：[{tier, name, classes, nets, notes, why, method, rules}]。"""
    import route_principles as RP
    RL = _rl()
    nets = [RL.norm_net(n) for n in pack.get("nets", [])]
    import layout_lint as LL
    values = {p["ref"]: p.get("value") for p in pack.get("parts", [])}
    classes, notes = {}, {}
    for n in nets:
        c, _, why = RL.infer_class(n["name"], n["pads"])
        classes[n["name"]] = c
        notes[n["name"]] = "按网络名判断" if "网络名匹配" in why else why
    RL.upgrade_pairs(classes, nets, RL.merge_cons(None), [])
    for n in nets:
        refs = []
        for p in n["pads"]:
            r = p["ref"]
            if r and r not in refs:
                refs.append(r)
        lab = [f"{r}（{ROLE_ZH.get(LL.role_of(r, values.get(r), {}), '')}{(' ' + values[r]) if values.get(r) else ''}）".replace("（）", "") for r in refs[:5]]
        notes[n["name"]] = f"{CLASS_ZH.get(classes[n['name']], classes[n['name']])}，{notes[n['name']]}；连接 {'、'.join(lab)}{' 等' if len(refs) > 5 else ''}"
    rows = RP.routing_order(nets, classes)
    out = []
    for t, name, cls, why in RP.TIERS:
        ns = [r["net"] for r in rows if r["tier"] == t]
        if not ns:
            continue
        out.append({"tier": t, "name": name, "classes": sorted({classes[x] for x in ns}), "nets": ns,
                    "notes": {x: notes[x] for x in ns}, "why": why,
                    "method": "铺铜" if t == 9 else ("工具辅助" if t == 8 else "手工"),
                    "rules": "；".join(RULES_BY_CLASS[c] for c in sorted({classes[x] for x in ns}) if c in RULES_BY_CLASS)})
    return out


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
        req_tiers_confirmed,
        req_list("G4_routing_plan.diff_pairs", "差分对", allow_none=True),
        req_list("G4_routing_plan.power_nets", "电源网络与电流", 1, ("net", "current_ma")),
        req_length_groups,
        req_min_score,
    ],
    "G5": [
        req_finish_answers,
        req_finish_values,
        req_finish_report,
        req_list("G5_finish.accepted_exceptions", "保留的问题", allow_none=True),
    ],
    "G6": [
        req_route_report,
        req_drc_zero,
        req_list("G6_acceptance.screenshots", "用户看过的布线截图", 1),
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
    return migrate(b)


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
        if g == "G4" and tier_list(b):
            for t, n, tst, code in tier_states(b):
                lines.append(f"      第 {t} 档 {n}：{ {'confirmed': '已确认', 'pending': '待确认 ' + code, 'blocked': '等前一档', 'stale': '已失效 ' + code}[tst] }")
    for s, gs in STAGES.items():
        ok = all(gate_state(b, g, base)[0] == "confirmed" for g in gs)
        lines.append(f"  {'✓' if ok else '✗'} {STAGE_NAME[s]}（需要 {'、'.join(gs)}）")
    return "\n".join(lines)


def finish_questionnaire(b):
    """G5 的引导问题：已答的显示答案，没答的给出选项、推荐值和理由。"""
    lines, n_todo = [], 0
    groups = [("silk", "丝印"), ("annotation", "位号编号"), ("teardrops", "泪滴")]
    for g, zh in groups:
        lines.append(f"〔{zh}〕")
        for path, q, opts, rec, why in FINISH_QUESTIONS:
            if not path.startswith(g + "."):
                continue
            v = get(b, "G5_finish." + path)
            answered = not (v is None or (isinstance(v, str) and (is_blank(v) or not v.strip())) or v in ([], {}))
            if answered and opts and path not in FINISH_FREEFORM and isinstance(v, str) and v.strip() not in opts:
                answered = False
            if answered:
                lines.append(f"  ✓ {q} {json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v}")
            else:
                n_todo += 1
                lines.append(f"  {n_todo}. {q}" + (f"  选项：{' / '.join(opts)}" if opts else ""))
                lines.append(f"     推荐：{rec}")
                lines.append(f"     为什么要问：{why}")
    return n_todo, "\n".join(lines)


def ask_text(b, gate, base=None):
    if gate != "G5":
        st, det = gate_state(b, gate, base)
        if st == "missing":
            return f"【{gate} {TITLE[gate]}】要向用户问清楚：\n" + "\n".join(f"  · {m}" for m in det)
        return summary_text(b, gate, base)
    n, body = finish_questionnaire(b)
    head = f"【G5 {TITLE['G5']}】出图前必须和用户逐项过一遍，"
    if n:
        head += f"还有 {n} 项没回答。把下面的问题原样发给用户（可以分两三次问），用户说“按推荐”才能填推荐值，不能替用户选。"
    else:
        head += "问题都已回答；接着运行 finish_lint.py 检查，再用 summary G5 请用户确认。"
    return head + "\n" + body


def summary_text(b, gate, base=None):
    st, det = gate_state(b, gate, base)
    head = f"【{gate} {TITLE[gate]}】"
    if st == "missing" and gate == "G5":
        n, body = finish_questionnaire(b)
        rest = [m for m in det if "G5_finish.silk." not in m and "G5_finish.annotation." not in m and "G5_finish.teardrops." not in m or "至少" in m or "一致" in m or "写成" in m]
        out = head + "还不能确认。"
        if n:
            out += f"下面 {n} 个问题请向用户逐项询问（附推荐值和理由，用户说“按推荐”才能填推荐值）：\n" + body
        if rest:
            out += "\n另外还缺：\n" + "\n".join(f"  · {m}" for m in rest)
        return out
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


def _rl():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import route_lint
    return route_lint


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
    p = sub.add_parser("summary", help="生成发给用户核对的摘要和确认码（G0…G6，或 T1…T9 某一档优先级）")
    p.add_argument("brief")
    p.add_argument("gate")
    p = sub.add_parser("ask", help="列出某闸门还要问用户的问题（G5 带选项、推荐值和理由）")
    p.add_argument("brief")
    p.add_argument("gate", choices=GATES)
    p = sub.add_parser("scope", help="布线前检查这一批网络是否在能力边界内（只布用户点名的网络，每批不超过 8 个）")
    p.add_argument("brief")
    p.add_argument("--nets", required=True, help="用户点名的网络，逗号分隔")
    p = sub.add_parser("priorities", help="按板子功能梳理网络优先级草稿")
    p.add_argument("brief")
    p.add_argument("--board", required=True, help=".kicad_pcb 或 copper-pack.json（也可以是 eda_bridge.py export 导出的板子）")
    p.add_argument("--write", action="store_true", help="写进 G4_routing_plan.priorities（会清掉已有的档位确认）")
    p = sub.add_parser("confirm-tier", help="记录用户对某一档优先级的确认（必须带用户原话）")
    p.add_argument("brief")
    p.add_argument("tier")
    p.add_argument("--quote", required=True)
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
        if re.fullmatch(r"[Tt]\d+", a.gate):
            print(tier_summary(b, a.gate[1:]))
        elif a.gate in GATES:
            print(summary_text(b, a.gate, base))
        else:
            raise SystemExit("gate 只能是 G0…G6 或 T1…T9")
        return 0
    if a.cmd == "ask":
        print(ask_text(b, a.gate, base))
        return 0
    if a.cmd == "scope":
        miss = require(b, "route", base) + route_scope(b, re.split(r"[,，\s]+", a.nets))
        if miss:
            print("✗ 不能布这一批：")
            print("\n".join(f"  · {m}" for m in miss))
            return 3
        print(f"✓ 可以布：{a.nets}")
        return 0
    if a.cmd == "priorities":
        pack, _ = _rl().load_any(a.board)
        draft = draft_priorities(pack)
        for t in draft:
            print(f"第 {t['tier']} 档 {t['name']}（{t['method']}）：{'、'.join(t['nets'])}")
        if a.write:
            b.setdefault("G4_routing_plan", {})["priorities"] = draft
            (b.get("confirmations") or {}).pop("tiers", None)
            save(a.brief, b)
            print(f"已写入 {a.brief}。这是按网络名和连接关系推断的草稿：结合板子的功能核对每一档，再逐档发给用户确认。")
        return 0
    if a.cmd == "confirm-tier":
        code = confirm_tier(b, a.tier, a.quote)
        save(a.brief, b)
        print(f"已记录第 {a.tier} 档的确认（{code}）。")
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
