"""eda_bridge.py（本机脚本 ⇄ 本地桥 ⇄ 扩展）的测试：扩展导出的数据包能被 route_lint / layout_lint 直接读；令牌；交叉核对。

运行：python -m unittest tests/test_eda_bridge.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import eda_bridge as EB  # noqa: E402
import layout_lint as LL  # noqa: E402
import route_lint as R  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
EXT_FIX = ROOT / "eext" / "lpiot-layout-routing-check" / "test" / "fixtures"


def extension_pack():
    """模拟扩展 export 命令的输出：板子来自扩展的对齐测试数据，器件包络按扩展的 partsOf 规则（与 Python 一致）。"""
    board = json.loads((EXT_FIX / "demo-node.json").read_text(encoding="utf-8"))["board"]
    py, _ = R.load_any(FIX / "demo-node.kicad_pcb")
    return {"kind": "copper-pack", "version": 1, "source": "test", "units": "mm", "frame": None, "layers": board["layers"],
            "nets": board["nets"], "parts": [{"ref": p["ref"], "value": p.get("value"), "rect": p["rect"], "side": p["side"]} for p in py["parts"]],
            "board": {"outline": py["board"]["outline"]}, "checks": {"planes": board["planes"]}}


class Hub(BaseHTTPRequestHandler):
    token = "t" * 48
    pack = None
    brief = None

    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)

    def authed(self):
        if self.headers.get("X-LPIOT-Token") != self.token:
            self.reply(401, {"error": "缺少或错误的令牌"})
            return False
        return True

    def do_GET(self):
        if self.authed():
            self.reply(200, {"bridge": "0.3.0", "role": "hub", "extension": {"name": "lpiot-layout-routing-check", "protocol": 1}})

    def do_POST(self):
        if not self.authed():
            return
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        name = body.get("tool") or body.get("method")
        p = body.get("params") or {}
        if name == "board_export":
            Path(p["path"]).write_text(json.dumps(self.pack))
            return self.reply(200, {"result": {"path": p["path"], "layers": self.pack["layers"], "nets": len(self.pack["nets"]), "parts": len(self.pack["parts"])}})
        if name == "routing_check":
            rep = R.analyze(self.pack)
            return self.reply(200, {"result": {"score": rep["score"], "violations": rep["violations"]}})
        if name == "layout_check":
            lay = LL.run(self.pack, self.brief)
            return self.reply(200, {"result": lay})
        if name == "briefGet":
            return self.reply(200, {"result": {"brief": self.brief}})
        self.reply(500, {"error": f"未知 {name}"})


class BridgeClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Hub.pack = extension_pack()
        Hub.brief = json.loads((FIX / "demo-node-brief.json").read_text(encoding="utf-8"))
        cls.srv = HTTPServer(("127.0.0.1", 0), Hub)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.home = tempfile.mkdtemp()
        (Path(cls.home) / "bridge.json").write_text(json.dumps({"http_port": cls.srv.server_port, "token": Hub.token}))
        os.environ["LPIOT_HOME"] = cls.home

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        os.environ.pop("LPIOT_HOME", None)

    def test_extension_pack_is_readable_by_python_rules(self):
        py, _ = R.load_any(FIX / "demo-node.kicad_pcb")
        self.assertEqual(R.analyze(extension_pack())["score"], R.analyze(py)["score"])
        brief = Hub.brief
        a = sorted((v["rule"], tuple(v["refs"])) for v in LL.run(extension_pack(), brief)["issues"])
        b = sorted((v["rule"], tuple(v["refs"])) for v in LL.run(py, brief)["issues"])
        self.assertEqual(a, b)

    def test_export_and_crosscheck(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "pack.json"
            with contextlib.redirect_stdout(io.StringIO()):
                EB.main(["export", "-o", str(out)])
            self.assertEqual(json.loads(out.read_text())["kind"], "copper-pack")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(EB.main(["crosscheck"]), 0)
        self.assertIn("一致", buf.getvalue())

    def test_wrong_token_is_rejected(self):
        p = Path(self.home) / "bridge.json"
        good = p.read_text()
        p.write_text(json.dumps({"http_port": self.srv.server_port, "token": "x" * 48}))
        try:
            with self.assertRaises(SystemExit) as cm:
                EB.main(["status"])
            self.assertIn("令牌", str(cm.exception))
        finally:
            p.write_text(good)


if __name__ == "__main__":
    unittest.main()
