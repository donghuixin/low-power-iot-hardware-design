import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from vt import Rec, INIT, CURSOR, glide
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[2]
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
EX = json.loads((ROOT / 'assets' / 'layout-verify-example.json').read_text(encoding='utf-8'))
HOT = json.loads(json.dumps(EX)); HOT['verify']['thermal'] = [{'part': 'U1', 'p_w': 0.9}, {'part': 'U4', 'p_w': 0.12}]
IDLE = 'LP.App && LP.App.busy === 0'
ONLY = sys.argv[1:] or None


class Cur:
    x, y = 720, 700


async def page(b, proj, tab=None):
    ctx = await b.new_context(viewport={'width': 1440, 'height': 810}, device_scale_factor=4 / 3)
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script(INIT); await pg.add_init_script(CURSOR)
    await pg.goto((ROOT / 'assets' / 'layout-verifier.html').as_uri())
    for _ in range(300):
        if await pg.evaluate('!!window.__LV_READY'): break
        await pg.evaluate('window.__vt(33)'); await asyncio.sleep(0.05)
    pg._errs = errs
    return pg


async def settle(r, cond=IDLE, record=False):
    await r.settle(cond, record=record)


async def prep(r, proj, tab=None, sub=None):
    pg = r.pg
    await pg.evaluate('(p) => { LP.App.load(p, null); }', proj); await settle(r)
    if tab: await pg.click(f'#tabs button[data-tab={tab}]'); await settle(r)
    if sub: await pg.click(f'.seg[role=tablist] >> text={sub}'); await settle(r)
    await pg.click('#view-seg button[data-view="3d"]')
    await settle(r, 'LP.App.view === "3d" && LP.App.busy === 0')
    await r.step(10)
    await pg.mouse.move(Cur.x, Cur.y)


async def orbit(r, az0, az1, el0, el1, sec, dist=None):
    n = int(sec * 30)
    for i in range(n):
        t = (i + 1) / n; e = t * t * (3 - 2 * t)
        o = {'az': az0 + (az1 - az0) * e, 'el': el0 + (el1 - el0) * e}
        if dist: o['dist'] = dist[0] + (dist[1] - dist[0]) * e
        await r.pg.evaluate('(o) => LP.App.v3.setCamera(o)', o)
        await r.frames(1)


async def click(r, loc, frames=12):
    bb = await loc.bounding_box(); x, y = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2
    await glide(r, Cur.x, Cur.y, x, y, frames); Cur.x, Cur.y = x, y
    await loc.click(); await r.frames(2); await r.settle(IDLE, record=True)


async def clip_current(b):
    pg = await page(b, EX); r = Rec(pg, 'verifier3d-current')
    await prep(r, EX)
    await pg.evaluate('LP.App.v3.setCamera({az: -55, el: 26})')
    await orbit(r, -55, -20, 26, 32, 3.2)
    await click(r, pg.locator('#left .item', has_text='U4'))
    await orbit(r, -20, 15, 32, 40, 3.0)
    await click(r, pg.locator('#left .item', has_text='U1'))
    await orbit(r, 15, 35, 40, 30, 2.0)
    print(r.name, r.n, pg._errs)


async def clip_emi(b):
    pg = await page(b, EX); r = Rec(pg, 'verifier3d-emi')
    await prep(r, EX, 'emi')
    await orbit(r, -60, -15, 22, 34, 3.5)
    await click(r, pg.locator('#left .item', has_text='ANT1'))
    await orbit(r, -15, 20, 34, 30, 2.5)
    await click(r, pg.locator('#left .item', has_text='全部'))
    await orbit(r, 20, 30, 30, 28, 1.2)
    print(r.name, r.n, pg._errs)


async def clip_modes(b):
    pg = await page(b, EX); r = Rec(pg, 'verifier3d-modes')
    await prep(r, EX, 'emi', '平面谐振')
    await orbit(r, -50, -10, 20, 26, 3.2)
    await click(r, pg.locator('#left .item', has_text='第 2 模'))
    await orbit(r, -10, 25, 26, 30, 3.0)
    await click(r, pg.locator('#left .item', has_text='第 3 模'))
    await orbit(r, 25, 40, 30, 24, 2.2)
    print(r.name, r.n, pg._errs)


async def clip_thermal(b):
    pg = await page(b, HOT); r = Rec(pg, 'verifier3d-thermal')
    await prep(r, HOT, 'thermal')
    await orbit(r, -45, -30, 24, 28, 1.8)
    sel = pg.locator('#left .item', has_text='U1').locator('select')
    bb = await sel.bounding_box(); x, y = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2
    await glide(r, Cur.x, Cur.y, x, y, 12); Cur.x, Cur.y = x, y
    for v in ('0.05', '0.1', '0.25'):
        await sel.select_option(v); await r.frames(2); await r.settle(IDLE, record=True)
        await orbit(r, *(await pg.evaluate('[LP.App.v3.az, LP.App.v3.az + 10, LP.App.v3.el, LP.App.v3.el + 2]')), 1.2)
    await orbit(r, *(await pg.evaluate('[LP.App.v3.az, LP.App.v3.az + 40, LP.App.v3.el, 34]')), 2.6)
    print(r.name, r.n, pg._errs)


CLIPS = {'current': clip_current, 'emi': clip_emi, 'modes': clip_modes, 'thermal': clip_thermal}


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)
        for k, fn in CLIPS.items():
            if ONLY and k not in ONLY: continue
            await fn(b)
        await b.close()

asyncio.run(main())
