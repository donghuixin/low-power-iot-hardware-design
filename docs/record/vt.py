"""虚拟时钟录屏：接管 requestAnimationFrame / performance.now，逐帧推进并截图，帧率稳定、不受截图耗时影响。"""
import asyncio, os, shutil, subprocess
from pathlib import Path

INIT = r"""
(() => {
  let now = 0, id = 0, q = [];
  const d0 = Date.now();
  performance.now = () => now;
  Date.now = () => d0 + now;
  window.requestAnimationFrame = (cb) => { q.push([++id, cb]); return id; };
  window.cancelAnimationFrame = (i) => { q = q.filter((x) => x[0] !== i); };
  window.__vt = (ms) => { now += ms; const cbs = q; q = []; for (const [, cb] of cbs) { try { cb(now); } catch (e) { console.error(e); } } return cbs.length; };
})();
"""
FPS = 30
FRAMES = os.environ.get('REC_FRAMES', '/tmp/rec-frames')
DT = 1000 / FPS


class Rec:
    def __init__(self, page, name, out_root=FRAMES, clip=None):
        self.pg, self.name, self.clip = page, name, clip
        self.dir = Path(out_root) / name
        shutil.rmtree(self.dir, ignore_errors=True); self.dir.mkdir(parents=True)
        self.n = 0

    async def step(self, k=1):
        for _ in range(k):
            await self.pg.evaluate(f'window.__vt({DT})')

    async def frames(self, k):
        for _ in range(k):
            await self.pg.evaluate(f'window.__vt({DT})')
            await self.pg.screenshot(path=str(self.dir / f'{self.n:05d}.png'), clip=self.clip)
            self.n += 1

    async def sec(self, s):
        await self.frames(int(round(s * FPS)))

    async def settle(self, cond='true', tries=400, record=False):
        """推进虚拟时间直到条件成立（等 Worker 算完）；record 时把等待过程也录下来。"""
        for _ in range(tries):
            if await self.pg.evaluate(cond):
                return True
            if record:
                await self.frames(1)
            else:
                await self.step(1)
            await asyncio.sleep(0.03)
        return False


def encode(name, out_dir, gif_width=960, gif_fps=15, frames_root=FRAMES, crop_gif=None):
    src = f'{frames_root}/{name}/%05d.png'
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    mp4 = out / f'{name}.mp4'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', src,
                    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16',
                    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(mp4)], check=True)
    vf = f'fps={gif_fps},' + (f'crop={crop_gif},' if crop_gif else '') + f'scale={gif_width}:-1:flags=lanczos'
    gif = out / f'{name}.gif'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', src, '-filter_complex',
                    f'[0:v]{vf},split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
                    str(gif)], check=True)
    return mp4, gif

CURSOR = r"""
window.addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.id = '__cursor';
  c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px);';
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 1 L2 17 L6.5 13 L9.5 20 L12.5 18.7 L9.5 12 L15.5 12 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const ring = document.createElement('div');
  ring.style.cssText = 'position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border:2.5px solid rgba(255,200,90,.95);border-radius:50%;pointer-events:none;z-index:2147483646;opacity:0;';
  document.body.append(ring, c);
  let ringT = -1;
  addEventListener('pointermove', (e) => { c.style.transform = `translate(${e.clientX - 2}px,${e.clientY - 1}px)`; }, true);
  addEventListener('pointerdown', (e) => { ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px'; ringT = performance.now(); }, true);
  const tick = () => { if (ringT >= 0) { const k = (performance.now() - ringT) / 400; if (k >= 1) { ring.style.opacity = 0; ringT = -1; } else { ring.style.opacity = 1 - k; ring.style.transform = `scale(${0.5 + k})`; } } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
"""


async def glide(rec, x0, y0, x1, y1, frames, record=True, lift=0):
    import math
    for i in range(1, frames + 1):
        t = i / frames
        e = t * t * (3 - 2 * t)
        await rec.pg.mouse.move(x0 + (x1 - x0) * e, y0 + (y1 - y0) * e - lift * math.sin(math.pi * t))
        if record:
            await rec.frames(1)
        else:
            await rec.step(1)
