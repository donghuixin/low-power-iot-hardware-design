#!/usr/bin/env python3
"""把布局规划器的源码内联成一个可离线打开的 HTML 文件。

用法:
    python build_layout_planner.py [-o assets/layout-planner.html]

读取 assets/layout-planner/src/index.html：
  - <link rel="stylesheet" href="style.css">        → 内联为 <style>
  - <script src="js/xxx.js"></script>                → 按出现顺序内联为 <script>
  - <script type="text/plain" id="three-src" data-src="../vendor/three.module.min.js"></script>
                                                     → 内联 Three.js 文本（不执行，切到 3D 时才加载）
  - <script type="application/json" id="example-data" data-src="../../layout-project-example.json"></script>
                                                     → 内联示例项目
只依赖 Python 标准库。
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "layout-planner" / "src"
OUT = ROOT / "assets" / "layout-planner.html"


def esc_script(text):
    """防止内联内容提前结束 <script> 标签。"""
    return re.sub(r"</(script)", r"<\\/\1", text, flags=re.I)


def build(src_dir=SRC):
    return build_html((src_dir / "index.html").read_text(encoding="utf-8"), src_dir)


def build_html(html, src_dir):
    """内联 index.html 里的样式、脚本和数据（路径相对于 src_dir）。"""
    def css(m):
        return "<style>\n" + (src_dir / m.group(1)).read_text(encoding="utf-8") + "\n</style>"
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', css, html)

    def js(m):
        code = (src_dir / m.group(1)).read_text(encoding="utf-8")
        return f"<script>\n/* ---- {m.group(1)} ---- */\n" + esc_script(code) + "\n</script>"
    html = re.sub(r'<script src="([^"]+)"></script>', js, html)

    def data(m):
        attrs, path = m.group(1), m.group(2)
        text = (src_dir / path).read_text(encoding="utf-8")
        attrs = re.sub(r'\s*data-src="[^"]*"', "", attrs)
        return f"<script{attrs}>" + esc_script(text) + "</script>"
    html = re.sub(r'<script((?:\s+[\w-]+="[^"]*")*?\s+data-src="([^"]+)"(?:\s+[\w-]+="[^"]*")*)></script>', data, html)
    return html


def main():
    ap = argparse.ArgumentParser(description="构建布局规划器单文件页面")
    ap.add_argument("-o", "--output", default=str(OUT))
    args = ap.parse_args()
    html = build()
    if re.search(r'<script src=|<link rel="stylesheet"|data-src=', html):
        print("构建后仍有外部引用，请检查 index.html", file=sys.stderr)
        return 1
    out = Path(args.output)
    out.write_text(html, encoding="utf-8")
    print(f"已写入 {out}（{out.stat().st_size / 1024:.0f} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
