import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_DIR =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(path.resolve(process.argv[1] || "."));

const USAGE_DIR =
  process.env.AGY_USAGE_DIR || path.resolve(BASE_DIR, "..", "..", "..");
const RESOURCE_URI = "ui://token-usage/dashboard.html";
const RESOURCE_MIME = "text/html;profile=mcp-app";

function resolveAppHtmlPath() {
  if (process.env.AGY_APP_HTML && fs.existsSync(process.env.AGY_APP_HTML)) {
    return process.env.AGY_APP_HTML;
  }
  const repoAppHtml = path.join(USAGE_DIR, "plugin", "token-usage", "dist", "app.html");
  if (fs.existsSync(repoAppHtml)) {
    return repoAppHtml;
  }
  return path.join(BASE_DIR, "app.html");
}

function readBundleData(usageDir) {
  const bundlePath = path.join(usageDir, "data", "usage_bundle.js");
  if (!fs.existsSync(bundlePath)) return null;
  const raw = fs.readFileSync(bundlePath, "utf8").trim();
  const jsonStr = raw
    .replace(/^\s*window\.AGY_USAGE_DATA\s*=\s*/, "")
    .replace(/;\s*$/, "");
  if (!jsonStr) return null;
  return JSON.parse(jsonStr);
}

function isGitSyncConfigured(usageDir) {
  const cfgPath = path.join(usageDir, "config.json");
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return Boolean(parsed && parsed.gitSync === true);
  } catch {
    return false;
  }
}

function runSyncScript(usageDir, gitSyncArg) {
  const scriptPath = path.join(usageDir, "sync_usage.mjs");
  return new Promise((resolve) => {
    if (!fs.existsSync(scriptPath)) {
      resolve({
        ok: false,
        stdout: "",
        stderr: `未找到同步脚本: ${scriptPath}`,
        exitCode: 1,
        usageData: readBundleData(usageDir),
      });
      return;
    }

    const args = [scriptPath];
    if (gitSyncArg === true) args.push("--git-sync");
    else if (gitSyncArg === false) args.push("--no-git-sync");

    execFile(
      process.execPath,
      args,
      {
        cwd: usageDir,
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        let usageData = null;
        try {
          usageData = readBundleData(usageDir);
        } catch {
          usageData = null;
        }
        resolve({
          ok: !err,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || (err ? err.message : "")).trim(),
          exitCode: err && typeof err.code === "number" ? err.code : 0,
          usageData,
        });
      }
    );
  });
}

function summarizeUsage(usageData, includeMachineNames = false) {
  if (!usageData || !Array.isArray(usageData.machines)) {
    return "暂无本地 Token 统计数据。";
  }
  let convs = 0;
  let inp = 0;
  let cache = 0;
  let out = 0;
  const names = [];
  for (const m of usageData.machines) {
    if (m.machine) names.push(m.machine);
    convs += Number(m.conversation_count) || 0;
    for (const r of m.hourly_records || []) {
      inp += Number(r.input) || 0;
      cache += Number(r.cache_read) || 0;
      out += Number(r.output) || 0;
    }
  }
  const full = inp + cache + out;
  const net = inp + out;
  const devLabel = includeMachineNames
    ? `${usageData.machines.length} 台设备（${names.join(", ") || "本机"}）`
    : `${usageData.machines.length} 台设备`;
  return `已汇总 ${devLabel}，共 ${convs} 个会话；全量合计 ${full.toLocaleString("en-US")} Token，净新增 ${net.toLocaleString("en-US")} Token。`;
}

function extractGitNotice(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  const gitLines = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("[Git 同步]"));
  return gitLines.join(" | ");
}

const server = new Server(
  { name: "token-usage", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: RESOURCE_URI,
        name: "Token 统计看板",
        description: "Antigravity 个人概览热力图与使用情况分析面板",
        mimeType: RESOURCE_MIME,
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== RESOURCE_URI) {
    throw new Error(`Unknown resource URI: ${request.params.uri}`);
  }
  const html = fs.readFileSync(resolveAppHtmlPath(), "utf8");
  return {
    contents: [
      {
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME,
        text: html,
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "open_token_usage",
        title: "Token 统计",
        description:
          "打开 Antigravity Token 统计与使用情况分析看板（含个人概览热力图、API 费用估值、模型折线图与使用情况分析）。",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        _meta: {
          ui: { resourceUri: RESOURCE_URI },
          "com.google.antigravity/ui": {
            entrypoints: [
              { type: "aux_pane", title: "Token 统计" },
              { type: "global", title: "Token 统计" },
            ],
          },
        },
      },
      {
        name: "sync_usage",
        title: "同步 Token 用量",
        description: "运行本地增量日志采集与可选私有仓库同步，返回最新统计数据。",
        inputSchema: {
          type: "object",
          properties: {
            gitSync: { type: "boolean" },
          },
          additionalProperties: false,
        },
        _meta: {
          ui: { visibility: ["app"] },
        },
      },
      {
        name: "get_usage_data",
        title: "读取本地汇总数据",
        description: "读取当前已归档的 usage_bundle 数据。",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        _meta: {
          ui: { visibility: ["app"] },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  if (name === "open_token_usage") {
    let usageData = null;
    try {
      usageData = readBundleData(USAGE_DIR);
    } catch {
      usageData = null;
    }

    let source = "cached";
    let ok = true;
    let errorMsg = null;
    if (!usageData) {
      const syncRes = await runSyncScript(USAGE_DIR, false);
      usageData = syncRes.usageData;
      ok = syncRes.ok;
      errorMsg = syncRes.ok ? null : syncRes.stderr || syncRes.stdout || "初始化扫描失败";
      source = "local_init";
    }

    const summary = ok
      ? summarizeUsage(usageData, false) + "（明细仅在 UI 面板内读取）"
      : errorMsg;

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        ok,
        deferred: true,
        source,
        gitSyncConfigured: isGitSyncConfigured(USAGE_DIR),
        error: errorMsg,
      },
    };
  }

  if (name === "sync_usage") {
    const gitSyncArg = typeof args.gitSync === "boolean" ? args.gitSync : undefined;
    const res = await runSyncScript(USAGE_DIR, gitSyncArg);
    const gitNotice = extractGitNotice(res.stdout);
    const gitSyncConfigured =
      gitSyncArg !== undefined ? gitSyncArg : isGitSyncConfigured(USAGE_DIR);
    const summary = summarizeUsage(res.usageData);
    return {
      content: [
        {
          type: "text",
          text: gitNotice ? `${gitNotice}\n${summary}` : summary,
        },
      ],
      structuredContent: {
        ok: res.ok,
        usageData: res.usageData,
        gitSyncConfigured,
        gitNotice,
        syncedAt: new Date().toISOString(),
        error: res.ok ? null : res.stderr || res.stdout || "同步失败",
      },
    };
  }

  if (name === "get_usage_data") {
    const usageData = readBundleData(USAGE_DIR);
    return {
      content: [{ type: "text", text: summarizeUsage(usageData) }],
      structuredContent: { ok: true, usageData },
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
