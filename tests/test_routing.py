"""route_lint.py / route_fix.py 的测试：几何工具、网络类推导、好/坏两块板的检查与评分、自动修复（不变量、幂等、读写往返）、
随机折线的性质测试、写入前闸门（plan.json）、fab_rules 生成的布线规则、铜皮数据包新增字段。

运行：python -m unittest tests/test_routing.py
"""
import json
import math
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import extract_copper as X  # noqa: E402
import fab_rules as FR  # noqa: E402
import route_fix as F  # noqa: E402
import route_lint as R  # noqa: E402

FIX = ROOT / "tests" / "fixtures"


def lint(path, cons=None):
    pack, _ = R.load_any(path)
    return R.analyze(pack, cons)


def rules_of(rep, sev=None):
    return {v["rule"] for v in rep["violations"] if sev is None or v["sev"] == sev}


def min_clearance(path):
    """不同网络走线之间（同层）的最小边缘间距。"""
    b = X.parse_kicad(path)
    segs = [s for s in b.segs if s[6]]
    best = 1e9
    for i, a in enumerate(segs):
        for c in segs[i + 1:]:
            if a[6] != c[6] and a[0] == c[0]:
                best = min(best, R.seg_seg(a[1:5], c[1:5]) - (a[5] + c[5]) / 2)
    return best


class Geometry(unittest.TestCase):
    def test_octilinear(self):
        self.assertTrue(R.is_octi(3, 0) and R.is_octi(0, -2) and R.is_octi(1.5, 1.5) and R.is_octi(-2, 2))
        self.assertFalse(R.is_octi(3, 1))
        self.assertFalse(R.is_octi(10, 10.01))            # 10 µm 偏差
        lat, deg = R.octi_dev(10, 1)
        self.assertAlmostEqual(deg, math.degrees(math.atan(0.1)), places=3)

    def test_d_oct(self):
        self.assertAlmostEqual(R.d_oct(3, 4), 4 + (math.sqrt(2) - 1) * 3)
        self.assertAlmostEqual(R.oct_mst([(0, 0), (5, 0), (5, 5)]), 10)

    def test_octi_paths_are_octilinear(self):
        for P, Q in [((0, 0), (5, 2)), ((1, 1), (-3, 7)), ((0, 0), (4, 4)), ((0, 0), (0, 3))]:
            for path in F.octi_paths(P, Q):
                self.assertEqual(path[0], P); self.assertAlmostEqual(path[-1][0], Q[0]); self.assertAlmostEqual(path[-1][1], Q[1])
                for a, b in zip(path, path[1:]):
                    self.assertTrue(R.is_octi(b[0] - a[0], b[1] - a[1]))

    def test_merge_overlaps(self):
        segs = [[0, 0, 0, 5, 0, 0.2, False], [0, 3, 0, 8, 0, 0.2, False], [0, 8, 0, 8, 3, 0.2, False]]
        out = F.merge_overlaps(segs)
        self.assertEqual(len(out), 2)
        self.assertTrue(any(abs(s[1]) < 1e-9 and abs(s[3] - 8) < 1e-9 for s in out))


class Classes(unittest.TestCase):
    def test_names(self):
        for name, cls in [("GND", "GND"), ("AGND", "GND"), ("VBAT", "PWR_MAIN"), ("+3V3", "PWR_LOW"), ("USB_DP", "USB90"),
                          ("XTAL_IN", "XTAL"), ("RF_ANT", "RF50"), ("SW", "SW"), ("I2C_SCL", "SIG"), ("SPI_SCK", "CLK"), ("ADC_IN", "ANALOG")]:
            self.assertEqual(R.infer_class(name)[0], cls, name)

    def test_rf_control_line_is_signal(self):
        self.assertEqual(R.infer_class("RF_EN")[0], "SIG")

    def test_topology(self):
        c, p, _ = R.infer_class("Net-(Y1-Pad1)", [{"ref": "Y1", "pin": "1"}, {"ref": "U1", "pin": "XI"}])
        self.assertEqual(c, "XTAL")
        c, p, _ = R.infer_class("Net-(U1-PA0)", [{"ref": "U1", "pin": "3"}])
        self.assertLess(p, 0.8)                            # 未命名网络要人确认


class LintBoards(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run([sys.executable, str(FIX / "make_route_fixtures.py"), str(FIX)], check=True)
        cls.good = lint(FIX / "route-good.kicad_pcb")
        cls.bad = lint(FIX / "route-bad.kicad_pcb")

    def test_good_board(self):
        self.assertTrue(self.good["pass"])
        self.assertGreaterEqual(self.good["score"], 90)
        self.assertEqual(self.good["metrics"]["VF-16"]["value"], 0)
        self.assertEqual(self.good["metrics"]["VF-17"]["value"], 0)
        self.assertFalse({"RTG-01", "RTG-02", "RTG-03", "RTG-06", "RTG-07", "RTG-12"} & rules_of(self.good))

    def test_bad_board_detects_injected_problems(self):
        self.assertFalse(self.bad["pass"])
        self.assertLessEqual(self.bad["score"], 65)
        got = rules_of(self.bad)
        for r in ["RTG-01", "RTG-02", "RTG-03", "RTG-05", "RTG-06", "RTG-07", "RTV-01", "RTL-11"]:
            self.assertIn(r, got, r)
        self.assertTrue(any(v["rule"] == "RTV-01" and v["net"] == "XIN" and v["sev"] == "P0" for v in self.bad["violations"]))
        self.assertTrue(any(v["rule"] == "RTG-07" and v["net"] == "SDA" and v["sev"] == "P1" for v in self.bad["violations"]))  # 0.3 mm 细焊盘斜出 → P1

    def test_coordinates_are_source_frame(self):
        v = next(v for v in self.bad["violations"] if v["rule"] == "RTG-07" and v["net"] == "SDA")
        self.assertEqual(v["at_src"], [9.5, 15.0])          # KiCad 坐标，U1.1 焊盘中心

    def test_exempt_zone(self):
        cons = {"exempt_zones": [{"poly": [[0, 0], [40, 0], [40, 30], [0, 30]], "rules": ["RTG-01"]}]}
        self.assertNotIn("RTG-01", rules_of(lint(FIX / "route-bad.kicad_pcb", cons)))

    def test_layer_direction(self):
        cons = {"layers": [{"name": "F.Cu", "role": "signal", "preferred_dir": "V"}, {"name": "B.Cu", "role": "gnd_plane"}]}
        rep = lint(FIX / "route-good.kicad_pcb", cons)
        self.assertIn("RTY-02", rules_of(rep))              # 顶层大多是水平走线，主方向设成竖直就该报

    def test_report_md(self):
        md = R.report_md(self.bad)
        self.assertIn("VF-16", md); self.assertIn("RTG-01", md)

    def test_cli_exit_codes(self):
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "route_lint.py"), "lint", str(FIX / "route-good.kicad_pcb")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout[-500:])
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "route_lint.py"), "lint", str(FIX / "route-bad.kicad_pcb")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)


class FixBoard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run([sys.executable, str(FIX / "make_route_fixtures.py"), str(FIX)], check=True)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "fixed.kicad_pcb"
        cls.rep = F.fix_kicad(FIX / "route-bad.kicad_pcb", cls.out, diff=Path(cls.tmp.name) / "diff.json")
        cls.after = lint(cls.out)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_geometry_fixed(self):
        m = self.after["metrics"]
        self.assertEqual(m["VF-16"]["value"], 0)
        self.assertEqual(m["VF-17"]["value"], 0)
        self.assertFalse({"RTG-01", "RTG-02", "RTG-03", "RTG-06", "RTG-07", "RTG-12"} & rules_of(self.after))
        self.assertGreater(self.after["score"], lint(FIX / "route-bad.kicad_pcb")["score"] + 25)

    def test_topology_problems_left_for_human(self):
        got = rules_of(self.after)
        self.assertIn("RTV-01", got)                        # 晶振过孔：几何修复不改拓扑
        self.assertIn("RTL-11", got)

    def test_connectivity_preserved(self):
        before = {n["name"]: F.components(n) for n in R.nets_from_board(X.parse_kicad(FIX / "route-bad.kicad_pcb"))}
        after = {n["name"]: F.components(n) for n in R.nets_from_board(X.parse_kicad(self.out))}
        self.assertEqual(before, after)

    def test_clearance_not_worse(self):
        self.assertGreaterEqual(min_clearance(self.out), min(0.15, min_clearance(FIX / "route-bad.kicad_pcb")) - 1e-4)

    def test_idempotent(self):
        out2 = Path(self.tmp.name) / "fixed2.kicad_pcb"
        rep2 = F.fix_kicad(self.out, out2)
        self.assertEqual(rep2["fixed"], [])
        self.assertEqual((rep2["removed"], rep2["added"]), (0, 0))

    def test_file_round_trip(self):
        text = self.out.read_text(encoding="utf-8")
        self.assertEqual(text.count("("), text.count(")"))
        b = X.parse_kicad(self.out)
        self.assertEqual(len(b.parts), len(X.parse_kicad(FIX / "route-bad.kicad_pcb").parts))
        self.assertIn('(uuid "', text.split("(segment")[-1])  # 新线段沿用文件里的 uuid 写法
        self.assertTrue((Path(self.tmp.name) / "diff.json").exists())

    def test_good_board_untouched(self):
        out = Path(self.tmp.name) / "good-fixed.kicad_pcb"
        rep = F.fix_kicad(FIX / "route-good.kicad_pcb", out)
        self.assertEqual(rep["fixed"], [])

    def test_locked_net_untouched(self):
        out = Path(self.tmp.name) / "locked.kicad_pcb"
        rep = F.fix_kicad(FIX / "route-bad.kicad_pcb", out, cons={"locks": [{"net": "SDA"}]})
        self.assertFalse(any(r["net"] == "SDA" for r in rep["fixed"]))


class Principles(unittest.TestCase):
    """走线原则：就近、差分、优先级倒挂、隔离（route_principles.py）。"""

    @classmethod
    def setUpClass(cls):
        subprocess.run([sys.executable, str(FIX / "make_route_fixtures.py"), str(FIX)], check=True)
        cls.good = lint(FIX / "principles-good.kicad_pcb")
        cls.bad = lint(FIX / "principles-bad.kicad_pcb")

    def by_rule(self, rep, rule):
        return [v for v in rep["violations"] if v["rule"] == rule]

    def test_good_board_clean(self):
        bad = [v for v in self.good["violations"] if v["rule"][:3] in ("RTP", "RTD", "RTO") or v["rule"] == "RTS-06"]
        self.assertEqual(bad, [])
        self.assertGreaterEqual(self.good["score"], 95)
        self.assertEqual({(p["p"], p["n"], p["class"]) for p in self.good["pairs"]},
                         {("USB_DP", "USB_DM", "USB90"), ("LVDS_P", "LVDS_N", "DIFF100")})

    def test_proximity(self):
        r = self.by_rule(self.bad, "RTP-01")
        self.assertTrue(r and r[0]["sev"] == "P1" and "C1" in r[0]["msg"])
        self.assertTrue(any("C1" in v["msg"] for v in self.by_rule(self.bad, "RTP-03")))
        self.assertEqual({v["net"] for v in self.by_rule(self.bad, "RTP-04")}, {"XIN", "XOUT"})
        self.assertTrue(self.by_rule(self.bad, "RTP-05"))
        self.assertTrue(any("更靠近芯片" in v["msg"] for v in self.by_rule(self.bad, "RTP-06")))
        self.assertTrue(any("R5" in v["msg"] for v in self.by_rule(self.bad, "RTP-07")))

    def test_diff_pairs(self):
        got = {v["rule"]: v for v in self.bad["violations"] if v["rule"].startswith("RTD")}
        for r in ("RTD-01", "RTD-03", "RTD-04", "RTD-05", "RTD-06"):
            self.assertIn(r, got, r)
        self.assertIn("USB_DP/USB_DM", got["RTD-04"]["net"])
        self.assertIn("CS", got["RTD-06"]["msg"])
        self.assertIn("LVDS", got["RTD-03"]["net"])

    def test_ground_and_decap_vias(self):
        r = self.by_rule(self.bad, "RTP-08")
        self.assertTrue(r and "C2" in r[0]["msg"] and r[0]["value"] == 2)
        e = self.by_rule(self.bad, "RTV-08")
        self.assertTrue(e and e[0]["value"] == 1)
        self.assertFalse(self.by_rule(self.good, "RTV-08"))
        nets = [{"name": n, "segs": [[0, 0, 0, 1, 0, 0.2, False]], "vias": [], "pads": []} for n in ("AGND", "DGND", "SDA")]
        rep = R.analyze({"layers": ["F.Cu", "B.Cu"], "nets": nets})
        self.assertTrue(any(v["rule"] == "RTY-06" and v["sev"] == "P3" for v in rep["violations"]))

    def test_priority_and_isolation(self):
        inv = self.by_rule(self.bad, "RTO-01")
        self.assertEqual({v["net"] for v in inv}, {"XIN", "XOUT"})
        self.assertTrue(all("LED" in v["msg"] for v in inv))
        self.assertTrue(any("SW" in v["net"] and "ADC_IN" in v["net"] for v in self.by_rule(self.bad, "RTS-06")))

    def test_metrics(self):
        for k in ("VF-28", "VF-29", "VF-30"):
            self.assertEqual(self.good["metrics"][k]["deduct"], 0)
            self.assertGreater(self.bad["metrics"][k]["deduct"], 0, k)

    def test_order(self):
        import route_principles as RP
        pack, _ = R.load_any(FIX / "principles-good.kicad_pcb")
        rep = R.analyze(pack)
        rows = RP.routing_order([R.norm_net(n) for n in pack["nets"]], rep["classes"])
        names = [r["net"] for r in rows]
        tiers = [r["tier"] for r in rows]
        self.assertEqual(tiers, sorted(tiers))
        self.assertLess(names.index("XIN"), names.index("USB_DP"))
        self.assertLess(names.index("USB_DP"), names.index("ADC_IN"))
        self.assertLess(names.index("VDD"), names.index("LED"))
        self.assertEqual(names[-1], "GND")
        self.assertEqual(R.main(["order", str(FIX / "principles-good.kicad_pcb")]), 0)

    def test_pair_naming(self):
        import route_principles as RP
        pairs = RP.pair_names(["USB_DP", "USB_DM", "CLK+", "CLK-", "TXP", "TXN", "VINP", "VINN", "GPIO_P", "SDA", "MIPI_D0_P", "MIPI_D0_N"])
        self.assertIn(("USB_DP", "USB_DM"), pairs); self.assertIn(("CLK+", "CLK-"), pairs); self.assertIn(("TXP", "TXN"), pairs)
        self.assertIn(("MIPI_D0_P", "MIPI_D0_N"), pairs); self.assertIn(("VINP", "VINN"), pairs)
        self.assertFalse(any("GPIO_P" in p for p in pairs))

    def test_parse_value(self):
        import route_principles as RP
        for v, f in [("100nF", 1e-7), ("0.1uF", 1e-7), ("4u7", 4.7e-6), ("10u/16V", 1e-5), ("12pF", 1.2e-11), ("DNP", None)]:
            got = RP.parse_value(v)
            self.assertTrue((got is None and f is None) or abs(got - f) < f * 1e-6, (v, got))

    def test_fixer_leaves_placement_alone(self):
        with tempfile.TemporaryDirectory() as d:
            rep = F.fix_kicad(FIX / "principles-good.kicad_pcb", Path(d) / "x.kicad_pcb")
            self.assertEqual(rep["fixed"], [])


class RandomPolylines(unittest.TestCase):
    """随机两焊盘网络 + 随机折线：修复后要么全是八方向、无锐角、出线正确、连通不变，要么明确标为 needs_manual。"""

    def test_property(self):
        rng = random.Random(20261127)
        ok = manual = 0
        for k in range(200):
            pads = []
            for i in range(2):
                w, h = rng.choice([(0.3, 1.0), (1.0, 0.3), (0.8, 0.9), (0.6, 1.4)])
                pads.append({"ref": f"U{i}", "pin": "1", "l": 0, "x": rng.uniform(0, 20), "y": rng.uniform(0, 20), "w": w, "h": h, "rot": 0.0, "shape": "rect"})
            pts = [(pads[0]["x"], pads[0]["y"])] + [(rng.uniform(-2, 22), rng.uniform(-2, 22)) for _ in range(rng.randint(0, 3))] + [(pads[1]["x"], pads[1]["y"])]
            net = {"name": f"N{k}", "segs": [[0, a[0], a[1], b[0], b[1], 0.2, False] for a, b in zip(pts, pts[1:]) if math.dist(a, b) > 1e-3],
                   "vias": [], "pads": pads}
            if not net["segs"]:
                continue
            before = F.components(net)
            fx = F.Fixer([net], ["F.Cu"], None, 0.15, None, True)
            fx.run()
            self.assertEqual(F.components(net), before, k)
            if fx.manual:
                manual += 1
                continue
            g = R.Graph(net["segs"], net["pads"], [], 0)
            for e in g.edges:
                self.assertTrue(R.is_octi(e["b"][0] - e["a"][0], e["b"][1] - e["a"][1], 2e-4), (k, e))
            ctx = R.Ctx()
            stats = {s: 0 for s in ("angle", "acute", "short", "jog", "exit", "wchange", "stub", "segs", "bends")}
            stats["excess"] = []
            R.check_graph(ctx, g, net["name"], "SIG", R.class_rules("SIG"), stats)
            bad = [v for v in ctx.out if v["rule"] in ("RTG-01", "RTG-02", "RTG-03", "RTG-07")]
            self.assertEqual(bad, [], k)
            ok += 1
        self.assertGreaterEqual(ok, 150)                    # 绝大多数应能自动修好


class PlanGate(unittest.TestCase):
    PLAN = {"units": "mil", "ydown": True, "layers": ["TOP", "BOTTOM"],
            "pads": [{"ref": "U1", "pin": "1", "layer": "TOP", "x": 0, "y": 0, "w": 12, "h": 40, "net": "SDA"},
                     {"ref": "R1", "pin": "1", "layer": "TOP", "x": 600, "y": -350, "w": 32, "h": 35, "net": "SDA"}],
            "segs": [["TOP", 0, 0, 600, -350, 8, "SDA"]], "vias": [], "outline": [[-200, -600], [800, -600], [800, 200], [-200, 200]]}

    def test_gate_blocks_then_fix_passes(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "plan.json"; p.write_text(json.dumps(self.PLAN), encoding="utf-8")
            self.assertEqual(R.main(["gate", str(p)]), 1)
            out = Path(d) / "plan-fixed.json"
            F.fix_plan(p, out)
            self.assertEqual(R.main(["gate", str(out)]), 0)
            fixed = json.loads(out.read_text(encoding="utf-8"))
            self.assertTrue(all(s[6] == "SDA" and s[0] == "TOP" for s in fixed["segs"]))
            self.assertEqual(fixed["units"], "mil")
            ends = {(s[1], s[2]) for s in fixed["segs"]} | {(s[3], s[4]) for s in fixed["segs"]}
            self.assertIn((0.0, 0.0), ends); self.assertIn((600.0, -350.0), ends)


class Integration(unittest.TestCase):
    def test_fab_rules_emit_routing(self):
        with tempfile.TemporaryDirectory() as d:
            FR.main(["emit", "--layers", "2", "-o", d])
            t = (Path(d) / "routing.kicad_dru").read_text(encoding="utf-8")
            self.assertIn("track_angle", t); self.assertIn("track_segment_length", t); self.assertIn("via_count", t)
            self.assertEqual(t.count("("), t.count(")"))

    def test_constraints_command(self):
        subprocess.run([sys.executable, str(FIX / "make_route_fixtures.py"), str(FIX)], check=True)
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "c.json"
            R.main(["constraints", str(FIX / "route-good.kicad_pcb"), "--layers", "4", "-o", str(out)])
            c = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(c["schema"], "lpiot-routing/1.0")
            self.assertEqual(c["nets"]["XIN"]["class"], "XTAL")
            self.assertEqual(c["layers"][1]["role"], "gnd_plane")
            self.assertEqual(c["layers"][0]["preferred_dir"], "H")   # 板子 40 × 30，长轴水平

    def test_example_constraints_valid_shape(self):
        schema = json.loads((ROOT / "assets" / "routing" / "constraints.schema.json").read_text(encoding="utf-8"))
        ex = json.loads((ROOT / "assets" / "routing" / "constraints-example.json").read_text(encoding="utf-8"))
        self.assertEqual(ex["schema"], schema["properties"]["schema"]["const"])
        for k in ex:
            if not k.startswith("_"):
                self.assertIn(k, schema["properties"], k)

    def test_pack_part_values(self):
        subprocess.run([sys.executable, str(FIX / "make_route_fixtures.py"), str(FIX)], check=True)
        pack = X.build_pack(X.parse_kicad(FIX / "principles-good.kicad_pcb"))
        vals = {p["ref"]: p.get("value") for p in pack["parts"]}
        self.assertEqual(vals["C1"], "100nF")
        self.assertIn("VF-29", pack["checks"]["routing"]["metrics"])

    def test_pack_has_routing_fields(self):
        subprocess.run([sys.executable, str(FIX / "make_route_fixtures.py"), str(FIX)], check=True)
        pack = X.build_pack(X.parse_kicad(FIX / "route-bad.kicad_pcb"))
        self.assertIn("frame", pack)
        self.assertTrue(pack["checks"]["planes"])
        self.assertIn("routing", pack["checks"])
        self.assertLessEqual(pack["checks"]["routing"]["score"], 65)
        n = next(q for q in pack["nets"] if q["name"] == "SDA")
        self.assertEqual(len(n["pads"][0]), 9)              # ref, pin, layer, x, y, w, h, rot, shape
        gnd_b = next(p for p in pack["checks"]["planes"] if p["layer"] == 1)
        self.assertGreater(gnd_b["gnd_frac"], 0.9)


if __name__ == "__main__":
    unittest.main()
