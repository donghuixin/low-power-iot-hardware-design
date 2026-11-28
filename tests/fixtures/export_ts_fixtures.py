#!/usr/bin/env python3
"""把测试板导出成嘉立创 EDA 扩展（eext/lpiot-layout-routing-check）的对齐测试数据：board + Python 版检查结果 expect。

    python tests/fixtures/export_ts_fixtures.py eext/lpiot-layout-routing-check/test/fixtures

扩展的 test/parity.test.ts 逐条比对违规（规则、级别、网络）、各项扣分和总分。改了 route_lint.py 的规则后重新导出。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import layout_lint as LL  # noqa: E402
import route_lint as R  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
SOURCES = {
    "route-good": FIX / "route-good.kicad_pcb", "route-bad": FIX / "route-bad.kicad_pcb",
    "principles-good": FIX / "principles-good.kicad_pcb", "principles-bad": FIX / "principles-bad.kicad_pcb",
    "demo-plane": FIX / "copper-demo-plane.json", "demo-trace": FIX / "copper-demo-trace.json",
    "demo-node": FIX / "demo-node.kicad_pcb",
    "motherboard": FIX / "motherboard-pack.json",          # 真实板：nRF5340（MDBT53）6 层 24.5 × 35.3 mm，作者同意公开
}
# 带约束检查的板子（约束随板子一起导出，扩展用同样的约束检查）
CONS = {"motherboard": FIX / "motherboard-constraints.json"}
# 布局检查对齐：板子 → 用哪份设计确认
LAYOUT = {"principles-good": "brief-principles.json", "principles-bad": "brief-principles.json", "demo-node": "demo-node-brief.json"}


def export(name, src):
    pack, _ = R.load_any(src)
    cons = json.loads(CONS[name].read_text(encoding="utf-8")) if name in CONS else None
    rep = R.analyze(pack, cons)
    nets = []
    for n in pack["nets"]:
        m = R.norm_net(n)
        m.pop("class", None)
        nets.append(m)
    board = {"layers": pack["layers"], "nets": nets,
             "parts": [{"ref": p["ref"], "value": p.get("value")} for p in pack.get("parts", [])],
             "planes": (pack.get("checks") or {}).get("planes") or []}
    if pack.get("board", {}).get("outline") and name in CONS:
        board["outline"] = pack["board"]["outline"]
    expect = {"score": rep["score"], "violations": [[v["rule"], v["sev"], v.get("net")] for v in rep["violations"]],
              "metrics": {k: e["deduct"] for k, e in rep["metrics"].items()}, "pairs": rep["pairs"]}
    return {"board": board, "expect": expect, **({"cons": cons} if cons else {})}


def layout_expect():
    out = {}
    for name, bf in LAYOUT.items():
        pack, _ = R.load_any(SOURCES[name])
        brief = json.loads((FIX / bf).read_text(encoding="utf-8"))
        rep = LL.run(pack, brief)
        out[name] = {"brief": bf, "outline": pack["board"]["outline"], "brief_hash": rep["brief_hash"],
                     "issues": sorted([[v["rule"], v["sev"], (v["refs"] or [""])[0]] for v in rep["issues"]]),
                     "rects": {q["ref"]: q["rect"] for q in pack["parts"]}}
    return out


def main(out):
    d = Path(out)
    for name, src in SOURCES.items():
        (d / f"{name}.json").write_text(json.dumps(export(name, src), ensure_ascii=False), encoding="utf-8")
        print(f"{name}.json")
    # .txt 后缀：不被按 *.json 遍历的布线对齐测试当成板子
    (d / "layout-expect.json.txt").write_text(json.dumps(layout_expect(), ensure_ascii=False, indent=1), encoding="utf-8")
    for bf in set(LAYOUT.values()):
        (d / f"{bf}.txt").write_text((FIX / bf).read_text(encoding="utf-8"), encoding="utf-8")
    print("layout-expect.json.txt")
    # 布线优先级：Python 梳理的草稿和逐档确认码，扩展要算出同样的结果
    import design_gate as DG
    brief = json.loads((FIX / "demo-node-brief.json").read_text(encoding="utf-8"))
    pack, _ = R.load_any(SOURCES["demo-node"])
    brief["G4_routing_plan"]["priorities"] = DG.draft_priorities(pack)
    tiers = {"brief": brief, "codes": [DG.tier_code(brief, i) for i in range(len(DG.tier_list(brief)))],
             "tiers": [[t["tier"], t["nets"], t["method"]] for t in brief["G4_routing_plan"]["priorities"]]}
    (d / "tier-expect.json.txt").write_text(json.dumps(tiers, ensure_ascii=False, indent=1), encoding="utf-8")
    print("tier-expect.json.txt")
    # 出图前检查：中间模型 + Python 的检查结果；扩展的 finishCheck 要得出同样的问题
    import copy
    import finish_lint as FL
    fb = json.loads((FIX / "finish-brief.json").read_text(encoding="utf-8"))
    allpads = copy.deepcopy(fb)
    allpads["G5_finish"]["teardrops"]["policy"] = "全部焊盘与过孔"
    keyonly = copy.deepcopy(fb)
    keyonly["G5_finish"]["silk"].update(designators="只印关键器件", orientation="全部 0°", jlc_order_no="板厂默认位置", process="高精度丝印")
    keyonly["G5_finish"]["annotation"]["scheme"] = "保持现状"
    cases = {}
    for board in ("finish-good", "finish-bad"):
        m = FL.extract_kicad(FIX / f"{board}.kicad_pcb")
        for tag, br, bom in (("std", fb, None), ("allpads", allpads, None), ("keyonly", keyonly, ["U1", "R1", "C9"]), ("nobrief", None, None)):
            rep = FL.run(m, br, bom)
            cases[f"{board}/{tag}"] = {"board": board, "brief": tag, "bom": bom, "rules_hash": rep.get("rules_hash"),
                                       "issues": [[v["rule"], v["sev"], v["refs"]] for v in rep["issues"]], "msgs": [v["msg"] for v in rep["issues"]]}
        (d / f"finish-model-{board}.json.txt").write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
    fin = {"briefs": {"std": fb, "allpads": allpads, "keyonly": keyonly, "nobrief": None}, "cases": cases,
           "questions": [[q[0], q[1], q[2], q[3]] for q in DG.FINISH_QUESTIONS],
           "codes": [DG.code_of(json.loads((FIX / "brief-principles.json").read_text(encoding="utf-8")), g) for g in DG.GATES]}
    (d / "finish-expect.json.txt").write_text(json.dumps(fin, ensure_ascii=False, indent=1), encoding="utf-8")
    print("finish-expect.json.txt")
    # 等长组：真实板上的蛇形补偿，扩展要选同样的线段、同样的凸起数和高度
    import length_match as LM
    mb = json.loads((FIX / "motherboard-pack.json").read_text(encoding="utf-8"))
    groups = [{"name": "JTAG 烧写口", "nets": ["TCK", "TMS", "TDI", "TDO"], "tol_mm": 0.05}, {"name": "I2S", "nets": ["BCLK", "LRCLK"], "tol_mm": 0.1},
              {"name": "SD", "nets": ["SPI_CLK_SD", "SPI_MOSI_SD", "SPI_MISO_SD", "SPI_CS_SD"], "tol_mm": 0.05}]
    nets = [R.norm_net(n) for n in mb["nets"]]
    res = LM.plan(nets, groups, mb["board"]["outline"], 0.1)
    LM.apply(nets, res["changes"])
    lex = {"groups": groups, "rows": res["rows"], "fixed": [[f["net"], f["layer"], f["how"]] for f in res["fixed"]], "manual": [m["net"] for m in res["manual"]],
           "after": {r["net"]: r["len"] for r in LM.length_rows(nets, groups)}}
    (d / "length-expect.json.txt").write_text(json.dumps(lex, ensure_ascii=False, indent=1), encoding="utf-8")
    print("length-expect.json.txt")


if __name__ == "__main__":
    main(sys.argv[1])
