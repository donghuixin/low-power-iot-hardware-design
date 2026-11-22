# 将嘉立创 EDA 或 KiCad 接入 AI 助手

MCP 让助手调用本机 EDA 工具。先选正在使用的编辑器，再选 Codex 或 Claude Code，只执行对应的注册命令。以下使用本地 stdio 连接，由助手按需启动服务进程。终端、助手和 EDA 编辑器应运行在同一台电脑的同一用户环境中。

## 嘉立创 EDA 专业版

1. 从官网下载并安装 **V4.1.60 或以上的专业版桌面客户端**，在桌面编辑器中打开一个能认出名字的测试工程。这个版本自带 MCP 服务，网页版不提供这里用到的本地桥接。[客户端下载](https://lceda.cn/page/download) · [官方 CLI 与 MCP 指南](https://prodocs.easyeda.com/cn/api/guide/cli.html)
2. 在终端执行下面两条命令。第一条结果中的 `value.connected` 应为 `true`，第二条应列出测试工程对应的窗口标题或路径。

   ```sh
   lceda-pro doctor
   lceda-pro session list
   ```

3. 在所用助手中注册服务。若终端找不到 `lceda-pro`，将命令中的程序名换成安装目录内可执行文件的绝对路径，用双引号包住路径。Windows 默认位置通常为 `C:\Program Files\lceda-pro\lceda-pro.exe`。

   **Codex**
   ```sh
   codex mcp add lceda -- lceda-pro --mcp stdio
   ```

   **Claude Code**（在工作项目目录执行）
   ```sh
   claude mcp add --transport stdio lceda -- lceda-pro --mcp stdio
   ```

4. 新开助手会话，输入：“请通过 lceda MCP 列出打开的编辑器会话，只返回工程标题、路径和会话 ID。” 将结果与第 2 步对照。能读到同一工程后，再按[嘉立创 EDA 设计流程](10-easyeda-execution.md)开展设计。

## KiCad PCB 编辑器

这里使用社区项目 **HackInvent/kicad-mcp v0.3.1（alpha）**，通过 KiCad 的 IPC 接口读取当前打开的 PCB。示例覆盖 PCB 信息、封装与板层。原理图评审可直接提供 `.kicad_sch` 或 PDF。上游将真实 GUI 集成列为待验证项，首次连接请用示例板核对结果。[项目版本说明](https://github.com/HackInvent/kicad-mcp/releases/tag/v0.3.1) · [KiCad IPC 文档](https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/for-addon-developers/)

1. 安装 KiCad 10.x、Git 和 Python 3.10 或以上版本。在 KiCad 的偏好设置中找到插件设置，启用 KiCad API，再用 PCB 编辑器打开一块已有封装的示例板，保持窗口开启。[KiCad 下载](https://www.kicad.org/download/) · [服务安装说明](https://github.com/HackInvent/kicad-mcp/tree/v0.3.1#stdio-mode-and-development)
2. 在用于存放工具的目录里安装服务。首次安装需要联网。macOS 或 Linux 执行：

   ```sh
   git clone --branch v0.3.1 --depth 1 https://github.com/HackInvent/kicad-mcp.git
   cd kicad-mcp
   python3 -m venv .venv
   .venv/bin/python -m pip install .
   .venv/bin/kicad-mcp serve --help
   ```

   Windows PowerShell 用户执行相同的前两行，然后执行：

   ```powershell
   py -3 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install .
   .\.venv\Scripts\kicad-mcp.exe serve --help
   ```

3. 注册服务。把示例路径换成上一步生成的可执行文件的**绝对路径**。Windows 使用 `.venv\Scripts\kicad-mcp.exe`。这里使用只读模式来验证连接，这种启动方式无需在 KiCad 里另装或启动 HTTP 插件。

   **Codex**
   ```sh
   codex mcp add kicad -- "/absolute/path/kicad-mcp/.venv/bin/kicad-mcp" serve --transport stdio --read-only
   ```

   **Claude Code**（回到工作项目目录执行）
   ```sh
   claude mcp add --transport stdio kicad -- "/absolute/path/kicad-mcp/.venv/bin/kicad-mcp" serve --transport stdio --read-only
   ```

4. 新开助手会话，输入：“请通过 kicad MCP 调用 get_board_info 和 list_footprints，告诉我当前板名和一个实际存在的封装位号。” 对照 PCB 编辑器里的文件名和位号。后续确需编辑时，从服务启动参数移除 `--read-only` 并重启服务。

## 连接失败时先查哪一层

| 现象 | 下一步 |
|---|---|
| 助手中找不到服务 | 用 `codex mcp list` 或 `claude mcp list` 查看注册项。Claude Code 默认按项目注册，请从注册时的项目目录启动。 |
| 服务已登记，但启动时报找不到程序 | 检查登记的可执行文件路径。在同一用户环境中运行该文件的 `--help`，然后用绝对路径更新注册项。 |
| 立创返回 `ok: true`，但 `connected: false` | 打开专业版桌面编辑器中的工程窗口，再运行 `doctor`。有多个窗口时按 `session list` 的路径选工程。 |
| KiCad 工具可见，但读不到板或读错板 | 确认 PCB 编辑器已打开目标板并启用 API。先用单个编辑器实例重试；多个实例可按上游说明指定 `KICAD_API_SOCKET`。重启编辑器后也重启 MCP 服务。 |

客户端配置语法可查阅 [Codex MCP 文档](https://developers.openai.com/codex/mcp/) 和 [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)。
