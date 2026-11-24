"""extract_copper.py 的单元测试：KiCad 合成板（好/坏两块）和一块最小的 Gerber + IPC-D-356 板。

运行：python -m unittest tests/test_extract_copper.py
"""
import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import extract_copper as X  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
PROJECT = ROOT / "assets" / "layout-verify-example.json"


def unrle(s, n):
    b = base64.b64decode(s)
    out, k = [0] * n, 0
    for i in range(0, len(b) - 2, 3):
        c = b[i] | (b[i + 1] << 8)
        for q in range(k, min(n, k + c)):
            out[q] = b[i + 2]
        k += c
    return out


class KiCadDemo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run([sys.executable, str(FIX / "make_demo_pcb.py"), str(FIX)], check=True, capture_output=True)
        cls.packs = {}
        proj = json.loads(PROJECT.read_text(encoding="utf-8"))
        for v in ("plane", "trace"):
            cls.packs[v] = X.build_pack(X.parse_kicad(FIX / f"demo-{v}.kicad_pcb"), proj)

    def test_header_and_grid(self):
        p = self.packs["plane"]
        self.assertEqual(p["kind"], "copper-pack")
        self.assertEqual(p["layers"], ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"])
        self.assertLessEqual(max(p["grid"]["nx"], p["grid"]["ny"]), 201)
        self.assertAlmostEqual(p["board"]["w"], 36.0, places=2)

    def test_net_classes(self):
        n = {q["name"]: q for q in self.packs["plane"]["nets"]}
        self.assertEqual(n["GND"]["class"], "ground")
        self.assertEqual(n["RF_FEED"]["group"], "rf")
        self.assertEqual(n["ADC_IN"]["group"], "analog")
        self.assertEqual(n["SPI_IMU"]["group"], "digital")
        self.assertIn("cov", n["VDD"])

    def test_plane_coverage(self):
        p = self.packs["plane"]
        g = p["grid"]
        gnd = next(q for q in p["nets"] if q["name"] == "GND")
        cov = unrle(gnd["cov"]["1"], g["nx"] * g["ny"])
        self.assertGreater(sum(1 for v in cov if v > 128) / len(cov), 0.6)   # L2 基本整层是地

    def test_y_axis_up(self):
        p = self.packs["plane"]
        u1 = next(q for q in p["parts"] if q["ref"] == "U1")
        self.assertAlmostEqual(u1["y"], 20.0, delta=1.0)                       # 与规划器坐标一致（y 向上）
        bt = next(q for q in p["parts"] if q["ref"] == "BT1")
        self.assertEqual(bt["side"], "bottom")

    def test_checks_good_vs_bad(self):
        good, bad = self.packs["plane"]["checks"], self.packs["trace"]["checks"]
        self.assertEqual(good["islands"], [])
        self.assertEqual(len(bad["islands"]), 1)
        self.assertGreaterEqual(good["rf"][0]["ref_ok"], 0.99)
        self.assertLess(bad["rf"][0]["ref_ok"], 0.97)
        self.assertEqual(good["coupling"], [])
        self.assertGreater(bad["coupling"][0]["ratio"], 20)

    def test_neck_width(self):
        vdd = next(q for q in self.packs["trace"]["nets"] if q["name"] == "VDD")
        self.assertAlmostEqual(vdd["min_w"], 0.10, places=3)


class Detours(unittest.TestCase):
    def test_mst(self):
        self.assertAlmostEqual(X.mst_length([(0, 0), (3, 0), (3, 4)]), 7.0)
        self.assertAlmostEqual(X.mst_length([(0, 0), (0, 0)]), 0.0)

    def test_detour_flagged(self):
        pads = [["U1", "1", 0, 0, 0], ["U2", "1", 0, 10, 0]]
        straight = [[0, 0, 0, 10, 0, 0.2]]
        around = [[0, 0, 0, 0, 5, 0.2], [0, 0, 5, 10, 5, 0.2], [0, 10, 5, 10, 0, 0.2]]
        out = X.detour_checks({"A": (straight, pads), "B": (around, pads), "GND": (around, pads)}, skip={"GND"})
        self.assertEqual([d["net"] for d in out], ["B"])
        self.assertAlmostEqual(out[0]["ratio"], 2.0)

    def test_demo_boards(self):
        proj = json.loads(PROJECT.read_text(encoding="utf-8"))
        good = X.build_pack(X.parse_kicad(FIX / "demo-plane.kicad_pcb"), proj)["checks"]["detours"]
        bad = X.build_pack(X.parse_kicad(FIX / "demo-trace.kicad_pcb"), proj)["checks"]["detours"]
        self.assertEqual(good, [])
        self.assertIn("SPI_IMU", [d["net"] for d in bad])


class GerberIPC(unittest.TestCase):
    """两层板：顶层一根 GND 粗线 + 一根 SIG 细线，底层一块 GND 铺铜；板框 20×10。"""

    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        head = "%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.500000*%\n%ADD11C,0.200000*%\n%ADD12R,1.000000X1.000000*%\n"
        top = head + "D10*\nX2000000Y5000000D02*\nX18000000Y5000000D01*\nD11*\nX2000000Y8000000D02*\nX18000000Y8000000D01*\nD12*\nX2000000Y8000000D03*\nX18000000Y8000000D03*\nM02*\n"
        bot = head + "G36*\nX1000000Y1000000D02*\nX19000000Y1000000D01*\nX19000000Y6500000D01*\nX1000000Y6500000D01*\nX1000000Y1000000D01*\nG37*\nM02*\n"
        edge = head + "D11*\nX0Y0D02*\nX20000000Y0D01*\nX20000000Y10000000D01*\nX0Y10000000D01*\nX0Y0D01*\nM02*\n"
        (self.d / "top.gtl").write_text(top)
        (self.d / "bot.gbl").write_text(bot)
        (self.d / "edge.gko").write_text(edge)

        def rec(code, net, ref, pin, acc, x, y):
            return f"{code}{net:<14}   {ref:<6}-{pin:<4} D0000PA{acc:02d}X{int(x * 1000):+07d}Y{int(y * 1000):+07d}"
        lines = ["C  test", "P  UNITS CUST 1",
                 rec("327", "GND", "U1", "1", 1, 2, 5), rec("327", "GND", "U2", "1", 1, 18, 5),
                 rec("317", "GND", "VIA", "", 0, 10, 5),
                 rec("327", "SIG", "U1", "2", 1, 2, 8), rec("327", "SIG", "U2", "2", 1, 18, 8), "999"]
        (self.d / "net.ipc").write_text("\n".join(lines) + "\n")

    def test_pipeline(self):
        out = self.d / "pack.json"
        X.main([ "--gerber", str(self.d / "top.gtl"), str(self.d / "bot.gbl"), "--outline", str(self.d / "edge.gko"),
                 "--ipc356", str(self.d / "net.ipc"), "-o", str(out)])
        p = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(p["source"], "gerber")
        self.assertAlmostEqual(p["board"]["w"], 20.0, places=1)
        n = {q["name"]: q for q in p["nets"]}
        self.assertEqual(set(n), {"GND", "SIG"})
        self.assertTrue(any(abs(s[5] - 0.5) < 1e-6 for s in n["GND"]["segs"]))     # 粗线归到 GND
        self.assertTrue(any(abs(s[5] - 0.2) < 1e-6 for s in n["SIG"]["segs"]))
        self.assertEqual(len(n["GND"]["vias"]), 1)
        g = p["grid"]
        cov = unrle(n["GND"]["cov"]["1"], g["nx"] * g["ny"])
        self.assertGreater(sum(1 for v in cov if v > 128), 0.3 * len(cov))           # 底层铺铜按 IPC 记录归到 GND


class Helpers(unittest.TestCase):
    def test_rle_roundtrip(self):
        import numpy as np
        a = np.array([0, 0, 0, 255, 255, 7] + [9] * 70000, dtype=np.uint8)
        self.assertEqual(unrle(X.rle(a), len(a)), a.tolist())

    def test_arc3(self):
        pts = X.arc3((1, 0), (0, 1), (-1, 0))
        self.assertTrue(all(abs((x * x + y * y) ** 0.5 - 1) < 1e-9 for x, y in pts))
        self.assertGreater(min(y for _, y in pts), -1e-9)                              # 经过 (0,1) 的上半圆

    def test_parallel(self):
        ov, gap = X.parallel([0, 0, 0, 10, 0, 0.2], [0, 2, 0.5, 8, 0.5, 0.2])
        self.assertAlmostEqual(ov, 6.0)
        self.assertAlmostEqual(gap, 0.3)


if __name__ == "__main__":
    unittest.main()
