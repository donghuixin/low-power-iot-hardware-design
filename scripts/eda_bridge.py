#!/usr/bin/env python3
"""本机脚本 ⇄ 嘉立创 EDA 扩展“布局布线检查助手”的接口（经本地桥 eext/lpiot-layout-routing-check/bridge/bridge.mjs）。

    python eda_bridge.py status                         # 本地桥、扩展是否连上，扩展版本
    python eda_bridge.py check [--limit 30]             # 让扩展检查当前 PCB 的布线，只取结论
    python eda_bridge.py layout                         # 让扩展做布局检查
    python eda_bridge.py export -o board-pack.json      # 把编辑器里的板子导出成铜皮数据包（route_lint / layout_lint 通用）
    python eda_bridge.py brief-pull -o design-brief.json  # 取回扩展里保存的设计确认（含面板里的确认记录）
    python eda_bridge.py brief-push design-brief.json   # 把本地填写的内容送进扩展（确认记录以扩展为准，不会被覆盖）
    python eda_bridge.py priorities [--write] [--ai]    # 让扩展按板子功能梳理布线优先级
    python eda_bridge.py crosscheck                     # 导出板子，本地用 Python 规则再算一遍，和扩展的结果对照

本地桥启动时把端口和令牌写进 ~/.lpiot/bridge.json（可用环境变量 LPIOT_HOME 改目录）。这里读它，请求带 X-LPIOT-Token。
确认（各级确认码、布线优先级逐档确认）只能在扩展面板里由人完成，这个接口没有确认功能。只用 Python 标准库。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


def info_path():
    return Path(os.environ.get("LPIOT_HOME") or Path.home() / ".lpiot") / "bridge.json"


def load_info():
    p = info_path()
    if not p.exists():
        raise SystemExit(f"找不到 {p}：先启动本地桥（node eext/lpiot-layout-routing-check/bridge/bridge.mjs，或让 AI 客户端以 MCP 方式启动它），"
                         "再在嘉立创 EDA 里点“布局布线检查 → 连接本地 AI 助手…”")
    return json.loads(p.read_text(encoding="utf-8"))


def request(path, body=None, timeout=180):
    info = load_info()
    url = f"http://127.0.0.1:{info['http_port']}{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="GET" if body is None else "POST",
                                 headers={"X-LPIOT-Token": info["token"], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8")).get("error")
        except Exception:
            msg = str(e)
        raise SystemExit(f"本地桥返回错误：{msg}")
    except urllib.error.URLError as e:
        raise SystemExit(f"连不上本地桥（{e.reason}）：它可能已经退出，重新启动后再试")
    if "error" in out:
        raise SystemExit(out["error"])
    return out.get("result", out)


def rpc(method, params=None, tool=False, timeout=180):
    key = "tool" if tool else "method"
    return request("/rpc", {key: method, "params": params or {}}, timeout)


def print_json(x):
    print(json.dumps(x, ensure_ascii=False, indent=1))


def crosscheck():
    """扩展（TypeScript）和本地（Python）是同一套规则：导出板子后本地重算，两边分数和违规应当一致。"""
    sys.path.insert(0, str(HERE))
    import layout_lint as LL
    import route_lint as RL
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "board-pack.json"
        rpc("board_export", {"path": str(p)}, tool=True)
        pack = json.loads(p.read_text(encoding="utf-8"))
    ext = rpc("routing_check", {"limit": 500}, tool=True)
    local = RL.analyze(pack)
    brief = rpc("briefGet").get("brief")
    lay = LL.run(pack, brief)
    ext_lay = rpc("layout_check", {"limit": 500}, tool=True)
    key = lambda v: (v["rule"], v["sev"], v.get("net"))   # noqa: E731
    a = sorted(key(v) for v in ext["violations"])
    b = sorted(key(v) for v in local["violations"])
    print(f"布线：扩展 {ext['score']} 分 / 本地 {local['score']} 分；违规 {len(a)} / {len(b)} 条，{'一致' if a == b and ext['score'] == local['score'] else '不一致'}")
    print(f"布局：扩展 P0 {ext_lay['p0']} P1 {ext_lay['p1']} / 本地 P0 {lay['p0']} P1 {lay['p1']}")
    if a != b:
        only_e = [x for x in a if x not in b][:10]
        only_l = [x for x in b if x not in a][:10]
        print("只在扩展里：", only_e)
        print("只在本地：", only_l)
        print("不一致通常是扩展和本仓库的版本不同，或板框、铺铜读法有差异；以版本较新的一边为准，并更新另一边。")
        return 1
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="本机脚本与嘉立创 EDA 扩展的接口（经本地桥）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    p = sub.add_parser("check"); p.add_argument("--limit", type=int, default=30)
    p = sub.add_parser("layout"); p.add_argument("--limit", type=int, default=50)
    p = sub.add_parser("export"); p.add_argument("-o", "--output", default="board-pack.json")
    p = sub.add_parser("brief-pull"); p.add_argument("-o", "--output", default="design-brief.json")
    p = sub.add_parser("brief-push"); p.add_argument("brief")
    p = sub.add_parser("priorities"); p.add_argument("--write", action="store_true"); p.add_argument("--ai", action="store_true")
    sub.add_parser("crosscheck")
    a = ap.parse_args(argv)
    if a.cmd == "status":
        print_json(request("/status"))
    elif a.cmd == "check":
        print_json(rpc("routing_check", {"limit": a.limit}, tool=True))
    elif a.cmd == "layout":
        print_json(rpc("layout_check", {"limit": a.limit}, tool=True))
    elif a.cmd == "export":
        out = Path(a.output).resolve()
        r = rpc("board_export", {"path": str(out)}, tool=True)
        print(f"已导出 {out}：{len(r['layers'])} 层、{r['nets']} 个网络、{r['parts']} 个器件。可以直接用 route_lint.py lint / layout_lint.py 检查。")
    elif a.cmd == "brief-pull":
        b = rpc("briefGet").get("brief")
        Path(a.output).write_text(json.dumps(b, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"已写入 {a.output}")
    elif a.cmd == "brief-push":
        b = json.loads(Path(a.brief).read_text(encoding="utf-8"))
        b.pop("confirmations", None)
        sets = {k: v for k, v in b.items() if k not in ("kind", "version")}
        print_json(rpc("design_brief_update", {"set": sets}, tool=True))
    elif a.cmd == "priorities":
        r = rpc("priority_draft", {"write": a.write, "ai": a.ai}, tool=True)
        print(r["note"])
        for t in r["tiers"]:
            print(f"第 {t['tier']} 档 {t['name']}（{t['method']}）：{'、'.join(t['nets'])}")
        if a.write:
            print("已写进扩展的 G4；请用户在面板“确认”页逐档核对并确认。")
    elif a.cmd == "crosscheck":
        return crosscheck()
    return 0


if __name__ == "__main__":
    sys.exit(main())
