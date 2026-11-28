"""finish_lint.py（丝印、位号编号、泪滴）与 G5 闸门的测试。

运行：python -m unittest tests/test_finish.py
"""
import contextlib
import copy
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import design_gate as DG  # noqa: E402
import finish_lint as FL  # noqa: E402
from test_design_gate import confirmed_brief  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
FB = json.loads((FIX / "finish-brief.json").read_text(encoding="utf-8"))


def lint(board, brief=FB, bom=None):
    return FL.run(FL.extract_kicad(FIX / board), brief, bom)


def rules(rep, sev=None):
    return {v["rule"] for v in rep["issues"] if sev is None or v["sev"] == sev}


class FinishLint(unittest.TestCase):
    def test_good_board_clean(self):
        rep = lint("finish-good.kicad_pcb")
        self.assertTrue(rep["pass"], rep["issues"])
        self.assertEqual(rep["issues"], [])
        self.assertEqual(rep["rules_hash"], DG.finish_rules_hash(FB))

    def test_bad_board_every_rule(self):
        rep = lint("finish-bad.kicad_pcb")
        self.assertFalse(rep["pass"])
        want = {"ANN-01", "ANN-02", "ANN-03", "ANN-04", "SLK-01", "SLK-02", "SLK-03", "SLK-04", "SLK-05", "SLK-06", "SLK-07",
                "SLK-09", "SLK-10", "SLK-11", "SLK-12", "SLK-13", "TDR-01", "TDR-02"}
        self.assertLessEqual(want, rules(rep))
        self.assertEqual(rules(rep, "P0"), {"ANN-01", "ANN-02"})

    def test_duplicates_do_not_pollute_geometry(self):
        rep = lint("finish-bad.kicad_pcb")
        self.assertFalse([v for v in rep["issues"] if v["rule"].startswith("SLK") and "C2" in v["refs"]])

    def test_teardrop_policy_none_and_rf_kept(self):
        b = copy.deepcopy(FB)
        b["G5_finish"]["teardrops"]["policy"] = "不加"
        self.assertNotIn("TDR-01", rules(lint("finish-bad.kicad_pcb", b)))
        b["G5_finish"]["teardrops"] = {"policy": "仅过孔和插件孔", "exclude_rf_diff": "保留"}
        self.assertNotIn("TDR-02", rules(lint("finish-bad.kicad_pcb", b)))

    def test_all_pads_policy_needs_smd_teardrops(self):
        b = copy.deepcopy(FB)
        b["G5_finish"]["teardrops"]["policy"] = "全部焊盘与过孔"
        rep = lint("finish-good.kicad_pcb", b)
        self.assertIn("TDR-01", rules(rep))
        self.assertTrue(any("U1." in v["msg"] for v in rep["issues"] if v["rule"] == "TDR-01"))

    def test_unknown_teardrops_become_manual_check(self):
        m = FL.extract_kicad(FIX / "finish-bad.kicad_pcb")
        m["teardrop_source"] = "none"
        for j in m["junctions"]:
            j["teardrop"] = None
        rep = FL.run(m, FB)
        self.assertIn("TDR-00", rules(rep))
        self.assertNotIn("TDR-01", rules(rep))

    def test_process_thresholds(self):
        b = copy.deepcopy(FB)
        b["G5_finish"]["silk"]["process"] = "镂空字"
        rep = lint("finish-good.kicad_pcb", b)
        self.assertIn("SLK-03", rules(rep))
        self.assertIn("SLK-02", rules(rep))
        b["G5_finish"]["silk"]["process"] = "高精度丝印"
        self.assertNotIn("SLK-03", rules(lint("finish-good.kicad_pcb", b)))

    def test_designator_policy_and_orientation(self):
        b = copy.deepcopy(FB)
        b["G5_finish"]["silk"]["designators"] = "不印（用装配图）"
        self.assertNotIn("SLK-06", rules(lint("finish-bad.kicad_pcb", b)))
        b["G5_finish"]["silk"]["orientation"] = "全部 0°"
        rep = lint("finish-good.kicad_pcb", b)
        self.assertEqual(rules(rep), set(), rep["issues"])       # 好板上没有 90° 文字

    def test_bom_mismatch(self):
        rep = lint("finish-good.kicad_pcb", bom=["U1", "R1", "C1", "D1", "J1", "SW1", "R9"])
        msgs = [v["msg"] for v in rep["issues"] if v["rule"] == "ANN-05"]
        self.assertTrue(any("R9" in m for m in msgs))
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "bom.csv"
            p.write_text("Comment,Designator,Footprint\n10k,\"R1\",0603\n100nF,\"C1,D1\",0603\n", encoding="utf-8")
            self.assertEqual(FL.load_bom(p), ["R1", "C1", "D1"])

    def test_without_brief_uses_defaults(self):
        rep = FL.run(FL.extract_kicad(FIX / "finish-good.kicad_pcb"))
        self.assertIn("note", rep)
        self.assertNotIn("rules_hash", rep)

    def test_value_units(self):
        self.assertEqual(FL.parse_value_unit("100nF"), "F")
        self.assertEqual(FL.parse_value_unit("4u7"), "F")
        self.assertEqual(FL.parse_value_unit("10k"), "Ω")
        self.assertEqual(FL.parse_value_unit("4R7"), "Ω")
        self.assertEqual(FL.parse_value_unit("2.2uH"), "H")
        self.assertIsNone(FL.parse_value_unit("LED red"))

    def test_teardrop_zones_are_not_pours(self):
        import route_lint as R
        pack, _ = R.load_any(FIX / "finish-good.kicad_pcb")
        self.assertFalse(any(n.get("zone") for n in pack["nets"]))


class FinishGate(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.path = confirmed_brief(self.d)
        b = DG.load(self.path)
        b["G5_finish"] = copy.deepcopy(FB["G5_finish"])
        DG.save(self.path, b)

    def tearDown(self):
        shutil.rmtree(self.d)

    def write_report(self, board="finish-good.kicad_pcb"):
        b = DG.load(self.path)
        rep = FL.run(FL.extract_kicad(FIX / board), b)
        (Path(self.d) / "finish-lint.json").write_text(json.dumps(rep, ensure_ascii=False), encoding="utf-8")
        return b

    def test_gate_order_and_stages(self):
        self.assertEqual(DG.GATES, ["G0", "G1", "G2", "G3", "G4", "G5", "G6"])
        self.assertIn("G5", DG.STAGES["finish"])
        self.assertNotIn("G5", DG.STAGES["route"])

    def test_every_question_must_be_answered(self):
        b = DG.load(self.path)
        b["G5_finish"] = DG.finish_template()
        miss = DG.missing(b, "G5", self.d)
        self.assertGreaterEqual(len([m for m in miss if "推荐" in m]), len(DG.FINISH_QUESTIONS))
        txt = DG.ask_text(b, "G5")
        for _, q, _, _, _ in DG.FINISH_QUESTIONS:
            self.assertIn(q, txt)
        self.assertIn("为什么要问", txt)
        self.assertIn("不能替用户选", txt)

    def test_options_and_values_validated(self):
        b = DG.load(self.path)
        b["G5_finish"]["silk"]["process"] = "丝网"
        b["G5_finish"]["silk"]["text_height_mm"] = 0.5
        b["G5_finish"]["teardrops"]["done"] = "不加泪滴"
        miss = " ".join(DG.missing(b, "G5", self.d))
        self.assertIn("只能选", miss)
        b["G5_finish"]["silk"]["process"] = "标准丝印"
        miss = " ".join(DG.missing(b, "G5", self.d))
        self.assertIn("至少 1 mm", miss)
        self.assertIn("执行记录", miss)

    def test_report_required_clean_and_current(self):
        self.assertIn("出图前检查报告", " ".join(DG.missing(DG.load(self.path), "G5", self.d)))
        self.write_report("finish-bad.kicad_pcb")
        miss = " ".join(DG.missing(DG.load(self.path), "G5", self.d))
        self.assertIn("P0", miss)
        self.assertIn("P1", miss)
        b = self.write_report()
        self.assertEqual(DG.missing(b, "G5", self.d), [])
        b["G5_finish"]["silk"]["designators"] = "只印关键器件"         # 改了决定，报告过期
        self.assertIn("旧的 G5", " ".join(DG.missing(b, "G5", self.d)))
        b["G5_finish"]["silk"]["designators"] = "全部显示"
        b["G5_finish"]["silk"]["review"]["screenshot"] = "silk-v2.png"  # 截图不影响报告
        self.assertEqual(DG.missing(b, "G5", self.d), [])

    def test_accepted_exceptions_clear_p1(self):
        b = DG.load(self.path)
        m = FL.extract_kicad(FIX / "finish-good.kicad_pcb")
        m["texts"] = [t for t in m["texts"] if t["text"] != "JLCJLCJLCJLC"]
        rep = FL.run(m, b)
        self.assertEqual([v["rule"] for v in rep["issues"]], ["SLK-13"])
        (Path(self.d) / "finish-lint.json").write_text(json.dumps(rep, ensure_ascii=False), encoding="utf-8")
        self.assertIn("SLK-13", " ".join(DG.missing(b, "G5", self.d)))
        b["G5_finish"]["accepted_exceptions"] = [{"rule": "SLK-13", "refs": [], "why": "外壳全包，订单号位置无所谓"}]
        self.assertEqual(DG.missing(b, "G5", self.d), [])

    def test_extension_report_needs_teardrop_record(self):
        b = self.write_report()
        rep = json.loads((Path(self.d) / "finish-lint.json").read_text(encoding="utf-8"))
        rep["teardrop_source"] = "none"
        b["G5_finish"]["result"] = rep
        b["G5_finish"]["teardrops"]["done"] = "待填"
        self.assertIn("执行泪滴", " ".join(DG.missing(b, "G5", self.d)))

    def test_confirm_g5_then_g6_blocked_until_g5(self):
        b = self.write_report()
        self.assertEqual(DG.gate_state(b, "G6", self.d)[0], "missing")
        b["G6_acceptance"] = {"route_report": "", "drc_errors": 0, "screenshots": ["r.png"],
                              "route_result": {"score": 90, "p0": 0, "pass": True}}
        self.assertEqual(DG.gate_state(b, "G6", self.d)[0], "blocked")
        DG.confirm(b, "G5", f"确认 {DG.code_of(b, 'G5')}", base=self.d)
        self.assertEqual(DG.gate_state(b, "G6", self.d)[0], "pending")
        self.assertEqual(DG.require(b, "finish", self.d), [])

    def test_migrate_old_brief(self):
        old = json.loads((FIX / "brief-principles.json").read_text(encoding="utf-8"))
        old.pop("G5_finish")
        old["G5_acceptance"] = old.pop("G6_acceptance")
        old["confirmations"] = {"G5": {"code": "G5-abcdef", "hash": "x"}}
        b = DG.migrate(old)
        self.assertIn("G6_acceptance", b)
        self.assertNotIn("G5_acceptance", b)
        self.assertNotIn("G5", b["confirmations"])
        self.assertIn("G5_finish", b)

    def test_cli_ask_and_lint(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            DG.main(["ask", str(self.path), "G5"])
        self.assertIn("问题都已回答", out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = FL.main([str(FIX / "finish-bad.kicad_pcb"), "--brief", str(self.path), "--json", str(Path(self.d) / "f.json")])
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads((Path(self.d) / "f.json").read_text(encoding="utf-8"))["kind"], "lpiot-finish-lint")


if __name__ == "__main__":
    unittest.main()
