"""介绍片的竖屏封面（1080×1920）。

封面简报（按 1minVideo 的四行简报）：
  观众学到什么：开源了我十年的物联网电路设计经验 / 1分钟学会如何设计低功耗物联网电路
  演示用什么例子：规划器与验证器的 3D 画面（卫星贴放、电流回流、受扰地形、平面谐振、散热对比）
  视觉方向：竖屏，深色底，琥珀色点题；标题最大，3D 画面居中，看板娘在右下角与画面重叠
  不得暗示什么：不写未演示的能力；"实际投板验证通过"按作者提供的说法原样标注

用法：python docs/record/make_cover.py 看板娘.png 输出.png
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920
D3 = Path("/tmp/rec-out")
FONT_B = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
FONT_K = "/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc"
FONT_M = "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc"
AMBER = (255, 190, 80)
CROP_V = (347, 150, 1133, 637)
CROP_P = (380, 170, 1100, 619)


def font(p, s):
    return ImageFont.truetype(p, s, index=2)


def grab(name, t, crop):
    out = Path(f"/tmp/cover_{name}_{t}.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", str(D3 / f"{name}.mp4"), "-frames:v", "1", str(out)], check=True)
    x, y, w, h = crop
    return Image.open(out).convert("RGB").crop((x, y, x + w, y + h))


def card(im, w, r=26):
    h = round(im.height * w / im.width)
    im = im.resize((w, h), Image.LANCZOS).convert("RGBA")
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), r, fill=255)
    im.putalpha(m)
    ImageDraw.Draw(im).rounded_rectangle((1, 1, w - 2, h - 2), r, outline=(255, 255, 255, 50), width=3)
    return im


def paste_shadow(base, im, xy, blur=24, off=14, alpha=150):
    sh = Image.new("RGBA", base.size, (0, 0, 0, 0))
    a = im.getchannel("A").point(lambda v: v * alpha // 255)
    blk = Image.new("RGBA", im.size, (0, 0, 0, 255)); blk.putalpha(a)
    sh.paste(blk, (xy[0], xy[1] + off), blk)
    base.alpha_composite(sh.filter(ImageFilter.GaussianBlur(blur)))
    base.alpha_composite(im, xy)


def chip(d, x, y, text, f, fg=(255, 236, 200), bg=(58, 42, 14, 235), bd=AMBER + (220,)):
    tw = d.textlength(text, font=f)
    hgt = f.size + 30
    d.rounded_rectangle((x, y, x + tw + 52, y + hgt), hgt // 2, fill=bg, outline=bd, width=3)
    d.text((x + 26, y + 11), text, font=f, fill=fg)
    return hgt


def main(mascot_path, out_path):
    im = Image.new("RGBA", (W, H), (9, 11, 18, 255))
    d = ImageDraw.Draw(im)
    for y in range(H):                                       # 上冷下暖的底色
        k = y / H
        d.line([(0, y), (W, y)], fill=(int(9 + 26 * k ** 2), int(11 + 10 * k ** 2), int(18 - 6 * k), 255))
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = ImageDraw.Draw(grid)
    for x in range(0, W, 54): g.line([(x, 0), (x, H)], fill=(255, 255, 255, 10))
    for y in range(0, H, 54): g.line([(0, y), (W, y)], fill=(255, 255, 255, 10))
    im.alpha_composite(grid)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((420, 1080, 1260, 1960), fill=(255, 140, 40, 70))
    im.alpha_composite(glow.filter(ImageFilter.GaussianBlur(120)))

    d = ImageDraw.Draw(im)
    tag = "开源 · 低功耗 IoT 硬件设计 Skill"
    ft = font(FONT_M, 34)
    tw = d.textlength(tag, font=ft)
    pill = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(pill).rounded_rectangle(((W - tw) / 2 - 30, 120, (W + tw) / 2 + 30, 184), 32, fill=(255, 255, 255, 22), outline=(255, 255, 255, 80), width=2)
    im.alpha_composite(pill)
    d = ImageDraw.Draw(im)
    d.text(((W - tw) / 2, 130), tag, font=ft, fill=(220, 226, 238))
    # 标题：两行，"十年"点题
    f1 = font(FONT_K, 110)
    l1a, l1b, l1c = "开源了我", "十年", "的"
    l2 = "物联网电路设计经验"
    w1 = d.textlength(l1a + l1b + l1c, font=f1)
    x = (W - w1) / 2
    d.text((x, 226), l1a, font=f1, fill=(255, 255, 255)); x += d.textlength(l1a, font=f1)
    d.text((x, 226), l1b, font=f1, fill=AMBER); x += d.textlength(l1b, font=f1)
    d.text((x, 226), l1c, font=f1, fill=(255, 255, 255))
    d.text(((W - d.textlength(l2, font=f1)) / 2, 368), l2, font=f1, fill=(255, 255, 255))
    d.rounded_rectangle((W / 2 - 60, 540, W / 2 + 60, 548), 4, fill=AMBER + (255,))
    fs = font(FONT_B, 50)
    sub = "1分钟学会如何设计低功耗物联网电路"
    d.text(((W - d.textlength(sub, font=fs)) / 2, 580), sub, font=fs, fill=(255, 222, 170))

    # 3D 画面：2×2 拼成一块大卡片
    tiles = [("planner-satellites-3d", 3.6, CROP_P, "卫星贴放"), ("verifier3d-thermal", 7.5, CROP_V, "散热对比"),
             ("verifier3d-emi", 2.5, CROP_V, "受扰地形"), ("verifier3d-current", 2.0, CROP_V, "电流与回流")]
    tw_, gap = 482, 16
    x0, y0 = (W - 2 * tw_ - gap) // 2, 712
    lab = font(FONT_B, 26)
    for k, (n, t, cr, name) in enumerate(tiles):
        c = card(grab(n, t, cr), tw_, 22)
        x, y = x0 + (k % 2) * (tw_ + gap), y0 + (k // 2) * (c.height + gap)
        paste_shadow(im, c, (x, y), blur=18, off=10)
        lay = Image.new("RGBA", (W, H), (0, 0, 0, 0)); ld = ImageDraw.Draw(lay)
        lw = ld.textlength(name, font=lab)
        ld.rounded_rectangle((x + 14, y + 14, x + 14 + lw + 28, y + 14 + 44), 12, fill=(10, 12, 18, 170))
        ld.text((x + 28, y + 19), name, font=lab, fill=(255, 226, 180))
        im.alpha_composite(lay)
    d = ImageDraw.Draw(im)

    # 支持的工具（左下）
    fc = font(FONT_B, 38)
    y = 1350
    for t in ["支持 立创EDA", "支持 KiCad", "实际投板验证通过"]:
        y += chip(d, 60, y, t, fc) + 22
    d.text((62, y + 14), "github.com/donghuixin", font=font(FONT_M, 28), fill=(150, 160, 180))

    # 看板娘（右下，与画面重叠）
    m = Image.open(mascot_path).convert("RGBA")
    mh = 860
    m = m.resize((round(m.width * mh / m.height), mh), Image.LANCZOS)
    halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    a = m.getchannel("A").filter(ImageFilter.MaxFilter(9))
    edge = Image.new("RGBA", m.size, (255, 255, 255, 255)); edge.putalpha(a.point(lambda v: v * 230 // 255))
    mx, my = W - m.width + 20, H - mh - 10
    halo.paste(edge, (mx, my), edge)
    im.alpha_composite(halo.filter(ImageFilter.GaussianBlur(3)))
    paste_shadow(im, m, (mx, my), blur=26, off=18, alpha=170)
    im.convert("RGB").save(out_path, quality=95)
    small = im.convert("RGB").resize((200, round(200 * H / W)), Image.LANCZOS)
    small.save(Path(out_path).with_name("cover-thumb-200.png"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
