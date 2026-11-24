# README 动图的录制脚本

用虚拟时钟接管页面的 `requestAnimationFrame` 和 `performance.now`，每推进 1/30 秒截一帧，所以动画匀速、不受截图耗时影响；页面上画了一个假光标和点击波纹，方便看清操作。

```bash
pip install playwright && playwright install chromium     # 另需 ffmpeg
python scripts/build_layout_planner.py && python scripts/build_layout_verifier.py
python docs/record/planner.py                              # 规划器：拾取、卫星环绕、飞落贴放
python docs/record/verifier.py [current emi modes thermal routed]
python docs/record/encode.py                               # → /tmp/rec-out/*.mp4（1080p）和 docs/images/*.gif
```
