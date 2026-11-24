import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from vt import Rec, INIT, CURSOR, glide
from playwright.async_api import async_playwright
ROOT = str(Path(__file__).resolve().parents[2])
EX = json.load(open(f'{ROOT}/assets/layout-verify-example.json'))
HOT = json.loads(json.dumps(EX)); HOT['verify']['thermal'] = [{'part': 'U1', 'p_w': 0.9}, {'part': 'U4', 'p_w': 0.12}]
BAD = json.load(open(f'{ROOT}/tests/fixtures/copper-demo-trace.json'))
IDLE = 'LP.App && LP.App.busy === 0'
ONLY = sys.argv[1:] or None


async def page(b):
    ctx = await b.new_context(viewport={'width': 1440, 'height': 810}, device_scale_factor=4 / 3)
    pg = await ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script(INIT); await pg.add_init_script(CURSOR)
    await pg.goto(Path(ROOT, 'assets', 'layout-verifier.html').as_uri())
    for _ in range(200):
        if await pg.evaluate('!!window.__LV_READY'): break
        await pg.evaluate('window.__vt(33)'); await asyncio.sleep(0.05)
    pg._errs = errs
    return pg


async def center(pg, loc):
    bb = await loc.bounding_box()
    return bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2


class Cur:
    x, y = 720, 760


async def click(r, loc, frames=14, settle=True):
    x, y = await center(r.pg, loc)
    await glide(r, Cur.x, Cur.y, x, y, frames)
    Cur.x, Cur.y = x, y
    await loc.click()
    await r.frames(3)
    if settle: await r.settle(IDLE, record=True)


async def load(r, proj, copper=None, tab=None):
    await r.pg.evaluate('([p, c]) => { LP.App.load(p, c); }', [proj, copper])
    await r.settle(IDLE)
    if tab:
        await r.pg.click(f'#tabs button[data-tab={tab}]'); await r.settle(IDLE)
    await r.step(20)


async def clip_current(b):
    pg = await page(b); r = Rec(pg, 'verifier-current')
    await load(r, EX)
    await pg.mouse.move(Cur.x, Cur.y)
    await r.sec(2.2)
    await click(r, pg.locator('#left .item', has_text='U4'))
    await r.sec(2.0)
    await click(r, pg.locator('#left .item', has_text='U1'))
    await r.sec(1.0)
    sel = pg.locator('#left select')
    x, y = await center(pg, sel); await glide(r, Cur.x, Cur.y, x, y, 14); Cur.x, Cur.y = x, y
    await sel.select_option('2l'); await r.frames(3); await r.settle(IDLE, record=True)
    await r.sec(2.4)
    await sel.select_option('project'); await r.frames(2); await r.settle(IDLE, record=True)
    await r.sec(1.0)
    print(r.name, r.n, pg._errs)


async def clip_emi(b):
    pg = await page(b); r = Rec(pg, 'verifier-emi')
    await load(r, EX, tab='emi')
    await pg.mouse.move(Cur.x, Cur.y)
    await r.sec(2.0)
    await click(r, pg.locator('#left .item', has_text='ANT1'))
    await r.sec(2.0)
    await click(r, pg.locator('#left .item', has_text='RF_FEED'))
    await r.sec(1.6)
    await click(r, pg.locator('#left .item', has_text='全部'))
    await r.sec(1.0)
    print(r.name, r.n, pg._errs)


async def clip_modes(b):
    pg = await page(b); r = Rec(pg, 'verifier-plane-modes')
    await load(r, EX, tab='emi')
    await pg.click('.seg button:nth-child(2)'); await r.settle(IDLE); await r.step(10)
    Cur.x, Cur.y = 130, 300; await pg.mouse.move(Cur.x, Cur.y)
    await r.sec(2.2)
    for k in (2, 3, 4):
        await click(r, pg.locator('#left .item', has_text=f'第 {k} 模'))
        await r.sec(1.8)
    print(r.name, r.n, pg._errs)


async def clip_thermal(b):
    pg = await page(b); r = Rec(pg, 'verifier-thermal')
    await pg.evaluate('LP.App.opt.compare = true; LP.App.opt.split = 0.5')
    await load(r, HOT, tab='thermal')
    Cur.x, Cur.y = 400, 600; await pg.mouse.move(Cur.x, Cur.y)
    await r.sec(1.5)
    sel = pg.locator('#left .item', has_text='U1').locator('select')
    x, y = await center(pg, sel); await glide(r, Cur.x, Cur.y, x, y, 14); Cur.x, Cur.y = x, y
    for v in ('0.05', '0.1', '0.25'):
        await sel.select_option(v); await r.frames(2); await r.settle(IDLE, record=True); await r.sec(1.0)
    # 拖动分割线
    vb = await pg.locator('#stage-canvas').bounding_box()
    split = await pg.evaluate('LP.App.opt.split')
    sx, sy = vb['x'] + split * vb['width'], vb['y'] + vb['height'] * 0.55
    await glide(r, Cur.x, Cur.y, sx, sy, 16); Cur.x, Cur.y = sx, sy
    await pg.mouse.down(); await r.frames(2)
    await glide(r, sx, sy, vb['x'] + vb['width'] * 0.78, sy, 22)
    await glide(r, vb['x'] + vb['width'] * 0.78, sy, vb['x'] + vb['width'] * 0.3, sy, 30)
    await glide(r, vb['x'] + vb['width'] * 0.3, sy, sx, sy, 18)
    await pg.mouse.up(); await r.sec(1.0)
    print(r.name, r.n, pg._errs)


async def clip_routed(b):
    pg = await page(b); r = Rec(pg, 'verifier-routed')
    await load(r, EX, BAD)
    Cur.x, Cur.y = 720, 760; await pg.mouse.move(Cur.x, Cur.y)
    await r.sec(2.0)
    await click(r, pg.locator('#tabs button[data-tab=emi]'))
    await r.sec(0.8)
    cards = pg.locator('#right .findings .card')
    n = await cards.count()
    for i in range(n):
        await click(r, cards.nth(i), frames=12, settle=False)
        await r.sec(1.1)
    print(r.name, r.n, pg._errs)


CLIPS = {'current': clip_current, 'emi': clip_emi, 'modes': clip_modes, 'thermal': clip_thermal, 'routed': clip_routed}


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for k, fn in CLIPS.items():
            if ONLY and k not in ONLY: continue
            await fn(b)
        await b.close()

asyncio.run(main())
