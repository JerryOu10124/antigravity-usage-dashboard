import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const portableOut = path.join(repoRoot, "plugin", "token-usage");
const shouldInstall = process.argv.includes("--install");
const installedOut = path.join(
  os.homedir(),
  ".gemini",
  "config",
  "plugins",
  "token-usage"
);

async function main() {
  const serverResult = await esbuild.build({
    entryPoints: [path.join(__dirname, "server.mjs")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    write: false,
    logLevel: "info",
  });
  const serverCode = serverResult.outputFiles[0].text;

  const bridgeResult = await esbuild.build({
    entryPoints: [path.join(__dirname, "app-bridge.mjs")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    minify: true,
    write: false,
    logLevel: "info",
  });
  const bridgeCode = bridgeResult.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

  const dashHtmlPath = path.join(repoRoot, "dashboard.html");
  let html = fs.readFileSync(dashHtmlPath, "utf8");

  if (!html.includes('<script src="data/usage_bundle.js"></script>')) {
    throw new Error('Expected <script src="data/usage_bundle.js"></script> in dashboard.html');
  }

  html = html.replace(
    '<script src="data/usage_bundle.js"></script>',
    () => "<script>window.__AGY_MCP_MODE__ = true;</script>"
  );
  html = html.replace(
    "</body>",
    () => `<script>\n${bridgeCode}\n</script>\n</body>`
  );

  const pluginJson = fs.readFileSync(path.join(__dirname, "plugin.json"), "utf8");
  const logoSvg = fs.readFileSync(path.join(__dirname, "assets", "logo.svg"), "utf8");

  const targets = shouldInstall ? [portableOut, installedOut] : [portableOut];
  for (const targetDir of targets) {
    fs.mkdirSync(path.join(targetDir, "dist"), { recursive: true });
    fs.mkdirSync(path.join(targetDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, "plugin.json"), pluginJson, "utf8");
    fs.writeFileSync(path.join(targetDir, "assets", "logo.svg"), logoSvg, "utf8");
    fs.writeFileSync(path.join(targetDir, "dist", "server.cjs"), serverCode, "utf8");
    fs.writeFileSync(path.join(targetDir, "dist", "app.html"), html, "utf8");
  }

  if (shouldInstall) {
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
      path.join(installedOut, "mcp_config.json"),
      JSON.stringify(mcpConfig, null, 2) + "\n",
      "utf8"
    );
  }

  const appBytes = Buffer.byteLength(html, "utf8");
  const srvBytes = Buffer.byteLength(serverCode, "utf8");
  console.log(
    `Built server.cjs (${(srvBytes / 1024).toFixed(1)} KB) and app.html (${(appBytes / 1024).toFixed(1)} KB)`
  );
  console.log(`Portable copy: ${portableOut}`);
  if (shouldInstall) {
    console.log(`Installed plugin: ${installedOut}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
