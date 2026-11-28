# 本地 AI 与嘉立创 EDA 的联动：拓扑、接口与高效检查

本文件说明 skill（本地 AI 客户端里跑的流程和 Python 脚本）怎样和嘉立创 EDA 专业版里的扩展“布局布线检查助手”（`eext/lpiot-layout-routing-check`）配合工作。扩展会单独上架嘉立创扩展广场；本地桥和脚本留在本仓库，作为扩展对应的本地接口。

## 目录
1. 拓扑
2. 为什么这样分工
3. 三种接入方式
4. 高效检查的做法
5. 安全与人工确认
6. 版本与一致性
7. 故障排查

## 1. 拓扑

```
 ┌───────────────────────────────┐   ┌───────────────────────────────┐
 │ AI 客户端 A（Claude Code 等）  │   │ AI 客户端 B（Codex、Cursor 等）│
 │  skill：SKILL.md + references   │   │                               │
 └──────────────┬────────────────┘   └──────────────┬────────────────┘
                │ stdio MCP                          │ stdio MCP
      ┌─────────▼─────────┐               ┌──────────▼─────────┐
      │ bridge.mjs --mcp  │  HTTP + 令牌   │ bridge.mjs --mcp   │
      │  （枢纽）          │◄──────────────┤  （转发端）         │
      │ 127.0.0.1:49731 WS│               └────────────────────┘
      │ 127.0.0.1:49732 HTTP◄──────────── Python 脚本：scripts/eda_bridge.py
      └─────────▲─────────┘   HTTP + 令牌   （导出板子 → route_lint / layout_lint / design_gate）
                │ WebSocket（扩展主动连出）
 ┌──────────────┴──────────────────────────────────────────────────┐
 │ 嘉立创 EDA 专业版（浏览器或桌面客户端）                            │
 │   扩展主线程：TypeScript 规则核心（与 Python 逐条对齐）             │
 │     ├─ eda.* API：读当前 PCB、定位图元、命令组写回（可撤销）        │
 │     ├─ 设计确认按工程保存在本机扩展配置里                            │
 │     └─ 消息总线 ⇄ 面板 iframe：人在这里输入确认码、逐档确认、看动画  │
 └─────────────────────────────────────────────────────────────────┘
```

- **扩展是 WebSocket 客户端。** 嘉立创扩展运行在编辑器的沙箱里，只能用 `eda.sys_WebSocket` 主动连出，不能监听端口；所以本地桥当服务端，扩展连过来。需要用户在扩展管理里开启本扩展的“外部交互”权限。
- **一个枢纽，多个客户端。** 第一个启动的 `bridge.mjs` 占住 49731（给扩展）和 49732（给脚本和其他桥）两个端口，把端口和令牌写进 `~/.lpiot/bridge.json`。之后启动的桥发现端口被占，自动变成转发端，经 HTTP 把调用交给枢纽。编辑器里始终只有一条连接。
- **扩展连过一次后自动重连。** 下次打开编辑器时，扩展在启动时静默尝试连接上次的地址；本地桥没运行时什么也不做。

## 2. 为什么这样分工

| 放在哪 | 做什么 | 原因 |
|---|---|---|
| 扩展（编辑器里） | 读板、检查、修复计划、写回、面板动画、保存设计确认 | 离数据最近：几何不出编辑器就能算完，只把结论交给 AI；写回放在一个命令组里，可撤销 |
| 面板（人） | 输入确认码、逐档确认布线优先级、确认写回 | 确认必须由人完成；AI 代理没有这些接口 |
| 本地桥 | 连接、令牌、转发、把导出的板子写成本机文件 | 编辑器沙箱不能读写本机文件，AI 客户端也不能直接连编辑器 |
| skill（AI 客户端） | 读原理图和资料、和用户讨论需求与分区、按 references 推进、汇报 | 需要上下文、资料和对话；规则核心不在这里重复实现 |
| Python 脚本 | 离线检查 KiCad / Gerber、生成规则、交叉核对 | 不依赖编辑器；与 TypeScript 核心逐条对齐，可以互相验证 |

## 3. 三种接入方式

**MCP（推荐给 AI 客户端）**：在客户端里登记本地桥，例如 Claude Code：

```json
{ "mcpServers": { "lpiot-eda": { "command": "node", "args": ["/path/to/eext/lpiot-layout-routing-check/bridge/bridge.mjs", "--mcp"] } } }
```

工具：`bridge_status`、`design_brief_status`、`design_brief_get`、`design_brief_update`、`priority_draft`、`layout_check`、`board_export`、`routing_check`、`routing_order`、`routing_locate`、`routing_fix_plan`、`routing_fix_apply`、`routing_gate`。没有任何确认工具。

**HTTP（给脚本）**：`POST http://127.0.0.1:49732/rpc`，正文 `{"tool": "routing_check", "params": {"limit": 30}}` 或 `{"method": "<扩展命令>", "params": {}}`，请求头 `X-LPIOT-Token: <~/.lpiot/bridge.json 里的 token>`；`GET /status` 查看连接状态。

**Python 客户端**（本仓库 `scripts/eda_bridge.py`，只用标准库）：

```bash
python scripts/eda_bridge.py status
python scripts/eda_bridge.py export -o board-pack.json         # 编辑器里的板子 → 铜皮数据包
python scripts/route_lint.py lint board-pack.json              # 本地检查同一块板
python scripts/layout_lint.py board-pack.json --brief design-brief.json
python scripts/eda_bridge.py brief-pull -o design-brief.json   # 取回扩展里的设计确认（含确认记录）
python scripts/eda_bridge.py priorities --write                # 让扩展按板子功能梳理优先级，写进 G4
python scripts/eda_bridge.py crosscheck                        # 扩展和本地各算一遍，对照分数和违规
```

## 4. 高效检查的做法

1. **先要结论，再要几何。** `routing_check`、`layout_check` 只返回分数、指标和带坐标的违规（KB 级）；整板几何用 `board_export` 写成本机文件（给 `path`），不要读进对话。
2. **按“检查 → 定位 → 修 → 复查”的小循环推进。** `routing_locate` 在编辑器里直接选中图元给用户看；`routing_fix_plan` 先预览；闸门放行后 `routing_fix_apply` 一次写回；写回后扩展自动重新检查。
3. **一块一块来。** 按 G4 的档位，每布完一档就 `routing_check`，把截图和结论交给用户，再进入下一档（`18-routing-philosophy.md`）。
4. **离线和在线同一套规则。** KiCad 工程直接用 Python 脚本；嘉立创工程用扩展。两边结果不一致时跑 `crosscheck`，通常是版本不同或板框、铺铜读法不同。
5. **减少往返。** 一个枢纽服务多个 AI 客户端；扩展自动重连；面板和 AI 看到的是同一份设计确认（保存在扩展里，`brief-pull` / `brief-push` 与本地文件同步）。

## 5. 安全与人工确认

- 只监听 127.0.0.1；HTTP 必须带令牌（`~/.lpiot/bridge.json`，只有本人可读，每次启动枢纽重新生成）；带 `Origin` 头的请求（来自浏览器网页）一律拒绝。
- 设计确认各级的确认码、布线优先级的逐档确认，只能在扩展面板里由人完成；各级确认还会再弹一次编辑器原生对话框。AI 代理只能读取和填写内容，内容一改，相关确认自动失效。
- 写回修复要求 G0–G4 已放行，并且在编辑器里弹窗请用户确认；修改放在一个命令组里，可以撤销。
- 调用用户自己配置的大模型（AI 解读、AI 梳理优先级）时，检查报告和网络列表会发给该模型服务；API Key 只保存在本机扩展配置里。

## 6. 版本与一致性

- 扩展连上本地桥时报告 `protocol`（当前为 1）和版本；不一致时本地桥打印警告。升级时同时更新扩展和本仓库。
- 规则核心的一致性由测试保证：`tests/fixtures/export_ts_fixtures.py` 把测试板和 Python 结果导出给扩展，扩展的 `test/parity.test.ts`、`test/layout.test.ts` 逐条比对布线违规、布局问题、确认码和优先级草稿。

## 7. 故障排查

| 现象 | 原因与处理 |
|---|---|
| “扩展没有连接” | 编辑器里点“布局布线检查 → 连接本地 AI 助手…”；确认扩展管理里开启了“外部交互”权限 |
| “缺少或错误的令牌” | 枢纽重启过，令牌已更换：脚本会重新读 `~/.lpiot/bridge.json`；手写的 HTTP 请求要换新令牌 |
| 端口被占用且读不到 bridge.json | 有别的程序占用 49731/49732：关掉它，或用 `LPIOT_WS_PORT`、`LPIOT_HTTP_PORT` 换端口（扩展里同时改地址） |
| crosscheck 不一致 | 扩展与仓库版本不同，或板框没画（扩展按器件包络估计板框）；先更新、画好板框再查 |
| 写回被拒绝 | 设计确认 G0–G4 没放行：在面板“确认”页逐级确认（含布线优先级逐档确认） |
