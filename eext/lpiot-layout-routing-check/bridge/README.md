# 本地桥 lpiot-eda-bridge

嘉立创 EDA 扩展“布局布线检查助手”的本地接口。扩展从扩展广场安装；本地桥从本仓库获取：

```bash
cd eext/lpiot-layout-routing-check/bridge
npm install
node bridge.mjs            # 启动枢纽（脚本用 HTTP，端口和令牌写进 ~/.lpiot/bridge.json）
node bridge.mjs --mcp      # 作为 MCP 服务给 AI 客户端用（端口已被占时自动变成转发端）
```

然后在嘉立创 EDA 的 PCB 编辑器里点“布局布线检查 → 连接本地 AI 助手…”（需要在扩展管理里开启本扩展的“外部交互”权限）。连过一次后，以后打开编辑器会自动重连。

拓扑、工具列表、HTTP 接口、安全和排错见 [references/26-eda-link.md](../../../references/26-eda-link.md)。Python 客户端：[scripts/eda_bridge.py](../../../scripts/eda_bridge.py)。
