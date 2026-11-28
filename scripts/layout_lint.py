#!/usr/bin/env python3
"""实板布局检查：对照设计确认文件（design-brief.json）检查 PCB 上的器件摆放。

    python layout_lint.py board.kicad_pcb --brief design-brief.json [--json layout-lint.json] [-o 报告.md]
    python layout_lint.py copper-pack.json --brief design-brief.json

和布局规划器（布线前、在网页里摆）不同，这里读的是 EDA 里真实的板子，可以在布线前、布线后
任意时刻运行。检查分三类：

  1. 机械与分区（需要 brief 的 G1、G2）：器件在板框内、不重叠、不进禁布区；被外壳决定位置的
     接口 / 按键 / 天线在指定的边和位置；每个功能块的器件落在它的区域里，功能块之间不交叠。
  2. 射频与干扰源间距：天线在板边且净空区内没有器件；电感、晶振、天线、电池、连接器之间的最小距离。
  3. 就近原则（与 route_lint 同一套 RTP 规则）：去耦电容贴电源引脚、负载电容贴晶振、ESD 贴接口等；
     没布线时按直线距离估计。

--json 输出的报告里带 brief 的 G0–G2 哈希，design_gate.py 用它判断 G3 是否基于最新的分区。
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_lint as RL  # noqa: E402
import route_principles as RP  # noqa: E402

REGIONS = {
    "left": (0, 0, .5, 1), "right": (.5, 0, 1, 1), "top": (0, .5, 1, 1), "bottom": (0, 0, 1, .5),
    "top-left": (0, .5, .5, 1), "top-right": (.5, .5, 1, 1), "bottom-left": (0, 0, .5, .5), "bottom-right": (.5, 0, 1, .5),
    "center": (.25, .25, .75, .75), "left-third": (0, 0, 1 / 3, 1), "right-third": (2 / 3, 0, 1, 1),
    "middle-third": (1 / 3, 0, 2 / 3, 1), "top-third": (0, 2 / 3, 1, 1), "bottom-third": (0, 0, 1, 1 / 3),
    "any": (0, 0, 1, 1),
}
REGION_ZH = {"left": "左半", "right": "右半", "top": "上半", "bottom": "下半", "top-left": "左上", "top-right": "右上",
             "bottom-left": "左下", "bottom-right": "右下", "center": "中部", "left-third": "左三分之一",
             "right-third": "右三分之一", "middle-third": "中间三分之一", "top-third": "上三分之一", "bottom-third": "下三分之一"}
EDGE_ZH = {"left": "左边", "right": "右边", "top": "上边", "bottom": "下边", "inner": "板内"}

ROLE_RULES = [
    (r"^(ANT|AE)\d*|^E\d", "antenna"), (r"^(BT|BAT)\d*", "battery"), (r"^(USB|CN|J|P)\d", "connector"),
    (r"^(Y|X|XTAL|OSC)\d", "crystal"), (r"^L\d", "inductor"), (r"^(SW|KEY|K|S)\d", "button"),
    (r"^(LED|D)\d", "diode"), (r"^U\d|^IC\d|^M\d", "ic"), (r"^C\d", "cap"), (r"^R\d", "res"), (r"^FB\d", "ferrite"),
    (r"^TP\d", "testpoint"), (r"^H\d|^MH\d", "hole"),
]
# 按型号推断角色（位号推断之后再细分；设计确认里的 roles 优先）
VALUE_ROLES = [
    (r"1117|ME62|RT90|XC62|TLV7|AP21|LP59|HT7[0-9]|MIC5|\bLDO\b", "ldo"),
    (r"TPS6|TLV62|SY8|MP15|MP23|RT8|LMR|XL15|\bbuck\b|\bboost\b|DCDC", "dcdc"),
    (r"TP40|BQ2[45]|MCP738|LTC40|ETA60|CN30", "charger"),
    (r"BMI\d|LSM6|MPU-?\d|ICM-?\d|LIS2|ADXL|BMA\d|KX\d{3}", "imu"),
    (r"MMC\d|QMC\d|LIS3MDL|BMM\d|AK09", "magnetometer"),
    (r"SHT\d|SHTC|HDC\d|AHT\d|Si70|HTU\d|TMP1\d", "temp_humidity"),
    (r"BMP\d|LPS\d|DPS\d|MS56", "barometer"),
    (r"SPH\d|ICS-4\d|MSM26|MEMS ?MIC", "microphone"),
    (r"nRF5|ESP32|STM32WB|CC26|EFR32|BL6\d|CH58|DA14", "soc_rf"),
]
HEAT = {"dcdc", "ldo", "charger", "pa"}
MAJOR = {"antenna", "battery", "connector", "crystal", "inductor", "ic", "button", "rf_module", "dcdc", "mcu", "soc_rf",
         "ldo", "charger", "imu", "magnetometer", "temp_humidity", "barometer", "microphone"}

# 最小距离（mm），取自布局规划器 rules.js 的默认值
MIN_DIST = [
    ("LAY-07", "P1", {"antenna", "rf_module"}, {"battery", "connector"}, 5.0, "天线离电池 / 连接器太近：金属会让天线失谐、效率下降"),
    ("LAY-07", "P1", {"inductor"}, {"antenna", "rf_module"}, 8.0, "功率电感离天线太近：开关噪声会耦合进射频"),
    ("LAY-07", "P2", {"inductor"}, {"crystal"}, 4.0, "功率电感离晶振太近：磁场耦合会增加相噪、影响起振"),
    ("LAY-07", "P2", {"crystal"}, {"antenna", "rf_module"}, 4.0, "晶振离天线太近：射频会注入振荡回路"),
    ("LAY-11", "P2", {"imu"}, {"connector", "button", "hole"}, 5.0, "IMU 离连接器、按键或固定孔太近：插拔、按压和锁螺丝的应力会让零偏漂移"),
    ("LAY-12", "P2", {"temp_humidity"}, HEAT, 8.0, "温湿度传感器离发热器件太近：读数会偏高"),
    ("LAY-12", "P2", {"imu"}, HEAT, 5.0, "IMU 离发热器件太近：温漂会进入零偏"),
    ("LAY-12", "P2", {"crystal"}, HEAT, 4.0, "晶振离发热器件太近：频率随温度漂移"),
    ("LAY-12", "P2", {"battery"}, HEAT, 5.0, "电池离发热器件太近：温度升高加速老化"),
    ("LAY-13", "P1", {"magnetometer"}, {"inductor", "battery", "speaker", "motor"}, 10.0, "磁力计离电感、电池或磁性器件太近：硬铁干扰无法完全校准"),
    ("LAY-14", "P2", {"inductor"}, {"imu", "temp_humidity", "microphone", "barometer"}, 4.0, "功率电感离敏感传感器太近：磁场和开关噪声会耦合进去"),
]


def role_of(ref, value, roles):
    if ref in roles:
        return roles[ref]
    for pat, r in ROLE_RULES:
        if re.match(pat, ref, re.I):
            if r == "ic" and value and re.search(r"module|模组|ESP32-[A-Z]|-WROOM|-MINI", value, re.I):
                return "rf_module"
            if r == "inductor" and value and re.search(r"\d\s*nH", value, re.I):
                return "rf_match"                     # nH 级电感是射频匹配，不是功率电感
            if r in ("ic", "other") and value:
                for vp, vr in VALUE_ROLES:
                    if re.search(vp, value, re.I):
                        return vr
            return r
    return "other"


def rect_dist(a, b):
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return math.hypot(dx, dy)


def overlap(a, b, shrink=0.05):
    return min(a[2], b[2]) - max(a[0], b[0]) > shrink and min(a[3], b[3]) - max(a[1], b[1]) > shrink


def overlap_area(a, b):
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def point_in_poly(x, y, poly):
    return RL.point_in_poly(x, y, poly)


def model_outline(pack):
    """板框多边形，模型坐标（与 parts.rect 同一坐标系）。"""
    b = pack.get("board") or {}
    poly = b.get("outline") if isinstance(b, dict) else b
    if not poly:
        xs = [p["rect"][0] for p in pack["parts"]] + [p["rect"][2] for p in pack["parts"]]
        ys = [p["rect"][1] for p in pack["parts"]] + [p["rect"][3] for p in pack["parts"]]
        return [[min(xs), min(ys)], [max(xs), min(ys)], [max(xs), max(ys)], [min(xs), max(ys)]]
    return [list(p) for p in poly]


class Lint:
    def __init__(self, pack, brief=None):
        self.pack, self.brief = pack, brief or {}
        self.ctx = RL.Ctx(None, pack.get("frame"))
        self.issues = []
        self.poly = model_outline(pack)
        xs, ys = [p[0] for p in self.poly], [p[1] for p in self.poly]
        self.bb = (min(xs), min(ys), max(xs), max(ys))
        self.W, self.H = self.bb[2] - self.bb[0], self.bb[3] - self.bb[1]
        roles = (self.brief.get("roles") or {})
        self.parts = {p["ref"]: dict(p, role=role_of(p["ref"], p.get("value"), roles)) for p in pack.get("parts", []) if p.get("ref")}

    def add(self, rule, sev, refs, msg, fix="", at=None, zone=None):
        v = {"rule": rule, "sev": sev, "refs": list(refs), "msg": msg}
        if fix:
            v["fix"] = fix
        if at is not None:
            v["at"] = [round(at[0], 3), round(at[1], 3)]
            if self.pack.get("frame"):
                v["at_src"] = self.ctx.to_src(*at)
        if zone is not None:
            v["zone"] = [round(z, 3) for z in zone]
        self.issues.append(v)

    def center(self, r):
        return ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)

    def frac_rect(self, f):
        x0, y0 = self.bb[0], self.bb[1]
        return (x0 + f[0] * self.W, y0 + f[1] * self.H, x0 + f[2] * self.W, y0 + f[3] * self.H)

    def region_rect(self, reg):
        if isinstance(reg, str):
            key = reg.strip().lower().replace("_", "-").replace(" ", "-")
            if key in REGIONS:
                return self.frac_rect(REGIONS[key])
            return None
        if isinstance(reg, list) and len(reg) == 4 and all(isinstance(v, (int, float)) for v in reg):
            if all(0 <= v <= 1 for v in reg):
                return self.frac_rect(reg)
        if isinstance(reg, dict):
            if reg.get("rect_frac"):
                return self.frac_rect(reg["rect_frac"])
            if reg.get("rect_mm"):
                x0, y0, x1, y1 = reg["rect_mm"]
                a, b = self.ctx.to_model(x0, y0), self.ctx.to_model(x1, y1)
                return (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
        return None

    # ---------------------------------------------------------------- 机械
    def check_mechanical(self):
        for ref, p in self.parts.items():
            r = p["rect"]
            corners = [(r[0], r[1]), (r[2], r[1]), (r[2], r[3]), (r[0], r[3])]
            if not all(point_in_poly(x, y, self.poly) for x, y in corners) and p["role"] not in ("connector", "antenna"):
                self.add("LAY-01", "P0", [ref], f"{ref} 超出板框", "移回板框内，或确认板框是否画错", at=self.center(r))
        items = list(self.parts.items())
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                (ra, a), (rb, b) = items[i], items[j]
                if a.get("side") != b.get("side"):
                    continue
                if overlap(a["rect"], b["rect"]):
                    self.add("LAY-02", "P0", [ra, rb], f"{ra} 与 {rb} 焊盘区域重叠", "拉开至少一个器件本体的间距", at=self.center(a["rect"]))
        m = self.brief.get("G1_mechanical") or {}
        kos = m.get("keepouts") if isinstance(m.get("keepouts"), list) else []
        for k in kos:
            z = self.region_rect(k if isinstance(k, dict) else {"rect_frac": k})
            if not z:
                continue
            for ref, p in self.parts.items():
                if overlap(p["rect"], z, 0.0):
                    self.add("LAY-08", "P0", [ref], f"{ref} 进入禁布区（{k.get('reason', '禁布区') if isinstance(k, dict) else '禁布区'}）", "移出禁布区", at=self.center(p["rect"]), zone=z)
        fixed = m.get("fixed") if isinstance(m.get("fixed"), list) else []
        for f in fixed:
            if not isinstance(f, dict) or not f.get("ref"):
                continue
            ref = f["ref"]
            p = self.parts.get(ref)
            if not p:
                self.add("LAY-10", "P1", [ref], f"设计确认里的固定件 {ref} 在板上找不到", "核对位号，或在确认文件里更正")
                continue
            r, edge = p["rect"], f.get("edge")
            tol = float(f.get("tol_mm", 1.0) or 1.0)
            if edge in ("left", "right", "top", "bottom"):
                d = {"left": r[0] - self.bb[0], "right": self.bb[2] - r[2], "bottom": r[1] - self.bb[1], "top": self.bb[3] - r[3]}[edge]
                if d > tol + 1e-6:
                    tgt = {"left": (self.bb[0] + (r[2] - r[0]) / 2, self.center(r)[1]), "right": (self.bb[2] - (r[2] - r[0]) / 2, self.center(r)[1]),
                           "bottom": (self.center(r)[0], self.bb[1] + (r[3] - r[1]) / 2), "top": (self.center(r)[0], self.bb[3] - (r[3] - r[1]) / 2)}[edge]
                    self.add("LAY-03", "P0", [ref], f"{ref}（{f.get('what', '')}）应贴{EDGE_ZH[edge]}，现在离板边 {d:.1f} mm",
                             f"移到{EDGE_ZH[edge]}，原因：{f.get('reason', '外壳开孔')}", at=self.center(r), zone=(tgt[0], tgt[1], tgt[0], tgt[1]))
                along = f.get("along_mm")
                if isinstance(along, (int, float)):
                    c = self.center(r)
                    cur = (c[0] - self.bb[0]) if edge in ("top", "bottom") else (c[1] - self.bb[1])
                    if abs(cur - along) > tol + 1e-6:
                        if edge in ("top", "bottom"):
                            tgt = (self.bb[0] + along, c[1])
                        else:
                            tgt = (c[0], self.bb[1] + along)
                        self.add("LAY-03", "P1", [ref], f"{ref} 沿{EDGE_ZH[edge]}的位置是 {cur:.1f} mm，外壳要求 {along:g} ± {tol:g} mm",
                                 "按外壳开孔位置移动", at=c, zone=(tgt[0], tgt[1], tgt[0], tgt[1]))

    # ---------------------------------------------------------------- 分区
    def check_blocks(self):
        blocks = (self.brief.get("G2_partition") or {}).get("blocks")
        if not isinstance(blocks, list):
            return
        assigned = set()
        bboxes = []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            name = b.get("name", "?")
            refs = [r for r in b.get("parts", []) if isinstance(r, str)]
            assigned.update(refs)
            z = self.region_rect(b.get("region"))
            present = []
            for ref in refs:
                p = self.parts.get(ref)
                if not p:
                    self.add("LAY-10", "P1", [ref], f"功能块“{name}”里的 {ref} 在板上找不到", "核对位号")
                    continue
                present.append(p)
                if z:
                    c = self.center(p["rect"])
                    mx, my = 0.05 * self.W, 0.05 * self.H
                    if not (z[0] - mx <= c[0] <= z[2] + mx and z[1] - my <= c[1] <= z[3] + my):
                        reg = b.get("region")
                        self.add("LAY-04", "P1", [ref], f"{ref} 属于“{name}”，应在{REGION_ZH.get(reg, str(reg)) if isinstance(reg, str) else '指定区域'}，现在在区域外",
                                 "移回该功能块的区域，或和用户确认后修改分区", at=c, zone=z)
            major = [p for p in present if p["role"] in MAJOR] or present
            if major:
                bb = (min(p["rect"][0] for p in major), min(p["rect"][1] for p in major), max(p["rect"][2] for p in major), max(p["rect"][3] for p in major))
                bboxes.append((name, bb))
        for i in range(len(bboxes)):
            for j in range(i + 1, len(bboxes)):
                (na, a), (nb, b) = bboxes[i], bboxes[j]
                small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
                if small > 1 and overlap_area(a, b) > 0.3 * small:
                    self.add("LAY-05", "P2", [], f"功能块“{na}”与“{nb}”的主器件区域交叠超过 30%：分区不清，走线会互相穿插",
                             "把两个块的主器件分开摆，各自形成紧凑的一团", at=self.center(a), zone=(max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))
        for ref, p in self.parts.items():
            if p["role"] in MAJOR and ref not in assigned:
                self.add("LAY-09", "P2", [ref], f"{ref} 没有分到任何功能块", "在设计确认 G2 里把它归到一个功能块", at=self.center(p["rect"]))

    # ---------------------------------------------------------------- 射频与间距
    def check_rf_spacing(self):
        ants = [(r, p) for r, p in self.parts.items() if p["role"] in ("antenna", "rf_module")]
        blocks = (self.brief.get("G2_partition") or {}).get("blocks") or []
        rf_mates = set()
        for b in blocks if isinstance(blocks, list) else []:
            if isinstance(b, dict) and any(r in b.get("parts", []) for r, _ in ants):
                rf_mates.update(r for r in b.get("parts", []) if self.parts.get(r, {}).get("role") in ("cap", "res", "inductor", "other"))
        for ref, p in ants:
            r = p["rect"]
            d = min(r[0] - self.bb[0], self.bb[2] - r[2], r[1] - self.bb[1], self.bb[3] - r[3])
            if d > 0.5:
                self.add("LAY-06", "P1", [ref], f"天线 {ref} 不在板边（离最近板边 {d:.1f} mm）：净空区被板内铜皮和器件包围", "把天线移到板边，馈点朝板内", at=self.center(r))
            if p["role"] == "antenna":
                z = (r[0] - 3, r[1] - 3, r[2] + 3, r[3] + 3)
                for o, q in self.parts.items():
                    if o == ref or o in rf_mates or q["role"] in ("hole",):
                        continue
                    if overlap(q["rect"], z, 0.0) and rect_dist(q["rect"], r) < 3 - 1e-6:
                        self.add("LAY-06", "P1", [ref, o], f"{o} 在天线 {ref} 的 3 mm 净空区内", "移出净空区（匹配网络器件请在 G2 里和天线放进同一功能块）", at=self.center(q["rect"]), zone=z)
        for ref, p in self.parts.items():                   # LAY-11 IMU 离板边
            if p["role"] == "imu":
                r = p["rect"]
                d = min(r[0] - self.bb[0], self.bb[2] - r[2], r[1] - self.bb[1], self.bb[3] - r[3])
                if d < 3.0 - 1e-6:
                    self.add("LAY-11", "P2", [ref], f"IMU {ref} 离板边 {d:.1f} mm（建议 ≥ 3 mm）：板边受力最大，分板和装配应力会影响零偏", "往板内挪", at=self.center(r))
        pick = lambda roles: next((p for p in self.parts.values() if p["role"] in roles), None)   # noqa: E731
        chg, reg, main = pick({"charger"}), pick({"dcdc", "ldo"}), pick({"soc_rf", "mcu", "rf_module"})
        if chg and reg and main:                          # LAY-15 电源流向
            dc, dr = rect_dist(chg["rect"], main["rect"]), rect_dist(reg["rect"], main["rect"])
            if dr > dc + 1:
                self.add("LAY-15", "P3", [chg["ref"], reg["ref"], main["ref"]], f"电源流向绕路：稳压器 {reg['ref']} 离主控比充电芯片 {chg['ref']} 还远，电源要先绕到远处再回来",
                         "按 输入 → 充电 → 稳压 → 主控 的顺序排成一条线", at=self.center(reg["rect"]))
        seen = set()
        for rule, sev, A, B, dmin, why in MIN_DIST:
            for ra, a in self.parts.items():
                if a["role"] not in A:
                    continue
                for rb, b in self.parts.items():
                    if rb == ra or b["role"] not in B:
                        continue
                    key = (rule, tuple(sorted((ra, rb))))
                    if key in seen:
                        continue
                    d = rect_dist(a["rect"], b["rect"])
                    if d < dmin - 1e-6:
                        seen.add(key)
                        self.add(rule, sev, [ra, rb], f"{ra} 与 {rb} 相距 {d:.1f} mm（至少 {dmin:g} mm）：{why}", f"再拉开 {dmin - d:.1f} mm", at=self.center(a["rect"]))

    # ---------------------------------------------------------------- 就近原则
    def check_proximity(self):
        nets = [RL.norm_net(n) for n in self.pack.get("nets", [])]
        classes = {}
        for n in nets:
            classes[n["name"]] = RL.infer_class(n["name"], n["pads"])[0]
        RL.upgrade_pairs(classes, nets, self.ctx.cons, [])
        values = {p["ref"]: p.get("value") for p in self.pack.get("parts", [])}
        nL = len(self.pack.get("layers") or [])
        has_plane = any(n.get("zone") for n in self.pack.get("nets", []))
        before = len(self.ctx.out)
        RP.check_proximity(self.ctx, nets, classes, values, nL, has_plane)
        for v in self.ctx.out[before:]:
            refs = re.findall(r"(?<![.\w])[A-Z]{1,3}\d+\b", v["msg"])
            self.add(v["rule"], v["sev"], list(dict.fromkeys(refs))[:3], v["msg"], at=v.get("at"))

    def run(self):
        self.check_mechanical()
        if self.brief:
            self.check_blocks()
        self.check_rf_spacing()
        self.check_proximity()
        order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
        self.issues.sort(key=lambda v: (order.get(v["sev"], 9), v["rule"]))
        return self.issues


def run(pack, brief=None):
    L = Lint(pack, brief)
    issues = L.run()
    cnt = {s: sum(1 for v in issues if v["sev"] == s) for s in ("P0", "P1", "P2", "P3")}
    rep = {"kind": "lpiot-layout-lint", "version": 1, "p0": cnt["P0"], "p1": cnt["P1"], "p2": cnt["P2"], "p3": cnt["P3"],
           "pass": cnt["P0"] == 0, "issues": issues, "board_mm": [round(L.W, 2), round(L.H, 2)],
           "parts": {r: p["role"] for r, p in L.parts.items()}}
    if brief:
        import design_gate as DG
        rep["brief_hash"] = DG.gate_hash(brief, "G2")
        rep["brief_complete"] = {g: not DG.missing(brief, g) for g in ("G0", "G1", "G2")}
    else:
        rep["note"] = "没有设计确认文件：只做了通用检查。固定件位置、功能分区和禁布区需要 --brief 才能检查，也不能作为 G3 的依据。"
    return rep


def report_md(rep):
    lines = [f"# 布局检查报告", "", f"板子 {rep['board_mm'][0]} × {rep['board_mm'][1]} mm · P0 {rep['p0']} · P1 {rep['p1']} · P2 {rep['p2']} · "
             + ("通过（无 P0）" if rep["pass"] else "不通过（有 P0）"), ""]
    if rep.get("note"):
        lines += [f"> {rep['note']}", ""]
    lines += ["| 级别 | 规则 | 器件 | 问题 | 怎么改 |", "|---|---|---|---|---|"]
    for v in rep["issues"]:
        lines.append(f"| {v['sev']} | {v['rule']} | {'、'.join(v['refs'])} | {v['msg']} | {v.get('fix', '')} |")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="实板布局检查（对照设计确认文件）")
    ap.add_argument("board", help=".kicad_pcb 或 copper-pack.json")
    ap.add_argument("--brief", help="design-brief.json（固定件、功能分区、禁布区来自这里）")
    ap.add_argument("--json", help="写出 JSON 报告（G3 用）")
    ap.add_argument("-o", "--output", help="写出 Markdown 报告")
    a = ap.parse_args(argv)
    pack, _ = RL.load_any(a.board)
    brief = json.loads(Path(a.brief).read_text(encoding="utf-8")) if a.brief else None
    rep = run(pack, brief)
    md = report_md(rep)
    if a.json:
        Path(a.json).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    if a.output:
        Path(a.output).write_text(md, encoding="utf-8")
    print(md if not a.output else f"已写入 {a.output}：P0 {rep['p0']}、P1 {rep['p1']}、P2 {rep['p2']}")
    return 0 if rep["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
