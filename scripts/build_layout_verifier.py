#!/usr/bin/env python3
"""把布局布线验证器的源码内联成一个可离线打开的 HTML 文件。

用法:
    python build_layout_verifier.py [-o assets/layout-verifier.html]

读取 assets/layout-verifier/src/index.html，除了与布局规划器相同的内联规则外：
  - <script type="text/plain" id="worker-src" data-bundle="a.js b.js ..."></script>
      → 把列出的计算模块按顺序拼接成一段文本（不执行），页面运行时用它创建 Web Worker。
复用布局规划器的 geometry.js / model.js（直接引用 assets/layout-planner/src/js/ 下的文件，不复制）。
只依赖 Python 标准库。
"""
import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_layout_planner import build_html, esc_script  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "layout-verifier" / "src"
OUT = ROOT / "assets" / "layout-verifier.html"


def build(src_dir=SRC):
    html = (src_dir / "index.html").read_text(encoding="utf-8")

    def bundle(m):
        attrs, files = m.group(1), m.group(2).split()
        parts = []
        for f in files:
            parts.append(f"/* ---- {f} ---- */\n" + (src_dir / f).read_text(encoding="utf-8"))
        attrs = re.sub(r'\s*data-bundle="[^"]*"', "", attrs)
        return f"<script{attrs}>" + esc_script("\n".join(parts)) + "</script>"
    html = re.sub(r'<script((?:\s+[\w-]+="[^"]*")*?\s+data-bundle="([^"]+)"(?:\s+[\w-]+="[^"]*")*)></script>', bundle, html)
    return build_html(html, src_dir)


def main():
    ap = argparse.ArgumentParser(description="构建布局布线验证器单文件页面")
    ap.add_argument("-o", "--output", default=str(OUT))
    args = ap.parse_args()
    html = build()
    if re.search(r'<script src=|<link rel="stylesheet"|data-src=|data-bundle=', html):
        print("构建后仍有外部引用，请检查 index.html", file=sys.stderr)
        return 1
    out = Path(args.output)
    out.write_text(html, encoding="utf-8")
    print(f"已生成 {out}（{out.stat().st_size / 1024:.0f} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
