# README 动图的录制脚本

用虚拟时钟接管页面的 `requestAnimationFrame` 和 `performance.now`，每推进 1/30 秒截一帧，所以动画匀速、不受截图耗时影响；页面上画了一个假光标和点击波纹，方便看清操作。

```bash
pip install playwright && playwright install chromium     # 另需 ffmpeg
python scripts/build_layout_planner.py && python scripts/build_layout_verifier.py
python docs/record/planner.py                              # 规划器：拾取、卫星环绕、飞落贴放
python docs/record/planner3d.py                            # 同上，3D 视图
python docs/record/verifier.py [current emi modes thermal routed]
python docs/record/verifier3d.py [current emi modes thermal]   # 3D 视图（软件 WebGL，较慢）
python docs/record/record_schematic.py                     # 原理图绘制流程演示（schematic-demo.html，录前 15 秒）
python docs/record/encode.py                               # → /tmp/rec-out/*.mp4（1080p）和 docs/images/*.gif
```

## 1 分钟介绍片

按 [1minVideo](https://github.com/donghuixin/1minVideo) 的做法：先写分镜（`intro/storyboard.json`：起止秒、素材、取段、速度、章节、口播），画面母版不带声音，字幕和口播稿外置，封面单独出。

```bash
python docs/record/make_intro.py docs/record/intro          # 由上面录好的 MP4 剪成 16:9、约 56 秒的母版
python docs/record/make_cover.py 看板娘.png cover.png       # 竖屏封面 1080×1920（另存 200 像素宽缩略图做验收）
```

产物：`intro/low-power-iot-intro.mp4`（无音轨）、`intro/low-power-iot-intro.srt`（按镜头定时，不烧录）、`intro/narration-clean.txt`（口播稿，配音时按此录）。
