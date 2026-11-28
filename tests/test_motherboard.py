"""真实板（nRF5340 / MDBT53，6 层 24.5 × 35.3 mm，作者同意公开）与 epro_import / length_match / route_fix --local 的测试。

运行：python -m unittest tests/test_motherboard.py
"""
import copy
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import epro_import as EI  # noqa: E402
import finish_lint as FL  # noqa: E402
import length_match as LM  # noqa: E402
import route_lint as R  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
PACK = json.loads((FIX / "motherboard-pack.json").read_text(encoding="utf-8"))
CONS = json.loads((FIX / "motherboard-constraints.json").read_text(encoding="utf-8"))
JTAG = [{"name": "JTAG 烧写口", "nets": ["TCK", "TMS", "TDI", "TDO"], "tol_mm": 0.05}]


def turn_angles(pts):
    out = []
    for a, b, c in zip(pts, pts[1:], pts[2:]):
        u, v = (a[0] - b[0], a[1] - b[1]), (c[0] - b[0], c[1] - b[1])
        out.append(R.angle_between(u, v))
    return out


class Meander(unittest.TestCase):
    def test_only_135_degree_corners_and_exact_length(self):
        for amp in (0.09, 0.2, 0.3, 0.6, 1.2):
            pts = LM.meander((0, 0), (5, 0), 0.15, amp, 2, 1.0, 1)
            for ang in turn_angles(pts):
                self.assertTrue(abs(ang - 135) < 0.5 or abs(ang - 180) < 0.5, (amp, ang))
            L = sum(math.dist(p, q) for p, q in zip(pts, pts[1:]))
            self.assertAlmostEqual(L - 5, 2 * LM.bump_add(amp, 0.15), places=3)
            self.assertAlmostEqual(LM.bump_amp(LM.bump_add(amp, 0.15), 0.15), amp, places=6)

    def test_board_jtag_group_matched_locally(self):
        nets = [R.norm_net(n) for n in PACK["nets"]]
        before = {n["name"]: [list(s) for s in n["segs"]] for n in nets}
        res = LM.plan(nets, JTAG, PACK["board"]["outline"], 0.1)
        self.assertEqual(res["manual"], [])
        self.assertEqual(sorted(f["net"] for f in res["fixed"]), ["TCK", "TDO", "TMS"])
        LM.apply(nets, res["changes"])
        rows = LM.length_rows(nets, JTAG)
        self.assertTrue(all(r["deficit"] == 0 and abs(r["len"] - r["target"]) < 0.001 for r in rows), rows)
        changed = {n["name"] for n in nets if n["segs"] != before[n["name"]]}
        self.assertEqual(changed, {"TCK", "TDO", "TMS"})                 # 只动了偏短的三根线
        for n in nets:                                                    # 每根只替换一段直线
            if n["name"] in changed:
                kept = [s for s in before[n["name"]] if s in n["segs"]]
                self.assertEqual(len(kept), len(before[n["name"]]) - 1)
        pack2 = dict(PACK, nets=[dict(p, segs=n["segs"]) for p, n in zip(PACK["nets"], nets)])
        rep = R.analyze(pack2, dict(CONS, length_groups=JTAG))
        bad = [v for v in rep["violations"] if v.get("net") in ("TCK", "TMS", "TDI", "TDO")]
        self.assertEqual(bad, [])                                         # 没有直角、锐角、短段，也不再有 RTL-07

    def test_rtl07_reported_and_manual_when_no_room(self):
        rep = R.analyze(PACK, dict(CONS, length_groups=JTAG))
        self.assertEqual(sorted(v["net"] for v in rep["violations"] if v["rule"] == "RTL-07"), ["TCK", "TDO", "TMS"])
        nets = [R.norm_net(n) for n in PACK["nets"]]
        res = LM.plan(nets, [{"name": "I2S", "nets": ["BCLK", "LRCLK"], "tol_mm": 0.1}], PACK["board"]["outline"], 0.1)
        self.assertEqual([m["net"] for m in res["manual"]], ["LRCLK"])  # 差 2 mm、没地方：交给人，不去动别的线
        self.assertEqual(res["changes"], [])


class RealBoardRules(unittest.TestCase):
    def test_module_x1_is_not_a_crystal(self):
        rep = R.analyze(PACK)
        self.assertNotEqual(rep["classes"]["V_LS"], "XTAL")
        self.assertEqual(rep["classes"]["XTALI"], "XTAL")

    def test_square_pads_allow_diagonal_exit_and_via_in_pad_plugged(self):
        rep = R.analyze(PACK, CONS)
        square = ("U12.3 ", "U12.6 ", "U12.7 ", "U12.8 ")                 # 0.254 mm 方形焊盘，45° 从角上出线不算
        self.assertFalse([v for v in rep["violations"] if v["rule"] == "RTG-07" and any(k in v["msg"] for k in square)])
        self.assertFalse([v for v in rep["violations"] if v["rule"] == "RTV-05" and v["sev"] == "P1"])

    def test_value_parser_ignores_part_numbers(self):
        for mpn in ("GRM033R61A105ME44D", "0201X225M6R3NT", "TCC0201X5R104M6R3ZT"):
            self.assertIsNone(FL.parse_value_unit(mpn), mpn)
        self.assertEqual(FL.parse_value_unit("10uF, >4V"), "F")

    def test_teardrops_from_epro_are_known(self):
        m = json.loads((FIX / "motherboard-finish.json").read_text(encoding="utf-8"))
        self.assertEqual(m["teardrop_source"], "epro")
        tear = sum(1 for j in m["junctions"] if j["teardrop"])
        self.assertGreater(tear, 0.6 * len(m["junctions"]))
        rep = FL.run(m, {"G5_finish": {"teardrops": {"policy": "全部焊盘与过孔"}, "silk": {"designators": "只印关键器件"}}})
        self.assertNotIn("TDR-00", {v["rule"] for v in rep["issues"]})

    def test_local_fix_only_touches_p0(self):
        import route_fix as F
        with tempfile.TemporaryDirectory() as d:
            src = FIX / "route-bad.kicad_pcb"
            out_full, out_local = Path(d) / "full.kicad_pcb", Path(d) / "local.kicad_pcb"
            full = F.fix_kicad(src, out_full)
            local = F.fix_kicad(src, out_local, local=True)
            self.assertLess(len(local["fixed"]), len(full["fixed"]))
            self.assertTrue(all(set(x["issues"]) & {"angle", "acute", "tee", "right"} for x in local["fixed"] if x.get("how") != "merge"))
            hard = lambda rep: [v for v in rep["violations"] if v["rule"] in ("RTG-01", "RTG-02", "RTG-03", "RTG-04")]   # noqa: E731
            h0 = hard(R.analyze(R.load_any(src)[0]))
            h1 = hard(R.analyze(R.load_any(out_local)[0]))
            self.assertLess(len(h1), len(h0))
            self.assertLessEqual({x["net"] for x in local["fixed"]}, {v["net"] for v in h0})   # 只碰有 P0 / P1 几何问题的网络


SAMPLE = "\n".join([
    '{"type":"DOCHEAD","ticket":1}||{"docType":"FOOTPRINT","uuid":"fp1"}|',
    '{"type":"META","ticket":2,"id":"META"}||{"title":"R0402"}|',
    '{"type":"PAD","ticket":3,"id":"p1"}||{"layerId":1,"num":"1","centerX":-20,"centerY":0,"padAngle":0,"hole":null,"defaultPad":{"padType":"RECT","width":20,"height":24}}|',
    '{"type":"PAD","ticket":4,"id":"p2"}||{"layerId":1,"num":"2","centerX":20,"centerY":0,"padAngle":0,"hole":null,"defaultPad":{"padType":"RECT","width":20,"height":24}}|',
    '{"type":"POLY","ticket":5,"id":"s1"}||{"layerId":3,"width":6,"path":[-40,20,"L",40,20]}|',
    '{"type":"DOCHEAD","ticket":6}||{"docType":"DEVICE","uuid":"dev1"}|',
    '{"type":"META","ticket":7,"id":"META"}||{"title":"R","attributes":{"Name":"10k"}}|',
    '{"type":"DOCHEAD","ticket":8}||{"docType":"PCB","uuid":"pcb1"}|',
    '{"type":"META","ticket":9,"id":"META"}||{"title":"PCB1"}|',
    '{"type":"LAYER","ticket":10,"id":"[\\"LAYER\\",1]"}||{"layerId":1,"layerType":"TOP","layerName":"Top","use":true}|',
    '{"type":"LAYER","ticket":11,"id":"[\\"LAYER\\",2]"}||{"layerId":2,"layerType":"BOTTOM","layerName":"Bottom","use":true}|',
    '{"type":"POLY","ticket":12,"id":"o"}||{"layerId":11,"width":10,"path":["R",0,0,400,200,0,0],"polyType":"BOARD_OUTLINE"}|',
    '{"type":"COMPONENT","ticket":13,"id":"c1"}||{"layerId":1,"x":200,"y":-100,"angle":90}|',
    '{"type":"ATTR","ticket":14,"id":"c1a"}||{"parentId":"c1","layerId":3,"x":null,"y":null,"key":"Footprint","value":"fp1"}|',
    '{"type":"ATTR","ticket":15,"id":"c1b"}||{"parentId":"c1","layerId":3,"x":240,"y":-100,"key":"Designator","value":"R1","fontSize":40,"strokeWidth":6,"origin":"LEFT_BOTTOM","angle":0,"valueVisible":true}|',
    '{"type":"ATTR","ticket":16,"id":"c1c"}||{"parentId":"c1","layerId":3,"x":null,"y":null,"key":"Device","value":"dev1"}|',
    '{"type":"PAD_NET","ticket":17,"id":"[\\"PAD_NET\\",\\"c1\\",\\"1\\",\\"p1\\"]"}||{"padNet":"A"}|',
    '{"type":"PAD_NET","ticket":18,"id":"[\\"PAD_NET\\",\\"c1\\",\\"2\\",\\"p2\\"]"}||{"padNet":"B"}|',
    '{"type":"LINE","ticket":19,"id":"l1"}||{"netName":"A","layerId":1,"startX":200,"startY":-120,"endX":200,"endY":-180,"width":8}|',
    '{"type":"VIA","ticket":20,"id":"v1"}||{"netName":"A","centerX":200,"centerY":-180,"viaDiameter":24}|',
    '{"type":"ARC","ticket":21,"id":"a1"}||{"netName":"B","layerId":2,"startX":100,"startY":-50,"endX":150,"endY":-100,"angle":90,"width":8}|',
])


class EproImport(unittest.TestCase):
    def test_minimal_project(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "t.epru"
            p.write_text(SAMPLE, encoding="utf-8")
            pack, silk = EI.import_epro(p)
        self.assertEqual(pack["layers"], ["F.Cu", "B.Cu"])
        self.assertAlmostEqual(pack["board"]["w"], 400 * 0.0254, places=3)
        r1 = pack["parts"][0]
        self.assertEqual((r1["ref"], r1["value"]), ("R1", "10k"))
        pads = {q[1]: q for n in pack["nets"] for q in n["pads"]}
        self.assertAlmostEqual(pads["1"][3], 200 * 0.0254, places=3)             # 转 90°：x 方向的焊盘到了 y 方向
        self.assertAlmostEqual(pads["1"][4], (-120 - (-200)) * 0.0254, places=3)   # 原点在板框左下角（y = −200 mil）
        a = next(n for n in pack["nets"] if n["name"] == "A")
        self.assertEqual(len(a["segs"]), 1)
        self.assertEqual(len(a["vias"]), 1)
        b = next(n for n in pack["nets"] if n["name"] == "B")
        self.assertTrue(all(s[6] for s in b["segs"]) and len(b["segs"]) == 6)
        self.assertAlmostEqual(b["segs"][-1][3], 150 * 0.0254, places=4)        # 圆弧的终点就是记录里的终点
        self.assertEqual(silk["texts"][0]["text"], "R1")
        self.assertEqual(len(silk["lines"]), 1)

    def test_arc_points_hit_endpoints(self):
        for ang in (30, 90, -90, 179, 270):
            pts = EI.arc_pts((0, 0), (10, 0), ang, 8)
            self.assertEqual(pts[0], (0, 0))
            self.assertEqual(pts[-1], (10, 0))
            r = [math.dist(p, pts[4]) for p in pts]
            self.assertTrue(all(x >= 0 for x in r))


if __name__ == "__main__":
    unittest.main()
