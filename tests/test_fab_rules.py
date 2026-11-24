"""fab_rules.py 的单元测试。运行：python -m unittest tests/test_fab_rules.py"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import fab_rules as F  # noqa: E402

FIX = ROOT / "tests" / "fixtures"


class Units(unittest.TestCase):
    def test_to_mm(self):
        self.assertAlmostEqual(F.to_mm("3.5mil"), 0.0889)
        self.assertAlmostEqual(F.to_mm("4 mil (0.1mm)"), 0.1)
        self.assertAlmostEqual(F.to_mm("18um"), 0.018)
        self.assertAlmostEqual(F.to_mm("≥0.3"), 0.3)
        self.assertIsNone(F.to_mm("沉金"))

    def test_match_key(self):
        self.assertEqual(F.match_key("最小线宽"), "track_width")
        self.assertEqual(F.match_key("Min. via hole size"), "via_drill")
        self.assertEqual(F.match_key("过孔外径"), "via_diameter")
        self.assertEqual(F.match_key("铜到板边距离"), "copper_to_edge")
        self.assertIsNone(F.match_key("表面处理"))


class Profile(unittest.TestCase):
    def setUp(self):
        self.p = F.load_profile()

    def test_builtin_profile_is_consistent(self):
        self.assertEqual([t["id"] for t in self.p["tiers"]], ["economy", "standard", "extra", "extreme"])
        for key in ("2", "multi"):
            prev = None
            for t in self.p["tiers"]:                      # 越贵的档位，下限不会更大
                r = t["rules"][key]
                self.assertGreaterEqual(r["via_diameter"] - r["via_drill"], 0.1 - 1e-9)
                if prev:
                    for k in F.TIER_KEYS:
                        self.assertLessEqual(r[k], prev[k] + 1e-9, (t["id"], k))
                prev = r
        self.assertTrue(self.p["retrieved"] and all(s["url"] for s in self.p["sources"]))
        self.assertTrue(all(q.get("as_of") for q in self.p["pricing"]))

    def test_via_tiers(self):
        self.assertEqual(F.via_tier(self.p, 4, 1, 0.6, 0.3), 0)
        self.assertEqual(F.via_tier(self.p, 4, 1, 0.45, 0.2), 1)      # 多层 0.2/0.45 不加价
        self.assertEqual(F.via_tier(self.p, 4, 1, 0.4, 0.25), 2)      # 孔 < 0.3 且外径 ≤ 0.4：加价
        self.assertEqual(F.via_tier(self.p, 2, 1, 0.45, 0.2), 2)      # 2 层板 0.2 孔加价
        self.assertIsNone(F.via_tier(self.p, 4, 1, 0.15, 0.08))

    def test_2oz_copper_raises_limits(self):
        r = F.tier_rules(self.p, self.p["tiers"][1], 4, 2)
        self.assertAlmostEqual(r["track_width"], 0.15)


class Check(unittest.TestCase):
    def setUp(self):
        self.p = F.load_profile()

    def test_demo_board(self):
        d = F.read_design([FIX / "demo.kicad_pro", FIX / "demo-trace.kicad_pcb"])
        self.assertEqual(d["actual"]["layers"], 4)
        self.assertAlmostEqual(d["actual"]["tracks"][0][0], 0.10)
        rep = F.check(d, self.p)
        self.assertEqual(rep["tier"], "extra")
        self.assertTrue(any("0.25/0.4" in x for x in rep["drivers"]))
        self.assertTrue(any("标准" in t for t in rep["tips"]))
        titles = " ".join(f["title"] for f in rep["findings"])
        self.assertIn("铜到板边", titles)                               # 规则 0.15 < 下限 0.2
        self.assertIn("track_dangling", titles)
        self.assertIn("设计规则与工艺对照", F.report_md(rep, self.p))

    def test_rules_looser_than_actual(self):
        d = {"rules": {"track_width": 0.10, "clearance": 0.10}, "netclasses": [],
             "actual": {"layers": 2, "tracks": [[0.2, 10, "A"]], "vias": [[0.6, 0.3, 4, "A"]]}}
        rep = F.check(d, self.p)
        self.assertEqual(rep["actual_tier_name"], "经济")
        self.assertEqual(rep["tier"], "standard")
        self.assertTrue(any("收紧" in f["advice"] for f in rep["findings"]))

    def test_out_of_capability_is_p0(self):
        d = {"rules": {}, "netclasses": [], "actual": {"layers": 4, "tracks": [[0.05, 1, "A"]], "vias": []}}
        rep = F.check(d, self.p)
        self.assertEqual(rep["findings"][0]["sev"], "P0")
        self.assertIsNone(rep["tier"])
        self.assertEqual(rep["tier_name"], "超出能力")


class ImportEmit(unittest.TestCase):
    def test_import_csv_and_markdown(self):
        d = Path(tempfile.mkdtemp())
        (d / "fab.csv").write_text("参数,常规,加价\n最小线宽,6mil,4mil\n最小线距,6mil,4mil\n过孔内径,0.3mm,0.2mm\n过孔外径,0.6mm,0.45mm\n板边距,0.3mm\n表面处理,沉金\n", encoding="utf-8")
        prof, unknown = F.import_profile(d / "fab.csv")
        self.assertEqual([t["name"] for t in prof["tiers"]], ["常规", "加价"])
        self.assertAlmostEqual(prof["tiers"][1]["rules"]["multi"]["track_width"], 0.1016)
        self.assertEqual(prof["common"]["copper_to_edge"]["value"], 0.3)
        self.assertEqual(len(unknown), 1)
        (d / "fab.md").write_text("| 项目 | 能力 |\n|---|---|\n| Min trace width | 5 mil |\n| Min spacing | 5 mil |\n| Via hole | 0.3 mm |\n| Via diameter | 0.5 mm |\n", encoding="utf-8")
        prof2, _ = F.import_profile(d / "fab.md")
        self.assertEqual(len(prof2["tiers"]), 1)
        out = d / "p.json"; out.write_text(json.dumps(prof2, ensure_ascii=False), encoding="utf-8")
        rep = F.check({"rules": {}, "netclasses": [], "actual": {"layers": 2, "tracks": [[0.127, 3, "A"]], "vias": [[0.5, 0.3, 2, "A"]]}}, F.load_profile(out))
        self.assertEqual(rep["tier"], "standard")
        self.assertEqual(rep["findings"], [])

    def test_six_mil_equals_015(self):
        d = Path(tempfile.mkdtemp())
        (d / "f.csv").write_text("最小线宽,6mil\n最小线距,6mil\n过孔内径,0.3\n过孔外径,0.6\n", encoding="utf-8")
        prof, _ = F.import_profile(d / "f.csv")
        self.assertEqual(F.scalar_tier(prof, 2, 1, "track_width", 0.15), 0)

    def test_emit(self):
        dru, md, classes = F.emit(F.load_profile(), "standard", 4)
        self.assertIn("(version 1)", dru)
        self.assertIn("track_width (min 0.09mm)", dru)
        self.assertEqual(dru.count("("), dru.count(")"))
        self.assertTrue(all(c["via_diameter"] - c["via_drill"] >= 0.2 for c in classes))
        self.assertIn("Fine", md)
        f = Path(tempfile.mkdtemp()) / "fab.kicad_dru"
        f.write_text(dru, encoding="utf-8")
        rules = F.read_kicad_dru(f)["custom_rules"]
        self.assertGreaterEqual(len(rules), 6)
        self.assertAlmostEqual(rules[0]["constraints"][0]["min"], 0.09)

    def test_filled_template_imports(self):
        d = Path(tempfile.mkdtemp())
        lines = F.template_csv().splitlines()
        vals = {"最小线宽": "0.15mm,0.1mm,0.075mm", "最小线距": "0.15mm,0.1mm,0.075mm", "过孔最小孔径": "0.3mm,0.2mm,0.15mm", "过孔最小外径": "0.6mm,0.45mm,0.3mm"}
        out = [lines[0]] + [f"{l.split(',')[0]},{vals[l.split(',')[0]]},备注 5mil" if l.split(",")[0] in vals else l for l in lines[1:]]
        (d / "t.csv").write_text("\n".join(out), encoding="utf-8")
        prof, unknown = F.import_profile(d / "t.csv")
        self.assertEqual(len(prof["tiers"]), 3)
        self.assertEqual(prof["tiers"][2]["rules"]["2"]["via_drill"], 0.15)

    def test_template_roundtrip_keys(self):
        for line in F.template_csv().splitlines()[1:]:
            self.assertIsNotNone(F.match_key(line.split(",")[0]), line)


if __name__ == "__main__":
    unittest.main()
