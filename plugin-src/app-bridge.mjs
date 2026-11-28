import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";

const app = new App({ name: "Token 统计", version: "1.0.0" }, {});

let syncInFlight = false;
let initialSyncDone = false;

function formatNowTime() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function runBackgroundSync(isAuto) {
  const dash = window.__AGY_DASHBOARD__;
  if (syncInFlight) return;
  syncInFlight = true;
  if (dash) {
    dash.setSyncStatus(isAuto ? "后台更新统计中..." : "正在刷新统计...", "syncing");
  }
  try {
    const res = await app.callServerTool({
      name: "sync_usage",
      arguments: {},
    });
    const sc = res && res.structuredContent ? res.structuredContent : null;
    if (sc && sc.usageData && dash) {
      dash.setUsageData(sc.usageData);
    }
    if (dash) {
      const notice = (sc && sc.gitNotice) || "";
      const hasGit = Boolean(sc && sc.gitSyncConfigured);
      if (!sc || !sc.ok) {
        dash.setSyncStatus("刷新失败（保留本地数据）", "warn");
      } else if (notice.includes("失败") || notice.includes("尚未") || notice.includes("跳过")) {
        dash.setSyncStatus(`已扫本机 · 远端未连 (${formatNowTime()})`, "warn");
      } else if (hasGit) {
        dash.setSyncStatus(`已同步多机 · ${formatNowTime()}`, "ok");
      } else {
        dash.setSyncStatus(`已更新本机 · ${formatNowTime()}`, "ok");
      }
    }
  } catch {
    if (dash) {
      dash.setSyncStatus("刷新异常（保留本地数据）", "warn");
    }
  } finally {
    syncInFlight = false;
  }
}

function applyHostCtx(ctx) {
  if (!ctx) return;
  if (ctx.theme) {
    if (window.__AGY_DASHBOARD__?.applyHostTheme) {
      window.__AGY_DASHBOARD__.applyHostTheme(ctx.theme);
    } else {
      try {
        applyDocumentTheme(ctx.theme);
      } catch {}
    }
  }
  if (ctx.styles && ctx.styles.variables) {
    try {
      applyHostStyleVariables(ctx.styles.variables);
    } catch {}
  }
}

app.ontoolinput = () => {
  if (window.__AGY_DASHBOARD__) {
    window.__AGY_DASHBOARD__.setLoading(true);
  }
};

app.ontoolresult = async (result) => {
  const dash = window.__AGY_DASHBOARD__;
  const sc = result && result.structuredContent ? result.structuredContent : null;

  if (sc && sc.usageData && dash) {
    dash.setUsageData(sc.usageData);
  } else if (sc && sc.deferred) {
    try {
      const fullRes = await app.callServerTool({
        name: "get_usage_data",
        arguments: {},
      });
      const fullSc = fullRes && fullRes.structuredContent ? fullRes.structuredContent : null;
      if (fullSc && fullSc.usageData && dash) {
        dash.setUsageData(fullSc.usageData);
      } else if (dash) {
        dash.setSyncStatus("暂无本地汇总，尝试自动同步...", "warn");
      }
    } catch {
      if (dash) {
        dash.setSyncStatus("读取本地数据失败，请点击刷新", "warn");
      }
    }
  }

  if (!initialSyncDone) {
    initialSyncDone = true;
    const alreadySyncedLocal =
      sc && sc.ok && sc.source === "local_init" && !sc.gitSyncConfigured;
    if (alreadySyncedLocal) {
      if (dash) {
        dash.setSyncStatus(`已更新本机 · ${formatNowTime()}`, "ok");
      }
    } else {
      runBackgroundSync(true);
    }
  }
};

app.onhostcontextchanged = (ctx) => {
  applyHostCtx(ctx);
};

async function start() {
  if (window.__AGY_DASHBOARD__) {
    window.__AGY_DASHBOARD__.bindManualSync(() => runBackgroundSync(false));
    if (window.__AGY_DASHBOARD__.bindPricingRefresh) {
      window.__AGY_DASHBOARD__.bindPricingRefresh(async () => {
        const res = await app.callServerTool({
          name: "refresh_pricing",
          arguments: {},
        });
        return res && res.structuredContent ? res.structuredContent : null;
      });
    }
  }
  await app.connect();
  applyHostCtx(app.getHostContext());
}

start().catch((err) => {
  console.error("MCP App bridge connect error:", err);
});
