#!/usr/bin/env python3
"""验证器页面的浏览器冒烟测试（可选，需要 Playwright 与 Chromium）。

依次打开：内置示例（阶段 P）、好板与坏板的布线后页面（阶段 R），切换三个标签页，
检查计算跑在 Worker 里、没有脚本错误、动画帧耗时在预算内，并把截图存到输出目录。

用法：python tests/browser_verifier_smoke.py [输出目录]   （先运行 scripts/build_layout_verifier.py）
"""
import asyncio
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


async def check(pw, html, tag, out):
    b = await pw.chromium.launch()
    pg = await (await b.new_context(viewport={"width": 1440, "height": 860})).new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    await pg.goto(html.as_uri())
    await pg.wait_for_function("window.__LV_READY", timeout=30000)
    await pg.wait_for_timeout(1500)
    mode = await pg.evaluate("LP.App.client.mode")
    avg = await pg.evaluate("LP.App.parts.lastAvg || 0")
    await pg.screenshot(path=str(out / f"{tag}-current.png"))
    await pg.click("#tabs button[data-tab=emi]"); await pg.wait_for_timeout(1200)
    await pg.screenshot(path=str(out / f"{tag}-emi.png"))
    await pg.click(".seg button:nth-child(2)"); await pg.wait_for_timeout(2000)
    await pg.screenshot(path=str(out / f"{tag}-modes.png"))
    await pg.click("#tabs button[data-tab=thermal]"); await pg.wait_for_timeout(1500)
    await pg.screenshot(path=str(out / f"{tag}-thermal.png"))
    await b.close()
    ok = mode == "worker" and not errs and avg < 16
    print(f"{'通过' if ok else '失败'} {tag}: mode={mode} 帧耗时={avg:.1f} ms 错误={errs}")
    return ok


async def main():
    from playwright.async_api import async_playwright
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp())
    out.mkdir(parents=True, exist_ok=True)
    pages = [(ROOT / "assets" / "layout-verifier.html", "p")]
    for v in ("plane", "trace"):
        html = out / f"verify-{v}.html"
        subprocess.run([sys.executable, str(ROOT / "scripts" / "make_layout_project.py"), str(ROOT / "assets" / "layout-verify-example.json"),
                        "--verifier", "--copper", str(ROOT / "tests" / "fixtures" / f"copper-demo-{v}.json"), "-o", str(html)], check=True, capture_output=True)
        pages.append((html, "r-" + v))
    async with async_playwright() as pw:
        res = [await check(pw, h, t, out) for h, t in pages]
    print(f"截图在 {out}")
    return 0 if all(res) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
