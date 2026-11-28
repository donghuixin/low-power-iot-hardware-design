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
}
# 布局检查对齐：板子 → 用哪份设计确认
LAYOUT = {"principles-good": "brief-principles.json", "principles-bad": "brief-principles.json", "demo-node": "demo-node-brief.json"}


def export(name, src):
    pack, _ = R.load_any(src)
    rep = R.analyze(pack)
    nets = []
    for n in pack["nets"]:
        m = R.norm_net(n)
        m.pop("class", None)
        nets.append(m)
    board = {"layers": pack["layers"], "nets": nets,
             "parts": [{"ref": p["ref"], "value": p.get("value")} for p in pack.get("parts", [])],
             "planes": (pack.get("checks") or {}).get("planes") or []}
    expect = {"score": rep["score"], "violations": [[v["rule"], v["sev"], v.get("net")] for v in rep["violations"]],
              "metrics": {k: e["deduct"] for k, e in rep["metrics"].items()}, "pairs": rep["pairs"]}
    return {"board": board, "expect": expect}


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


if __name__ == "__main__":
    main(sys.argv[1])
