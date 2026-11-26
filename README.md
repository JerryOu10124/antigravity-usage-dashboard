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
  - **时段用量历史**：5 小时滚动窗口与自然周左右并排对比，展示本地真实消耗与占比。
  - **工具活动与消息**：7 天 / 30 天多系列折线图。
- **多设备汇总（可选）**：支持多台电脑各自生成 `<设备名>.json` 并按人/按设备隔离聚合；开源仓库本身不包含且永不上传任何用户数据。

---

## 隐私与安全说明

- **100% 本地只读扫描**：仅只读解析本机 `~/.gemini/antigravity/brain` 与 `~/.gemini/antigravity-cli/brain` 中的 `transcript.jsonl` 和 `annotations/`，绝不修改、清理或上传你的原始对话日志。
- **零联网遥测**：看板页面为纯离线静态页，无任何外部统计脚本或后端收集服务。
- **代码与数据严格隔离**：`.gitignore` 已屏蔽 `data/*.json`、`data/usage_bundle.js` 与 `config.json`；并且内建安全保护——即使开启了 Git 同步，只要检测到远端为本公开仓库，会自动跳过推送，防止个人对话记录意外上传到公开仓库。

---

## 一键安装（Quick Start）

> **全自动环境检测**：无需预先手动装好 Node.js 或 Git。安装脚本会自动检测本机是否存在 **Node.js 20+**；若缺失会优先通过 `winget` / `brew` 安装，或在无管理员权限时自动从官方下载便携版 Node.js 到本地用户目录（`~/.local/antigravity-node` / `%LOCALAPPDATA%\antigravity-node`），不污染系统环境。

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

在仓库目录拉取最新代码即可：

```bash
git pull
```

- 如果已是新版 `install.mjs` 安装的侧边栏插件，`git pull` 后只需关掉 Antigravity 中的「Token 统计」标签页重新打开，界面即会自动更新（若插件架构有升级，重新执行一次 `install.bat` / `./install.sh` 即可）。
- 如果你从源码二次开发插件（修改了 `plugin-src/` 下的 `.mjs`）：
  ```bash
  npm ci --prefix plugin-src
  node plugin-src/build.mjs
  ```

---

## English Quick Start

One-line install (automatically detects or installs Node.js 20+ without admin privileges, clones/downloads the dashboard, installs the Antigravity sidebar plugin, and scans local transcripts):

- **Windows (PowerShell)**:
  ```powershell
  irm https://raw.githubusercontent.com/JerryOu10124/antigravity-usage-dashboard/main/scripts/setup.ps1 | iex
  ```
- **macOS / Linux**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/JerryOu10124/antigravity-usage-dashboard/main/scripts/setup.sh | bash
  ```

Or clone manually and run `install.bat` / `./install.sh` (sidebar plugin) or `open-dashboard.bat` / `./open-dashboard.sh` (standalone browser).

All transcript parsing runs 100% locally in read-only mode (`~/.gemini/antigravity/brain` & `~/.gemini/antigravity-cli/brain`). Nothing is ever sent to any external server.

---

## License

[MIT](./LICENSE)
