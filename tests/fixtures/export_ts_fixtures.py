#!/usr/bin/env python3
"""把测试板导出成嘉立创 EDA 扩展（eext/lpiot-routing-check）的对齐测试数据：board + Python 版检查结果 expect。

    python tests/fixtures/export_ts_fixtures.py eext/lpiot-routing-check/test/fixtures

扩展的 test/parity.test.ts 逐条比对违规（规则、级别、网络）、各项扣分和总分。改了 route_lint.py 的规则后重新导出。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import route_lint as R  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
SOURCES = {
    "route-good": FIX / "route-good.kicad_pcb", "route-bad": FIX / "route-bad.kicad_pcb",
    "principles-good": FIX / "principles-good.kicad_pcb", "principles-bad": FIX / "principles-bad.kicad_pcb",
    "demo-plane": FIX / "copper-demo-plane.json", "demo-trace": FIX / "copper-demo-trace.json",
}


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


def main(out):
    d = Path(out)
    for name, src in SOURCES.items():
        (d / f"{name}.json").write_text(json.dumps(export(name, src), ensure_ascii=False), encoding="utf-8")
        print(f"{name}.json")


if __name__ == "__main__":
    main(sys.argv[1])
