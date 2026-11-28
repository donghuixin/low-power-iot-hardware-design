"""design_gate.py（强制确认流程）与 layout_lint.py（实板布局检查）的测试。

运行：python -m unittest tests/test_design_gate.py
"""
import contextlib
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
import layout_lint as LL  # noqa: E402
import route_fix as F  # noqa: E402
import route_lint as R  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
GOOD = FIX / "principles-good.kicad_pcb"
BAD = FIX / "principles-bad.kicad_pcb"


def confirmed_brief(d, board=GOOD, upto="G4"):
    """在目录 d 里生成一份已确认到 upto 的设计确认文件（模拟用户逐级回复确认码）。"""
    path = Path(d) / "design-brief.json"
    shutil.copy(FIX / "brief-principles.json", path)
    b = DG.load(path)
    pack, _ = R.load_any(board)
    (Path(d) / "layout-lint.json").write_text(json.dumps(LL.run(pack, b), ensure_ascii=False), encoding="utf-8")
    for g in DG.GATES[: DG.GATES.index(upto) + 1]:
        DG.confirm(b, g, f"确认 {DG.code_of(b, g)}", base=d)
    DG.save(path, b)
    return path


def quiet(fn, *a):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return fn(*a)


class Template(unittest.TestCase):
    def test_template_everything_missing(self):
        b = DG.template()
        for g in DG.GATES:
            self.assertEqual(DG.gate_state(b, g)[0], "missing", g)
        self.assertTrue(DG.require(b, "place"))

    def test_placeholders_are_not_answers(self):
        b = DG.template()
        b["G0_requirements"]["wireless"] = "你定"
        b["G0_requirements"]["function"] = "随便"
        miss = "\n".join(DG.missing(b, "G0"))
        self.assertIn("无线方式", miss)
        self.assertIn("产品功能", miss)


class Confirmation(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.path = Path(self.d) / "b.json"
        shutil.copy(FIX / "brief-principles.json", self.path)
        self.b = DG.load(self.path)

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_quote_must_contain_code(self):
        with self.assertRaises(SystemExit):
            DG.confirm(self.b, "G0", "好的，没问题，继续吧")
        with self.assertRaises(SystemExit):
            DG.confirm(self.b, "G0", "")
        code = DG.code_of(self.b, "G0")
        DG.confirm(self.b, "G0", f"确认 {code}")
        self.assertEqual(DG.gate_state(self.b, "G0")[0], "confirmed")

    def test_cannot_skip_levels(self):
        with self.assertRaises(SystemExit):
            DG.confirm(self.b, "G1", f"确认 {DG.code_of(self.b, 'G1')}")

    def test_editing_earlier_gate_invalidates_later(self):
        b = DG.load(confirmed_brief(self.d))
        self.assertEqual(DG.require(b, "route", self.d), [])
        b["G1_mechanical"]["fixed"][0]["edge"] = "left"
        self.assertEqual(DG.gate_state(b, "G1", self.d)[0], "stale")
        self.assertIn(DG.gate_state(b, "G2", self.d)[0], ("blocked", "missing"))
        self.assertTrue(DG.require(b, "route", self.d))

    def test_layout_report_must_match_brief_and_have_no_p0(self):
        b = DG.load(confirmed_brief(self.d, upto="G2"))
        self.assertEqual(DG.gate_state(b, "G3", self.d)[0], "pending")
        b["G2_partition"]["signal_flow"] += "（改过）"
        self.assertIn("旧的", "\n".join(DG.missing(b, "G3", self.d)))

    def test_require_stage_cli(self):
        self.assertEqual(quiet(DG.main, ["require", str(self.path), "--stage", "route"]), 3)
        p = confirmed_brief(self.d)
        self.assertEqual(quiet(DG.main, ["require", str(p), "--stage", "route"]), 0)
        self.assertEqual(quiet(DG.main, ["require", str(p), "--stage", "deliver"]), 3)

    def test_canonical_matches_extension_format(self):
        self.assertEqual(DG.canonical({"b": 1.0, "a": [2.5, "中"]}), '{"a":[2.5,"中"],"b":1}')


class Enforcement(unittest.TestCase):
    def test_route_fix_refuses_without_brief(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "x.kicad_pcb"
            with self.assertRaises(SystemExit) as cm:
                quiet(F.main, [str(FIX / "route-bad.kicad_pcb"), "-o", str(out)])
            self.assertEqual(cm.exception.code, 3)
            self.assertFalse(out.exists())
            brief = Path(d) / "half.json"
            shutil.copy(FIX / "brief-principles.json", brief)
            with self.assertRaises(SystemExit):
                quiet(F.main, [str(FIX / "route-bad.kicad_pcb"), "-o", str(out), "--brief", str(brief)])
            self.assertFalse(out.exists())
            ok = confirmed_brief(d)
            self.assertEqual(quiet(F.main, [str(FIX / "route-bad.kicad_pcb"), "-o", str(out), "--brief", str(ok)]), 0)
            self.assertTrue(out.exists())

    def test_route_gate_refuses_without_brief(self):
        with self.assertRaises(SystemExit) as cm:
            quiet(R.main, ["gate", str(FIX / "route-good.kicad_pcb")])
        self.assertEqual(cm.exception.code, 3)


class LayoutLint(unittest.TestCase):
    def setUp(self):
        self.brief = json.loads((FIX / "brief-principles.json").read_text(encoding="utf-8"))

    def rules(self, board, brief):
        pack, _ = R.load_any(board)
        return LL.run(pack, brief)

    def test_good_board_clean(self):
        rep = self.rules(GOOD, self.brief)
        self.assertEqual(rep["p0"], 0)
        self.assertEqual(rep["p1"], 0, rep["issues"])

    def test_bad_board_partition_and_proximity(self):
        rep = self.rules(BAD, self.brief)
        got = {(v["rule"], tuple(v["refs"][:1])) for v in rep["issues"]}
        self.assertIn(("LAY-04", ("C4",)), got)
        self.assertIn("RTP-01", {v["rule"] for v in rep["issues"]})
        self.assertIn("RTP-05", {v["rule"] for v in rep["issues"]})

    def test_fixed_part_on_wrong_edge_is_p0(self):
        self.brief["G1_mechanical"]["fixed"][0]["edge"] = "left"
        rep = self.rules(GOOD, self.brief)
        self.assertTrue(any(v["rule"] == "LAY-03" and v["sev"] == "P0" for v in rep["issues"]))
        self.assertFalse(rep["pass"])

    def test_keepout_and_unknown_ref(self):
        self.brief["G1_mechanical"]["keepouts"] = [{"rect_frac": [0.4, 0.35, 0.7, 0.7], "reason": "电池压板"}]
        self.brief["G2_partition"]["blocks"][0]["parts"].append("U99")
        rep = self.rules(GOOD, self.brief)
        rules = {v["rule"] for v in rep["issues"]}
        self.assertIn("LAY-08", rules)
        self.assertIn("LAY-10", rules)

    def test_without_brief_notes_limits(self):
        rep = self.rules(GOOD, None)
        self.assertIn("note", rep)
        self.assertNotIn("brief_hash", rep)


if __name__ == "__main__":
    unittest.main()
