import asyncio, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from vt import Rec, INIT, CURSOR, glide
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[2]
URL = (ROOT / 'assets' / 'layout-planner.html').as_uri()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        ctx = await b.new_context(viewport={'width': 1440, 'height': 810}, device_scale_factor=4 / 3)
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("try { localStorage.setItem('lp:intro-seen','1'); localStorage.setItem('lp:anim','1'); localStorage.setItem('lp:theme','dark'); } catch(e) {}")
        await pg.add_init_script(INIT); await pg.add_init_script(CURSOR)
        await pg.goto(URL)
        r = Rec(pg, 'planner-satellites-3d')
        await r.settle('window.__LP_READY === true')
        if await pg.evaluate("!!(document.getElementById('board-setup') && document.getElementById('board-setup').open)"):
            await pg.click('#board-setup-go')
        await pg.set_input_files('#file-input', str(ROOT / 'tests' / 'fixtures' / 'planner-good-layout.json')); await r.step(15)
        await pg.evaluate("LP.ui.openStep = null; LP.ui.renderSteps(); document.getElementById('toasts').innerHTML = ''")
        await pg.click('#v3d')
        await r.settle("LP.App.view === '3d'")
        await r.step(30)
        print('anim', await pg.evaluate('LP.App.animOn'))
        scr = lambda x, y, h=0: pg.evaluate(f'(() => {{ const s = LP.App.renderer.boardToScreen({x}, {y}, {h}); return [s.x, s.y]; }})()')
        u1 = await scr(23, 20, 1.2)
        sx, sy = 700, 760
        await pg.mouse.move(sx, sy); await r.sec(0.6)
        await glide(r, sx, sy, *u1, 22)
        await pg.mouse.down(); await pg.mouse.up(); await r.sec(1.6)          # 拾取：卫星升起、环绕
        await pg.keyboard.press('r'); await r.sec(0.7)                          # 拾取中旋转 90°
        tgt = await scr(18, 15.5)
        await glide(r, *u1, *tgt, 34, lift=40); await r.sec(0.6)
        await pg.mouse.down(); await pg.mouse.up(); await r.sec(2.0)          # 放下：卫星飞落贴放
        # 再拾取一次放回原处
        tgt_top = await scr(18, 15.5, 1.2)
        await glide(r, *tgt, *tgt_top, 10)
        await r.sec(0.2)
        await pg.mouse.down(); await pg.mouse.up(); await r.sec(0.9)
        await pg.keyboard.press('r'); await pg.keyboard.press('r'); await pg.keyboard.press('r'); await r.sec(0.5)
        u1b = await scr(23, 20)
        await glide(r, *tgt_top, *u1b, 30, lift=40); await r.sec(0.3)
        await pg.mouse.down(); await pg.mouse.up(); await r.sec(2.2)
        print(r.name, r.n, errs)
        await b.close()

asyncio.run(main())
