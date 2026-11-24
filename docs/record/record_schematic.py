"""录制原理图绘制流程的演示动画（docs/record/schematic-demo.html）。用法：python docs/record/record_schematic.py"""
import asyncio, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from vt import Rec, INIT
from playwright.async_api import async_playwright

HTML = Path(__file__).resolve().parent / 'schematic-demo.html'


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await (await b.new_context(viewport={'width': 1440, 'height': 810}, device_scale_factor=4 / 3)).new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(INIT)
        await pg.goto(HTML.as_uri())
        r = Rec(pg, 'schematic-drawing')
        await r.step(1)
        while await pg.evaluate('(window.__t || 0) < 15'):
            await r.frames(1)
        print(r.name, r.n, errs)
        await b.close()

asyncio.run(main())
