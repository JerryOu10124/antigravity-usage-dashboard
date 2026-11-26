#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname;
const srcRoot = path.join(repoRoot, "plugin", "token-usage");

let customDest = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dest" && i + 1 < argv.length) {
    customDest = path.resolve(argv[++i]);
  }
}

const destRoot =
  customDest ||
  path.join(os.homedir(), ".gemini", "config", "plugins", "token-usage");

const requiredFiles = [
  "plugin.json",
  path.join("assets", "logo.svg"),
  path.join("dist", "server.cjs"),
  path.join("dist", "app.html"),
];

for (const rel of requiredFiles) {
  const s = path.join(srcRoot, rel);
  if (!fs.existsSync(s)) {
    console.error(`[错误] 缺少插件文件: ${s}`);
    console.error("请确认下载的是完整仓库，或先在 plugin-src/ 下执行 npm ci && node build.mjs。");
    process.exit(1);
  }
}

fs.mkdirSync(path.join(destRoot, "dist"), { recursive: true });
fs.mkdirSync(path.join(destRoot, "assets"), { recursive: true });

for (const stale of [path.join(destRoot, "dist", "dist"), path.join(destRoot, "assets", "assets")]) {
  if (fs.existsSync(stale)) {
    fs.rmSync(stale, { recursive: true, force: true });
  }
}

for (const rel of requiredFiles) {
  fs.copyFileSync(path.join(srcRoot, rel), path.join(destRoot, rel));
}

const mcpConfig = {
  mcpServers: {
    token_usage: {
      command: process.execPath,
      args: ["${PLUGIN_ROOT}/dist/server.cjs"],
      env: {
        AGY_USAGE_DIR: repoRoot,
      },
    },
  },
};

fs.writeFileSync(
  path.join(destRoot, "mcp_config.json"),
  JSON.stringify(mcpConfig, null, 2) + "\n",
  "utf8"
);

function shortSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex").toUpperCase().slice(0, 12);
}

const srvHash = shortSha256(path.join(destRoot, "dist", "server.cjs"));
const appHash = shortSha256(path.join(destRoot, "dist", "app.html"));

console.log(`已安装 Antigravity 插件到: ${destRoot}`);
console.log(`Node 路径: ${process.execPath}`);
console.log(`仓库目录: ${repoRoot}`);
console.log(`文件校验 SHA256: server.cjs=${srvHash}  app.html=${appHash}`);
console.log('重启（或重开）Antigravity 后，在左侧边栏或右侧面板 "+" 菜单即可打开「Token 统计」。');
