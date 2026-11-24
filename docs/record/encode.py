"""把录好的帧编码成 MP4（1080p，发给用户）和 README 用的 GIF。

用法：python docs/record/encode.py [名称 ...]   （默认全部；输出到 docs/images/ 的 GIF 和 /tmp/rec-out/ 的 MP4）
"""
import os, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from vt import FRAMES, FPS, encode  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
NAMES = sys.argv[1:] or sorted(os.listdir(FRAMES))
HEAVY = {"verifier-current", "verifier-thermal", "verifier-plane-modes", "verifier-routed", "verifier3d-current", "verifier3d-emi", "verifier3d-modes", "verifier3d-thermal"}   # 粒子多，GIF 用更小的尺寸和调色板
for n in NAMES:
    mp4, gif = encode(n, "/tmp/rec-out")
    if n in HEAVY:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", f"{FRAMES}/{n}/%05d.png", "-filter_complex",
                        "[0:v]fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];"
                        "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", str(gif)], check=True)
    (ROOT / "docs" / "images" / gif.name).write_bytes(gif.read_bytes())
    print(n, mp4, f"{gif.stat().st_size / 1e6:.1f} MB")
