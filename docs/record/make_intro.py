"""把 README 演示片段剪成一条约 1 分钟的 16:9 介绍片（无声母版 + 外置字幕与口播稿）。

流程按 1minVideo（image-to-video skill）的做法：先写分镜表（起止秒、观众看见什么、素材与取段、一句口播），
画面母版不带声音、字幕不烧录；再单独做封面。素材是录好的 MP4，所以剪辑用 FFmpeg 直接处理视频片段。

用法：
    python docs/record/make_intro.py [输出目录]
素材默认取 /tmp/rec-out（3D 与原理图）和 /tmp/rec/out（2D），可用环境变量 CLIPS_3D、CLIPS_2D 指定。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FF = os.environ.get("FFMPEG", "ffmpeg")
W, H, FPS = 1920, 1080, 30
XF = 0.25                                   # 片段之间的交叉淡化（秒）
D3 = Path(os.environ.get("CLIPS_3D", "/tmp/rec-out"))
D2 = Path(os.environ.get("CLIPS_2D", "/tmp/rec/out"))
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/intro")
WORK = OUT / "work"
FONT_B = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
FONT_M = "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc"
REPO = "github.com/donghuixin/low-power-iot-hardware-design"
AMBER = (255, 196, 92)

# 验证器 3D 的板图区域、规划器 3D 的板图区域（1920×1080 源画面中的像素），裁成 16:9
CROP_V = (347, 150, 1133, 637)
CROP_P = (380, 170, 1100, 619)

# ---------------- 分镜表 ----------------
# 每段：(素材, 起点秒, 速度, 输出秒, 片头字幕 or None, 口播)
CH = {
    1: ("01", "原理图", "按十步流程画给人读：卫星器件贴着所服务的引脚"),
    2: ("02", "布局规划", "只摆主器件，去耦、晶体、匹配自动贴放 · 2D / 3D"),
    3: ("03", "电流与回流", "布线前就看清：供电从哪来，回流往哪去"),
    4: ("04", "电磁", "受扰地图 + 电源 / 地平面谐振"),
    5: ("05", "温度", "加散热片前后，结温一屏对比"),
    6: ("06", "布线后复核", "从 KiCad / 立创 EDA 提取铜皮，问题直接定位"),
}
SHOTS = [
    ("opening", None, 0, 1, 3.4, None, "开源了我十年的物联网电路设计经验：从原理图、布局，到电流、电磁和温度的验证。"),
    ("schematic-drawing", D3, 0.0, 1.8, 8.3, 1, "画原理图，按十步流程走：先框图，再把去耦、晶体和匹配贴到它们服务的引脚旁边。"),
    ("planner-satellites", D2, 0.6, 1.6, 4.2, 2, "摆布局时只拿主器件，它的卫星器件跟着环绕，放下就自动贴到最合适的位置。"),
    ("planner-satellites-3d", D3, 0.6, 1.6, 4.5, None, "3D 里也一样，摆到差的位置，右边马上告诉你线长和交叉变了多少。"),
    ("verifier-current", D2, 0.3, 1.5, 4.0, 3, "布线之前，先看每个负载的供电从哪来、回流往哪去。"),
    ("verifier3d-current", D3, 0.2, 1.5, 4.5, None, "切到 3D，板上的去程和地平面上的回流分层流动。"),
    ("verifier-emi", D2, 0.5, 1.5, 3.0, 4, "天线和开关节点向外扩散，敏感器件按受扰等级提示。"),
    ("verifier3d-emi", D3, 0.3, 1.5, 3.0, None, "受扰电平做成地形，天线处隆起成峰。"),
    ("verifier3d-modes", D3, 3.0, 1.3, 3.2, None, "电源和地平面的谐振，振型上下起伏，接近工作频率就标出来。"),
    ("verifier-thermal", D2, 1.6, 1.8, 4.2, 5, "给 0.9 瓦的主控逐级加散热片，结温从一百零六度降到四十度。"),
    ("verifier3d-thermal", D3, 1.5, 1.4, 4.8, None, "3D 里温度变成高度，散热片装上去，热区当场塌下来。"),
    ("verifier-routed", D2, 0.5, 1.25, 6.8, 6, "布完线，从 KiCad 或立创 EDA 导出铜皮，射频参考、并行耦合、地铜孤岛逐条定位。"),
    ("closing", None, 0, 1, 5.6, None, "全部开源，欢迎 Star 和 Fork。"),
]


def font(path, size):
    return ImageFont.truetype(path, size, index=2 if path.endswith(".ttc") else 0)   # .ttc 第 3 个是简体中文


def run(*args):
    subprocess.run([FF, "-v", "error", "-y", "-nostdin", *map(str, args)], check=True)


def rounded(draw, box, r, fill, outline=None, width=1):
    draw.rounded_rectangle(box, r, fill=fill, outline=outline, width=width)


def chip(draw, x, y, text, f, fg=(255, 236, 200), bg=(60, 44, 14, 230), bd=(255, 196, 92, 200)):
    tw = draw.textlength(text, font=f)
    rounded(draw, (x, y, x + tw + 44, y + f.size + 26), (f.size + 26) // 2, bg, bd, 2)
    draw.text((x + 22, y + 10), text, font=f, fill=fg)
    return x + tw + 44


def caption_png(num, title, sub, path):
    """片头字幕：半透明深色底纹，左侧琥珀色竖条，章节号 + 标题 + 一句说明。"""
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    ft, fs, fn = font(FONT_B, 64), font(FONT_M, 32), font(FONT_B, 40)
    tw = max(d.textlength(title, font=ft) + 120, d.textlength(sub, font=fs)) + 140
    x0, y0 = (W - tw) // 2, 770
    x1, y1 = x0 + tw, y0 + 186
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + 8, x1, y1 + 8), 26, fill=(0, 0, 0, 120))
    im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14)))
    d = ImageDraw.Draw(im)
    rounded(d, (x0, y0, x1, y1), 26, (12, 14, 22, 168), (255, 255, 255, 40), 2)
    d.rounded_rectangle((x0 + 28, y0 + 34, x0 + 36, y1 - 34), 4, fill=AMBER + (255,))
    d.text((x0 + 60, y0 + 24), num, font=fn, fill=AMBER + (255,))
    d.text((x0 + 60 + d.textlength(num, font=fn) + 22, y0 + 14), title, font=ft, fill=(255, 255, 255, 255))
    d.text((x0 + 62, y0 + 112), sub, font=fs, fill=(214, 220, 232, 255))
    im.save(path)


def clip(name, src_dir, start, speed, dur, ch, out):
    src = src_dir / f"{name}.mp4"
    flt = f"[0:v]setpts=(PTS-STARTPTS)/{speed},fps={FPS},scale={W}:{H}:flags=lanczos,format=yuv420p[v]"
    args = ["-ss", start, "-t", dur * speed + 0.2, "-i", src]
    if ch:
        cap = WORK / f"cap{ch}.png"
        caption_png(*CH[ch], cap)
        args += ["-loop", "1", "-t", dur, "-i", cap]
        flt += (";[1:v]format=rgba,fade=in:st=0.15:d=0.4:alpha=1,fade=out:st=2.35:d=0.45:alpha=1[c]"
                ";[v][c]overlay=x=0:y='18*max(0,1-(t-0.15)/0.4)':eval=frame,format=yuv420p[v]")
    run(*args, "-filter_complex", flt, "-map", "[v]", "-t", dur, "-an", "-r", FPS,
        "-c:v", "libx264", "-preset", "medium", "-crf", 16, out)


def opening(dur, out):
    """开场：五个 3D 动态画面（卫星贴放居中靠上），下方标题与支持的工具。"""
    bg = Image.new("RGB", (W, H), (9, 10, 15))
    d = ImageDraw.Draw(bg)
    for y in range(H):                                     # 底部微微发暖
        k = max(0, (y - 600) / 480)
        d.line([(0, y), (W, y)], fill=(int(9 + 22 * k), int(10 + 12 * k), int(15 + 2 * k)))
    bg.save(WORK / "open_bg.png")
    txt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(txt)
    ft, fc, fsm = font(FONT_B, 76), font(FONT_B, 30), font(FONT_M, 26)
    title = "开源了我十年的物联网电路设计经验"
    d.text(((W - d.textlength(title, font=ft)) / 2, 776), title, font=ft, fill=(255, 255, 255, 255))
    chips = ["支持 立创EDA", "支持 KiCad", "实际投板验证通过"]
    widths = [d.textlength(c, font=fc) + 44 for c in chips]
    x = (W - sum(widths) - 24 * (len(chips) - 1)) / 2
    for c, w in zip(chips, widths):
        chip(d, x, 900, c, fc)
        x += w + 24
    sub = "低功耗 IoT 硬件设计 Skill · Claude / Codex"
    d.text(((W - d.textlength(sub, font=fsm)) / 2, 990), sub, font=fsm, fill=(150, 160, 180, 255))
    txt.save(WORK / "open_txt.png")
    tw, th, g = 608, 342, 24
    tiles = [  # (素材, 起点, 裁区, 位置)
        ("verifier3d-current", 1.2, CROP_V, (g, g)),
        ("planner-satellites-3d", 1.4, CROP_P, (g * 2 + tw, g)),
        ("verifier3d-emi", 1.2, CROP_V, (g * 3 + tw * 2, g)),
        ("verifier3d-modes", 0.6, CROP_V, ((W - 2 * tw - g) // 2, g * 2 + th)),
        ("verifier3d-thermal", 6.0, CROP_V, ((W - 2 * tw - g) // 2 + tw + g, g * 2 + th)),
    ]
    args = ["-loop", "1", "-t", dur, "-i", WORK / "open_bg.png"]
    for n, st, *_ in tiles:
        args += ["-ss", st, "-t", dur + 0.2, "-i", D3 / f"{n}.mp4"]
    args += ["-loop", "1", "-t", dur, "-i", WORK / "open_txt.png"]
    flt, last = [], "0:v"
    for k, (n, st, cr, (x, y)) in enumerate(tiles):
        cx, cy, cw, chh = cr
        flt.append(f"[{k + 1}:v]setpts=PTS-STARTPTS,fps={FPS},crop={cw}:{chh}:{cx}:{cy},scale={tw}:{th}:flags=lanczos,"
                   f"format=rgba,fade=in:st={0.08 * k}:d=0.35:alpha=1[t{k}]")
        flt.append(f"[{last}][t{k}]overlay={x}:{y}:shortest=0[m{k}]")
        flt.append(f"[m{k}]drawbox=x={x}:y={y}:w={tw}:h={th}:color=white@0.10:t=2[b{k}]")
        last = f"b{k}"
    n = len(tiles) + 1
    flt.append(f"[{n}:v]format=rgba,fade=in:st=0.35:d=0.45:alpha=1[tx]")
    flt.append(f"[{last}][tx]overlay=0:'14*max(0,1-(t-0.35)/0.45)':eval=frame,format=yuv420p[v]")
    run(*args, "-filter_complex", ";".join(flt), "-map", "[v]", "-t", dur, "-an", "-r", FPS,
        "-c:v", "libx264", "-preset", "medium", "-crf", 16, out)


def closing(dur, out):
    """结尾：虚化的 3D 画面上写项目地址与支持的工具，缓慢推近。"""
    run("-ss", 2.0, "-i", D3 / "verifier3d-thermal.mp4", "-frames:v", 1, WORK / "close_src.png")
    base = Image.open(WORK / "close_src.png").convert("RGB")
    base = base.crop((347, 69, 347 + 1133, 69 + 637)).resize((W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(22))
    dark = Image.new("RGB", (W, H), (8, 9, 14))
    im = Image.blend(base, dark, 0.62).convert("RGBA")
    d = ImageDraw.Draw(im)
    fb, fm, fc, fu = font(FONT_B, 72), font(FONT_M, 34), font(FONT_B, 30), font(FONT_M, 30)
    lines = [("全部开源 · 欢迎 Star / Fork", fb, (255, 255, 255), 330), ("low-power-iot-hardware-design", fm, AMBER, 450)]
    for t, f, c, y in lines:
        d.text(((W - d.textlength(t, font=f)) / 2, y), t, font=f, fill=c)
    tw = d.textlength(REPO, font=fu) + 60
    x0 = (W - tw) / 2
    rounded(d, (x0, 540, x0 + tw, 610), 14, (16, 18, 26, 220), (255, 255, 255, 60), 2)
    d.text((x0 + 30, 553), REPO, font=fu, fill=(230, 236, 246))
    chips = ["支持 立创EDA", "支持 KiCad", "实际投板验证通过", "Claude / Codex"]
    widths = [d.textlength(c, font=fc) + 44 for c in chips]
    x = (W - sum(widths) - 22 * (len(chips) - 1)) / 2
    for c, w in zip(chips, widths):
        chip(d, x, 680, c, fc)
        x += w + 22
    im.convert("RGB").save(WORK / "close.png")
    n = int(dur * FPS)
    run("-loop", 1, "-i", WORK / "close.png", "-filter_complex",
        f"[0:v]scale=2304:1296,zoompan=z='1+0.04*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={n}:s={W}x{H}:fps={FPS},"
        f"fade=out:st={dur - 0.6}:d=0.6,format=yuv420p[v]", "-map", "[v]", "-frames:v", n, "-an",
        "-c:v", "libx264", "-preset", "medium", "-crf", 16, out)


def stamp(s):
    ms = round(s * 1000)
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    parts = []
    for k, (name, src, st, sp, dur, ch, _) in enumerate(SHOTS):
        out = WORK / f"s{k:02}.mp4"
        if name == "opening": opening(dur, out)
        elif name == "closing": closing(dur, out)
        else: clip(name, src, st, sp, dur, ch, out)
        parts.append((out, dur))
    # 交叉淡化拼接
    args, flt, last, t = [], [], "0:v", parts[0][1]
    for p, _ in parts: args += ["-i", p]
    starts = [0.0]
    for k in range(1, len(parts)):
        off = t - XF
        starts.append(off)
        flt.append(f"[{last}][{k}:v]xfade=transition=fade:duration={XF}:offset={off:.3f}[x{k}]")
        last = f"x{k}"; t = off + parts[k][1]
    final = OUT / "low-power-iot-intro.mp4"
    run(*args, "-filter_complex", ";".join(flt), "-map", f"[{last}]", "-an", "-r", FPS,
        "-c:v", "libx264", "-preset", "slow", "-crf", 20, "-pix_fmt", "yuv420p", "-movflags", "+faststart", final)
    # 外置字幕与口播稿（按镜头定时，不烧录）
    srt, plain, table = [], [], []
    for k, ((name, _, st, sp, dur, ch, voice), s0) in enumerate(zip(SHOTS, starts)):
        s1 = starts[k + 1] if k + 1 < len(starts) else t
        srt.append(f"{k + 1}\n{stamp(s0)} --> {stamp(s1)}\n{voice}\n")
        plain.append(voice)
        table.append({"start": round(s0, 2), "end": round(s1, 2), "source": name, "source_in": st, "speed": sp,
                      "chapter": CH[ch][1] if ch else None, "voice": voice})
    (OUT / "low-power-iot-intro.srt").write_text("\n".join(srt), encoding="utf-8")
    (OUT / "narration-clean.txt").write_text("\n\n".join(plain) + "\n", encoding="utf-8")
    (OUT / "storyboard.json").write_text(json.dumps({"size": [W, H], "fps": FPS, "duration": round(t, 2), "shots": table},
                                                    ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{final}  {t:.2f} s")


if __name__ == "__main__":
    main()
