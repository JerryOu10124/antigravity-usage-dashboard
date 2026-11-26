# Antigravity Usage Dashboard

跨平台（Windows / macOS / Linux）、零第三方上报的 Antigravity 本地与多设备 Token 用量统计及 API 成本估算看板。支持直接内嵌到 Antigravity 左侧边栏（MCP App 插件），也支持在浏览器独立打开。

---

## 核心特性

- **个人概览（Overview）**
  - 全局 **`按 Token` / `按费用 ($)`** 一键切换，支持按模型官方单价与调用日期自动折算等效 API 成本、计算上下文缓存省钱额，并可自定义单价表。
  - **7 行点阵活动热力图**：提供「每天 / 每周 / 累计总量」三种 Codex 风格视图，支持点击任意日期聚光灯高亮并联动筛选下方每日明细。
  - **热门工具与技能**、**洞察面板**（Plan 模式占比、推理强度分布、缓存命中率、已探索技能数）、**构成与模型分布**以及**每日用量明细**。
- **使用情况分析（Analytics）**
  - **用量历史记录**：7 天 / 30 天圆角堆叠柱状图，支持前后翻页、按场景 / 按模型 / 按设备分组切换。
  - **聊天用量排行**：按会话展示累计 Token、折合费用与工具步数，点击展开首条提问、单轮最长耗时与模型构成。
  - **时段用量历史**：非重叠 5 小时时段与自然周左右并排对比，展示本地真实消耗与占比。
  - **工具活动与消息**：7 天 / 30 天 Top 6 系列多线趋势图。
- **多设备汇总（可选）**：支持多台电脑各自生成 `<设备名>.json` 并按人/按设备隔离聚合；开源仓库本身不包含且永不上传任何用户数据。

---

## 隐私与数据边界说明

- **100% 本地只读扫描**：仅只读解析本机 `~/.gemini/antigravity/brain` 与 `~/.gemini/antigravity-cli/brain` 中的 `transcript.jsonl` 和 `annotations/`，绝不修改、清理或上传你的原始对话日志。
- **三种运行模式的数据流向**：
  1. **独立浏览器模式**（`open-dashboard.bat` / `open-dashboard.sh`）：全程纯本地离线运行，零任何网络请求。
  2. **Antigravity 侧边栏模式（MCP App）**：会话标题、首问摘录与按日/小时明细严格通过前端 UI 专属通道（`visibility: ["app"]`）在本地插件页面内读取渲染，不随默认工具结果暴露给对话模型上下文；宿主工具返回值仅含汇总数字。
  3. **可选私有 Git 同步模式**：仅当你手动在 `config.json` 中启用 `gitSync: true` 并指向自己的私有数据仓库时，才会将本机 `<设备名>.json` 推送至你自己的远程仓库；脚本内置双重防护（检测代码仓、fetch URL 与 push URL），只要指向本公开仓库会自动拒绝推送。

---

## 一键安装（Quick Start）

> **支持环境与自动补齐**：支持 Windows (`x64` / `arm64`)、macOS (`arm64` / `x64`) 与主流 Linux (`x64` / `arm64`，需自带 `bash`、`curl`、`tar`)。无需预先手动安装 Node.js 或 Git：若缺少 **Node.js 20+**，Windows 会自动尝试 `winget` 或免管理员便携版（`%LOCALAPPDATA%\antigravity-node`）；macOS/Linux 会尝试 Homebrew 或无 `sudo` 便携版（`~/.local/antigravity-node`），不污染系统环境。

### 方式一：一行命令远程一键安装（推荐，零前置步骤）

打开终端粘贴运行即可自动拉取仓库、补齐 Node.js 20+、安装 Antigravity 侧边栏插件并完成首次日志扫描：

- **Windows（PowerShell）**：
  ```powershell
  irm https://raw.githubusercontent.com/JerryOu10124/antigravity-usage-dashboard/main/scripts/setup.ps1 | iex
  ```
- **macOS / Linux（Terminal）**：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/JerryOu10124/antigravity-usage-dashboard/main/scripts/setup.sh | bash
  ```

安装完成后重启（或重开）Antigravity，即可在左侧边栏和右侧面板 `+` 菜单中打开 **「Token 统计」**。

---

### 方式二：下载仓库后本地一键安装 / 独立打开

如果你已通过 `git clone` 或 GitHub 下载 ZIP 解压到本地目录：

1. **集成到 Antigravity 侧边栏（「Token 统计」）**：
   - **Windows**：直接双击根目录下的 **`install.bat`**（会自动检测/安装 Node.js 20+ 并完成插件部署与首次扫描）。
   - **macOS / Linux**：
     ```bash
     chmod +x install.sh open-dashboard.sh scripts/setup.sh
     ./install.sh
     ```
2. **仅用浏览器独立查看**：
   - **Windows**：双击 **`open-dashboard.bat`**（缺少 Node.js 时同样会自动补齐）。
   - **macOS / Linux**：运行 **`./open-dashboard.sh`**。

---

## 可选：多台电脑跨设备汇总（台式机 + 笔记本）

如果你想在两台电脑上合并查看总用量，只需要将 `config.example.json` 复制为 `config.json`（该文件已加入 `.gitignore`，不会被提交）：

1. **配合私有 Git 仓库（推荐）**
   - 在你自己的 GitHub 账号下新建一个 **Private（私有）仓库**（例如 `my-antigravity-usage-data`），克隆到本地（如 `D:\my-usage-data` 或 `~/my-usage-data`）。
   - 在本项目的 `config.json` 中填写：
     ```json
     {
       "dataDir": "D:\\my-usage-data",
       "gitSync": true,
       "machineName": ""
     }
     ```
   - 之后每次打开看板都会自动先 `git pull --rebase` 拉取另一台电脑的 `<设备名>.json`，更新本机归档后只提交并推送你自己的私有仓库。

2. **配合网盘同步盘（OneDrive / iCloud / 坚果云）**
   - 将 `config.json` 里的 `dataDir` 指到同步盘中的共享文件夹，`gitSync` 保持 `false`。两台电脑分别写入 `<各自设备名>.json`，打开时会自动合并读取目录下全部设备。

3. **手动临时对比**
   - 直接点看板左下角的 **「导入设备 JSON」**，选中另一台电脑的 `data/<设备名>.json` 即可在浏览器内合并预览。

---

## 更新看板到最新版

- **Git 克隆安装的用户**：在仓库目录拉取最新代码即可：
  ```bash
  git pull
  ```
- **通过 ZIP / 无 Git 一键脚本安装的用户**：直接重新运行上方对应系统的一行命令（会自动覆盖程序代码并完整保留已有的 `data/` 归档与 `config.json`），或下载最新 ZIP 解压覆盖除 `data/` 与 `config.json` 外的文件。
- 如果是前端界面更新，拉取后关掉 Antigravity 中的「Token 统计」标签页再重新打开即自动生效；若服务端（`plugin-src/server.mjs`）有升级，请重新运行一次 `install.bat` / `./install.sh`。
- 如果你从源码二次开发插件（修改了 `plugin-src/` 下的 `.mjs`）：
  ```bash
  npm ci --prefix plugin-src
  node plugin-src/build.mjs
  ```

---

## English Quick Start

One-line install (supports Windows x64/arm64, macOS arm64/x64, Linux x64/arm64; automatically detects or installs Node.js 20+ without admin/sudo into user-local storage, downloads/clones the repo, installs the Antigravity sidebar plugin, and runs the initial scan):

- **Windows (PowerShell)**:
  ```powershell
  irm https://raw.githubusercontent.com/JerryOu10124/antigravity-usage-dashboard/main/scripts/setup.ps1 | iex
  ```
- **macOS / Linux**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/JerryOu10124/antigravity-usage-dashboard/main/scripts/setup.sh | bash
  ```

Or clone manually and run `install.bat` / `./install.sh` (sidebar plugin) or `open-dashboard.bat` / `./open-dashboard.sh` (standalone browser).

All transcript parsing runs 100% locally in read-only mode (`~/.gemini/antigravity/brain` & `~/.gemini/antigravity-cli/brain`). Standalone mode makes zero network calls; MCP App mode keeps detailed prompts/titles inside UI-only tool calls (`visibility: ["app"]`); Git push sync is off by default and strictly restricted to user-configured private data repositories.

---

## License

[MIT](./LICENSE)
