#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RX_TYPE = /"type"\s*:\s*"([^"]+)"/;
const RX_CREATED_AT = /"created_at"\s*:\s*"([^"]+)"/;
const RX_SKILL_PATH = /[\\/]skills[\\/]([^\\/"]+)[\\/]SKILL\.md/i;
const RX_PUBLIC_OSS_REPO = /\/antigravity-usage-dashboard(?:\.git)?\/?$/i;

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function formatLocalYmd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatLocalIso(date) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offH = pad2(Math.floor(absMin / 60));
  const offM = pad2(absMin % 60);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${ms}${sign}${offH}:${offM}`
  );
}

function formatGitCommitStamp(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

function sanitizeMachineName(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_");
  return cleaned || "local-machine";
}

function writeUtf8Atomic(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, targetPath);
}

function parseArgs(argv) {
  const opts = {
    dataDir: null,
    bundleOut: null,
    machineName: null,
    gitSync: null,
    sourceRoots: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir" && i + 1 < argv.length) {
      opts.dataDir = argv[++i];
    } else if (a === "--bundle-out" && i + 1 < argv.length) {
      opts.bundleOut = argv[++i];
    } else if (a === "--machine" && i + 1 < argv.length) {
      opts.machineName = argv[++i];
    } else if (a === "--git-sync") {
      opts.gitSync = true;
    } else if (a === "--no-git-sync") {
      opts.gitSync = false;
    } else if (a === "--source-roots" && i + 1 < argv.length) {
      const val = argv[++i];
      if (!opts.sourceRoots) opts.sourceRoots = [];
      for (const part of val.split(",")) {
        if (part.trim()) opts.sourceRoots.push(part.trim());
      }
    }
  }
  return opts;
}

function loadConfig(repoRoot) {
  const cfgPath = path.join(repoRoot, "config.json");
  if (!fs.existsSync(cfgPath)) return {};
  try {
    const raw = fs.readFileSync(cfgPath, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.warn(`[配置警告] 读取 config.json 失败，已使用默认配置: ${err.message}`);
    return {};
  }
}

function decodePbtxtTitle(raw) {
  if (!raw) return "";
  const bytes = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (
        next >= "0" &&
        next <= "7" &&
        i + 3 < raw.length &&
        /^[0-7]{3}$/.test(raw.slice(i + 1, i + 4))
      ) {
        bytes.push(parseInt(raw.slice(i + 1, i + 4), 8));
        i += 4;
        continue;
      }
      let rep = next;
      if (next === '"') rep = '"';
      else if (next === "\\") rep = "\\";
      else if (next === "n" || next === "r" || next === "t") rep = " ";
      for (const b of Buffer.from(rep, "utf8")) bytes.push(b);
      i += 2;
      continue;
    }
    for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
    i++;
  }
  return Buffer.from(bytes).toString("utf8").replace(/\s+/g, " ").trim();
}

function readAnnotationInfo(annotationsDir, convId) {
  const result = {
    title: "",
    planExecute: false,
    annWriteUtc: "",
  };
  if (!annotationsDir || !fs.existsSync(annotationsDir)) return result;
  const pbtxtPath = path.join(annotationsDir, `${convId}.pbtxt`);
  if (!fs.existsSync(pbtxtPath)) return result;
  try {
    const st = fs.statSync(pbtxtPath);
    result.annWriteUtc = st.mtime.toISOString();
    const content = fs.readFileSync(pbtxtPath, "utf8");
    const mTitle = content.match(/title\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (mTitle) {
      result.title = decodePbtxtTitle(mTitle[1]);
    }
    if (/plan_execute\s*:\s*true/.test(content)) {
      result.planExecute = true;
    }
  } catch {
    // 忽略元数据读取异常，不影响主日志扫描
  }
  return result;
}

function extractUserPromptText(content) {
  if (!content || !String(content).trim()) {
    return { text: "", hadTag: false };
  }
  let txt = String(content);
  let hadTag = false;
  const m = txt.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (m) {
    txt = m[1];
    hadTag = true;
  }
  txt = txt.replace(/\s+/g, " ").trim();
  if (txt.length > 120) {
    txt = txt.slice(0, 120) + "...";
  }
  return { text: txt, hadTag };
}

async function parseTranscriptFile(filePath, fileStat, sourceName, convId, annInfo) {
  const hourlyBuckets = {};
  const toolDaily = {};
  const skills = {};

  let totalSteps = 0;
  let turns = 0;
  let maxTurnSec = 0;
  let maxTurnDate = "";
  let turnStart = null;
  let turnEnd = null;
  let firstAt = null;
  let lastAt = null;
  let firstStepSource = "";
  let firstPrompt = "";
  let firstUserHadTag = false;
  let capturedFirstUser = false;
  let planExecute = Boolean(annInfo.planExecute);
  let totalTools = 0;

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      try {
        const needsFullParse =
          !firstStepSource ||
          line.includes('"input_tokens"') ||
          line.includes('"output_tokens"') ||
          line.includes('"cache_read_tokens"') ||
          line.includes('"tool_calls"') ||
          (!capturedFirstUser && line.includes('"USER_INPUT"'));

        let stepType = "";
        let stepSource = "";
        let createdAtStr = "";
        let parsedObj = null;

        if (!needsFullParse) {
          const head = line.length > 400 ? line.slice(0, 400) : line;
          const mType = head.match(RX_TYPE);
          const mTs = head.match(RX_CREATED_AT);
          if (mType && mTs) {
            stepType = mType[1];
            createdAtStr = mTs[1];
          } else {
            parsedObj = JSON.parse(line);
            if (parsedObj && typeof parsedObj === "object") {
              stepType = String(parsedObj.type || "");
              stepSource = String(parsedObj.source || "");
              createdAtStr = String(parsedObj.created_at || "");
            }
          }
        } else {
          parsedObj = JSON.parse(line);
          if (parsedObj && typeof parsedObj === "object") {
            stepType = String(parsedObj.type || "");
            stepSource = String(parsedObj.source || "");
            createdAtStr = String(parsedObj.created_at || "");
          }
        }

        if (!firstStepSource && stepSource) {
          firstStepSource = stepSource;
        }
        if (!createdAtStr || !createdAtStr.trim()) continue;

        const tsMs = Date.parse(createdAtStr);
        if (Number.isNaN(tsMs)) continue;
        const tsDate = new Date(tsMs);
        const localDate = formatLocalYmd(tsDate);
        const localHour = tsDate.getHours();
        totalSteps++;

        if (firstAt === null || tsMs < firstAt) firstAt = tsMs;
        if (lastAt === null || tsMs > lastAt) lastAt = tsMs;

        if (stepType === "USER_INPUT") {
          if (!capturedFirstUser && parsedObj && typeof parsedObj.content === "string" && parsedObj.content) {
            const uInfo = extractUserPromptText(parsedObj.content);
            firstPrompt = uInfo.text;
            firstUserHadTag = uInfo.hadTag;
            capturedFirstUser = true;
          }

          if (turnStart !== null && turnEnd !== null) {
            const dur = (turnEnd - turnStart) / 1000;
            if (dur > maxTurnSec) {
              maxTurnSec = Math.round(dur);
              maxTurnDate = formatLocalYmd(new Date(turnStart));
            }
          }
          turnStart = tsMs;
          turnEnd = tsMs;
          turns++;
        } else if (
          (stepType === "PLANNER_RESPONSE" || stepType === "GENERIC" || stepType === "ERROR_MESSAGE") &&
          turnStart !== null
        ) {
          if (tsMs > turnEnd) turnEnd = tsMs;
        }

        if (parsedObj && (stepSource === "MODEL" || stepType === "PLANNER_RESPONSE")) {
          const inTok = Number(parsedObj.input_tokens) || 0;
          const caTok = Number(parsedObj.cache_read_tokens) || 0;
          const ouTok = Number(parsedObj.output_tokens) || 0;

          if (inTok > 0 || caTok > 0 || ouTok > 0) {
            const model = parsedObj.model ? String(parsedObj.model) : "unknown";
            const hourStr = pad2(localHour);
            const bKey = `${localDate}T${hourStr}|${model}`;
            if (!hourlyBuckets[bKey]) {
              hourlyBuckets[bKey] = {
                date: localDate,
                hour: localHour,
                model,
                steps: 0,
                input: 0,
                cache_read: 0,
                output: 0,
              };
            }
            const bucket = hourlyBuckets[bKey];
            bucket.steps += 1;
            bucket.input += inTok;
            bucket.cache_read += caTok;
            bucket.output += ouTok;
          }

          if (Array.isArray(parsedObj.tool_calls)) {
            for (const tc of parsedObj.tool_calls) {
              if (!tc || typeof tc !== "object") continue;
              const tName = tc.name ? String(tc.name).trim() : "";
              if (!tName) continue;

              const tKey = `${localDate}|${tName}`;
              toolDaily[tKey] = (toolDaily[tKey] || 0) + 1;
              totalTools += 1;

              if (tName === "enter_plan_mode" || tName === "exit_plan_mode") {
                planExecute = true;
              }

              if (tName === "read_file" && tc.args != null) {
                let argPath = "";
                if (typeof tc.args === "object") {
                  argPath = tc.args.Path ? String(tc.args.Path) : "";
                } else {
                  argPath = String(tc.args);
                }
                if (argPath) {
                  argPath = argPath.replace(/"/g, "").replace(/\\\\/g, "\\");
                  const mSkill = argPath.match(RX_SKILL_PATH);
                  if (mSkill) {
                    const sName = mSkill[1];
                    skills[sName] = (skills[sName] || 0) + 1;
                  }
                }
              }
            }
          }
        }
      } catch {
        // 忽略正在写入中的半截 JSON 行
        continue;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (turnStart !== null && turnEnd !== null) {
    const dur = (turnEnd - turnStart) / 1000;
    if (dur > maxTurnSec) {
      maxTurnSec = Math.round(dur);
      maxTurnDate = formatLocalYmd(new Date(turnStart));
    }
  }

  let scene = "chat";
  if (sourceName === "cli") {
    scene = "cli";
  } else if (firstStepSource && firstStepSource !== "USER_EXPLICIT" && !firstUserHadTag) {
    scene = "subagent";
  }

  let title = annInfo.title;
  if (!title || !title.trim()) {
    if (firstPrompt) {
      title = firstPrompt.length > 48 ? firstPrompt.slice(0, 48) + "..." : firstPrompt;
    } else {
      title = convId.slice(0, Math.min(8, convId.length));
    }
  }

  return {
    source: sourceName,
    scene,
    conv_id: convId,
    title,
    first_prompt: firstPrompt,
    plan_execute: Boolean(planExecute),
    file_size: fileStat.size,
    last_write_utc: fileStat.mtime.toISOString(),
    ann_write_utc: annInfo.annWriteUtc || "",
    first_at: firstAt !== null ? formatLocalIso(new Date(firstAt)) : "",
    last_at: lastAt !== null ? formatLocalIso(new Date(lastAt)) : "",
    turns,
    max_turn_sec: maxTurnSec,
    max_turn_date: maxTurnDate,
    total_steps: totalSteps,
    total_tools: totalTools,
    hourly_buckets: hourlyBuckets,
    tool_daily: toolDaily,
    skills,
  };
}

function invokeGit(targetRepo, gitArgs) {
  try {
    const stdout = execFileSync("git", ["-C", targetRepo, ...gitArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { exitCode: 0, output: String(stdout || "").trim() };
  } catch (err) {
    const out = [err.stdout, err.stderr, err.message]
      .filter(Boolean)
      .map((s) => String(s).trim())
      .join("\n")
      .trim();
    return {
      exitCode: typeof err.status === "number" ? err.status : 1,
      output: out,
    };
  }
}

function getGitTopLevel(dirPath) {
  const res = invokeGit(dirPath, ["rev-parse", "--show-toplevel"]);
  if (res.exitCode === 0 && res.output) {
    return path.resolve(res.output);
  }
  return null;
}

function getGitBranchName(targetRepo) {
  const res = invokeGit(targetRepo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (res.exitCode === 0 && res.output && res.output !== "HEAD") {
    return res.output;
  }
  return "main";
}

function abortRebaseIfActive(targetRepo) {
  if (
    fs.existsSync(path.join(targetRepo, ".git", "rebase-merge")) ||
    fs.existsSync(path.join(targetRepo, ".git", "rebase-apply"))
  ) {
    invokeGit(targetRepo, ["rebase", "--abort"]);
  }
}

function syncGitPull(dataDir) {
  const msgs = [];
  const checkGit = invokeGit(dataDir, ["--version"]);
  if (checkGit.exitCode !== 0) {
    msgs.push("[Git 同步] 未检测到 git 命令，已跳过跨设备同步。");
    return { ready: false, repoRoot: null, messages: msgs };
  }

  const targetRepo = getGitTopLevel(dataDir);
  if (!targetRepo) {
    msgs.push("[Git 同步] 数据目录尚未初始化 Git 仓库，当前仅本地归档。");
    return { ready: false, repoRoot: null, messages: msgs };
  }

  const remoteRes = invokeGit(targetRepo, ["remote", "get-url", "origin"]);
  if (remoteRes.exitCode !== 0 || !remoteRes.output) {
    msgs.push("[Git 同步] 数据目录尚未绑定远程仓库 origin，当前仅本地归档。");
    return { ready: false, repoRoot: null, messages: msgs };
  }

  if (RX_PUBLIC_OSS_REPO.test(remoteRes.output.trim())) {
    msgs.push(
      "[Git 同步] 检测到当前 origin 为公开开源代码仓库，为保护隐私已自动跳过推送；如需多机同步，请在 config.json 将 dataDir 指向你的私有数据仓库。"
    );
    return { ready: false, repoRoot: null, messages: msgs };
  }

  const upRes = invokeGit(targetRepo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upRes.exitCode === 0) {
    const pullRes = invokeGit(targetRepo, ["pull", "--rebase", "--autostash"]);
    if (pullRes.exitCode !== 0) {
      abortRebaseIfActive(targetRepo);
      msgs.push(`[Git 同步] 拉取失败，已降级为本地模式: ${pullRes.output}`);
    } else {
      msgs.push("[Git 同步] 已从私有远端仓库拉取最新多设备归档。");
    }
  } else {
    const branch = getGitBranchName(targetRepo);
    const lsRes = invokeGit(targetRepo, ["ls-remote", "--heads", "origin", branch]);
    if (lsRes.exitCode === 0 && lsRes.output) {
      const pullRes = invokeGit(targetRepo, ["pull", "--rebase", "--autostash", "origin", branch]);
      if (pullRes.exitCode === 0) {
        invokeGit(targetRepo, ["branch", `--set-upstream-to=origin/${branch}`, branch]);
        msgs.push("[Git 同步] 已关联私有远端分支并拉取多设备归档。");
      } else {
        abortRebaseIfActive(targetRepo);
        msgs.push(`[Git 同步] 首次拉取远端失败，已降级为本地模式: ${pullRes.output}`);
      }
    }
  }

  return { ready: true, repoRoot: targetRepo, messages: msgs };
}

function syncGitPush(targetRepo, archivePath, machineName, onRebuildBundle) {
  const fullRepo = path.resolve(targetRepo);
  const fullArchive = path.resolve(archivePath);
  let relArchive = path.relative(fullRepo, fullArchive).replace(/\\/g, "/");
  if (!relArchive || relArchive.startsWith("..")) {
    console.log(`[Git 同步] 归档文件不在数据仓库目录内，已跳过提交: ${fullArchive}`);
    return;
  }

  let committed = false;
  const stRes = invokeGit(targetRepo, ["status", "--porcelain", "--", relArchive]);
  if (stRes.exitCode === 0 && stRes.output) {
    const addRes = invokeGit(targetRepo, ["add", "--", relArchive]);
    if (addRes.exitCode !== 0) {
      console.log(`[Git 同步] 暂存本机归档失败: ${addRes.output}`);
      return;
    }

    const nameRes = invokeGit(targetRepo, ["config", "user.name"]);
    const emailRes = invokeGit(targetRepo, ["config", "user.email"]);
    const commitArgs = [];
    if (!nameRes.output) commitArgs.push("-c", `user.name=${machineName}`);
    if (!emailRes.output) commitArgs.push("-c", `user.email=${machineName}@local.antigravity`);
    commitArgs.push(
      "commit",
      "--only",
      "-m",
      `sync: ${machineName} ${formatGitCommitStamp(new Date())}`,
      "--",
      relArchive
    );

    const cRes = invokeGit(targetRepo, commitArgs);
    if (cRes.exitCode !== 0) {
      console.log(`[Git 同步] 提交本机归档失败: ${cRes.output}`);
      return;
    }
    committed = true;
  }

  const upRes = invokeGit(targetRepo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const hasUpstream = upRes.exitCode === 0;
  let needsPush = committed;
  if (!hasUpstream) {
    needsPush = true;
  } else if (!needsPush) {
    const aheadRes = invokeGit(targetRepo, ["rev-list", "--count", "@{u}..HEAD"]);
    if (aheadRes.exitCode === 0 && Number(aheadRes.output) > 0) {
      needsPush = true;
    }
  }

  if (!needsPush) {
    console.log("[Git 同步] 本机与私有远端仓库均已是最新状态。");
    return;
  }

  const branch = getGitBranchName(targetRepo);
  const pushArgs = hasUpstream ? ["push"] : ["push", "-u", "origin", branch];
  let pushRes = invokeGit(targetRepo, pushArgs);

  if (pushRes.exitCode !== 0) {
    const pullArgs = hasUpstream
      ? ["pull", "--rebase", "--autostash"]
      : ["pull", "--rebase", "--autostash", "origin", branch];
    const retryPull = invokeGit(targetRepo, pullArgs);
    if (retryPull.exitCode === 0) {
      if (typeof onRebuildBundle === "function") onRebuildBundle();
      pushRes = invokeGit(targetRepo, pushArgs);
    } else {
      abortRebaseIfActive(targetRepo);
    }
  }

  if (pushRes.exitCode === 0) {
    console.log(`[Git 同步] 已将 ${relArchive} 推送到私有远程仓库。`);
  } else {
    console.log(`[Git 同步] 本地已保存，远端推送失败（可联网后重试）: ${pushRes.output}`);
  }
}

function buildUsageBundle(dataDir, bundlePath, machineName) {
  const machineList = [];
  let grandIn = 0;
  let grandCache = 0;
  let grandOut = 0;
  let grandTools = 0;
  let grandConvs = 0;

  let files = [];
  if (fs.existsSync(dataDir)) {
    files = fs
      .readdirSync(dataDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json") && !d.name.endsWith(".tmp"))
      .map((d) => d.name)
      .sort();
  }

  for (const fname of files) {
    const fullPath = path.join(dataDir, fname);
    try {
      const rawJson = fs.readFileSync(fullPath, "utf8");
      if (!rawJson.trim()) continue;
      const doc = JSON.parse(rawJson);
      if (!doc || typeof doc !== "object") continue;
      const schemaVer = Number(doc.schema_version) || 0;
      if (schemaVer < 1) continue;
      const mName = doc.machine ? String(doc.machine).trim() : "";
      const convsObj = doc.conversations;
      if (!mName || !convsObj || typeof convsObj !== "object" || Array.isArray(convsObj)) continue;

      const hourlyAgg = {};
      const toolAgg = {};
      const skillAgg = {};
      const convSummaries = [];

      const convKeys = Object.keys(convsObj);
      for (const cKey of convKeys) {
        const conv = convsObj[cKey];
        if (!conv || typeof conv !== "object") continue;

        const cSource = conv.source ? String(conv.source) : "desktop";
        const cScene = conv.scene ? String(conv.scene) : cSource === "cli" ? "cli" : "chat";
        const cId = conv.conv_id ? String(conv.conv_id) : String(cKey);
        const cTitle = conv.title ? String(conv.title) : cId.slice(0, Math.min(8, cId.length));
        const cPrompt = conv.first_prompt ? String(conv.first_prompt) : "";
        const cPlan = Boolean(conv.plan_execute);
        const cFirstAt = conv.first_at ? String(conv.first_at) : "";
        const cLastAt = conv.last_at ? String(conv.last_at) : "";
        const cTurns = Number(conv.turns) || 0;
        const cMaxSec = Number(conv.max_turn_sec) || 0;
        const cMaxDate = conv.max_turn_date ? String(conv.max_turn_date) : "";

        let cSteps = 0;
        let cIn = 0;
        let cCache = 0;
        let cOut = 0;
        let cToolCount = 0;
        const cModelMap = {};

        const bucketObj =
          conv.hourly_buckets && typeof conv.hourly_buckets === "object"
            ? conv.hourly_buckets
            : conv.buckets && typeof conv.buckets === "object"
            ? conv.buckets
            : null;

        if (bucketObj) {
          for (const bKey of Object.keys(bucketObj)) {
            const b = bucketObj[bKey];
            if (!b || typeof b !== "object") continue;
            const bDate = b.date ? String(b.date).trim() : "";
            if (!bDate) continue;
            const bHour = b.hour !== undefined && b.hour !== null ? Number(b.hour) : 12;
            const bModel = b.model ? String(b.model) : "unknown";

            const bSteps = Number(b.steps) || 0;
            const bIn = Number(b.input) || 0;
            const bCache = Number(b.cache_read) || 0;
            const bOut = Number(b.output) || 0;

            cSteps += bSteps;
            cIn += bIn;
            cCache += bCache;
            cOut += bOut;

            grandIn += bIn;
            grandCache += bCache;
            grandOut += bOut;

            if (!cModelMap[bModel]) {
              cModelMap[bModel] = { model: bModel, steps: 0, input: 0, cache_read: 0, output: 0 };
            }
            cModelMap[bModel].steps += bSteps;
            cModelMap[bModel].input += bIn;
            cModelMap[bModel].cache_read += bCache;
            cModelMap[bModel].output += bOut;

            const hKey = `${bDate}|${pad2(bHour)}|${cSource}|${cScene}|${bModel}`;
            if (!hourlyAgg[hKey]) {
              hourlyAgg[hKey] = {
                date: bDate,
                hour: bHour,
                source: cSource,
                scene: cScene,
                model: bModel,
                steps: 0,
                input: 0,
                cache_read: 0,
                output: 0,
              };
            }
            hourlyAgg[hKey].steps += bSteps;
            hourlyAgg[hKey].input += bIn;
            hourlyAgg[hKey].cache_read += bCache;
            hourlyAgg[hKey].output += bOut;
          }
        }

        if (conv.tool_daily && typeof conv.tool_daily === "object") {
          for (const tdKey of Object.keys(conv.tool_daily)) {
            const cnt = Number(conv.tool_daily[tdKey]) || 0;
            if (cnt <= 0) continue;
            const sep = tdKey.indexOf("|");
            if (sep <= 0) continue;
            const tDate = tdKey.slice(0, sep);
            const tName = tdKey.slice(sep + 1);
            cToolCount += cnt;
            grandTools += cnt;

            const taKey = `${tDate}|${cSource}|${cScene}|${tName}`;
            if (!toolAgg[taKey]) {
              toolAgg[taKey] = {
                date: tDate,
                source: cSource,
                scene: cScene,
                tool: tName,
                count: 0,
              };
            }
            toolAgg[taKey].count += cnt;
          }
        }

        if (conv.skills && typeof conv.skills === "object") {
          for (const sName of Object.keys(conv.skills)) {
            const sCnt = Number(conv.skills[sName]) || 0;
            if (sCnt <= 0) continue;
            const saKey = `${cSource}|${cScene}|${sName}`;
            if (!skillAgg[saKey]) {
              skillAgg[saKey] = {
                source: cSource,
                scene: cScene,
                skill: sName,
                count: 0,
              };
            }
            skillAgg[saKey].count += sCnt;
          }
        }

        const cModelList = Object.keys(cModelMap)
          .sort()
          .map((mk) => cModelMap[mk]);

        convSummaries.push({
          conv_id: cId,
          title: cTitle,
          first_prompt: cPrompt,
          source: cSource,
          scene: cScene,
          plan_execute: cPlan,
          first_at: cFirstAt,
          last_at: cLastAt,
          turns: cTurns,
          max_turn_sec: cMaxSec,
          max_turn_date: cMaxDate,
          steps: cSteps,
          input: cIn,
          cache_read: cCache,
          output: cOut,
          tool_count: cToolCount,
          models: cModelList,
        });
      }

      const hourlyList = Object.keys(hourlyAgg)
        .sort()
        .map((k) => hourlyAgg[k]);
      const toolList = Object.keys(toolAgg)
        .sort()
        .map((k) => toolAgg[k]);
      const skillList = Object.keys(skillAgg)
        .sort()
        .map((k) => skillAgg[k]);

      machineList.push({
        machine: mName,
        updated_at: doc.updated_at ? String(doc.updated_at) : "",
        conversation_count: convKeys.length,
        hourly_records: hourlyList,
        tool_records: toolList,
        skill_totals: skillList,
        conversations: convSummaries,
      });
      grandConvs += convKeys.length;
    } catch (err) {
      console.warn(`跳过无效归档文件 ${fname}: ${err.message}`);
    }
  }

  const bundleObj = {
    schema_version: 2,
    generated_at: formatLocalIso(new Date()),
    current_machine: machineName,
    machines: machineList,
  };

  writeUtf8Atomic(bundlePath, `window.AGY_USAGE_DATA = ${JSON.stringify(bundleObj)};\n`);

  return {
    machineNames: machineList.map((m) => m.machine),
    machineCount: machineList.length,
    grandConvs,
    grandTools,
    grandIn,
    grandCache,
    grandOut,
    grandFull: grandIn + grandCache + grandOut,
    grandNet: grandIn + grandOut,
    bundlePath,
  };
}

async function main() {
  const repoRoot = __dirname;
  const cli = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(repoRoot);

  const rawDataDir = cli.dataDir || (cfg.dataDir ? String(cfg.dataDir).trim() : "");
  const dataDir = rawDataDir
    ? path.resolve(repoRoot, rawDataDir)
    : path.join(repoRoot, "data");
  const bundleOut = cli.bundleOut
    ? path.resolve(repoRoot, cli.bundleOut)
    : path.join(repoRoot, "data", "usage_bundle.js");
  const machineName = sanitizeMachineName(
    cli.machineName || cfg.machineName || process.env.COMPUTERNAME || os.hostname()
  );
  const gitSync =
    cli.gitSync !== null ? cli.gitSync : Boolean(cfg.gitSync === true);

  let gitSyncInfo = { ready: false, repoRoot: null, messages: [] };
  if (gitSync) {
    fs.mkdirSync(dataDir, { recursive: true });
    gitSyncInfo = syncGitPull(dataDir);
    for (const msg of gitSyncInfo.messages) {
      console.log(msg);
    }
  }

  fs.mkdirSync(dataDir, { recursive: true });

  const scanSpecs = [];
  if (cli.sourceRoots && cli.sourceRoots.length > 0) {
    for (const rawRoot of cli.sourceRoots) {
      const eq = rawRoot.indexOf("=");
      let sTag = "";
      let sPath = "";
      if (eq > 0) {
        sTag = rawRoot.slice(0, eq).trim();
        sPath = rawRoot.slice(eq + 1).trim();
      } else {
        sPath = rawRoot.trim();
        sTag = sPath.includes("antigravity-cli") ? "cli" : "desktop";
      }
      const annDir = path.join(path.dirname(sPath), "annotations");
      scanSpecs.push({ source: sTag, path: sPath, annotationsDir: annDir });
    }
  } else {
    const home = os.homedir();
    const desktopBase = path.join(home, ".gemini", "antigravity");
    const cliBase = path.join(home, ".gemini", "antigravity-cli");
    scanSpecs.push({
      source: "desktop",
      path: path.join(desktopBase, "brain"),
      annotationsDir: path.join(desktopBase, "annotations"),
    });
    scanSpecs.push({
      source: "cli",
      path: path.join(cliBase, "brain"),
      annotationsDir: path.join(cliBase, "annotations"),
    });
  }

  const archivePath = path.join(dataDir, `${machineName}.json`);
  const conversations = {};
  if (fs.existsSync(archivePath)) {
    try {
      const rawArchive = fs.readFileSync(archivePath, "utf8");
      if (rawArchive.trim()) {
        const loaded = JSON.parse(rawArchive);
        if (loaded && loaded.conversations && typeof loaded.conversations === "object") {
          for (const k of Object.keys(loaded.conversations)) {
            conversations[k] = loaded.conversations[k];
          }
        }
      }
    } catch (err) {
      console.warn(`[归档警告] 读取历史归档失败，将重建索引: ${err.message}`);
    }
  }

  let scannedFiles = 0;
  let newCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let protectedCount = 0;
  const seenKeys = new Set();

  for (const spec of scanSpecs) {
    if (!fs.existsSync(spec.path)) continue;
    let convDirs = [];
    try {
      convDirs = fs.readdirSync(spec.path, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }

    for (const dir of convDirs) {
      const tPath = path.join(spec.path, dir.name, ".system_generated", "logs", "transcript.jsonl");
      if (!fs.existsSync(tPath)) continue;

      let fileStat;
      try {
        fileStat = fs.statSync(tPath);
      } catch {
        continue;
      }

      scannedFiles++;
      const convId = dir.name;
      const key = `${spec.source}:${convId}`;
      seenKeys.add(key);

      const annInfo = readAnnotationInfo(spec.annotationsDir, convId);
      const fileSize = fileStat.size;
      const lastWriteUtc = fileStat.mtime.toISOString();
      const annWriteUtc = annInfo.annWriteUtc || "";

      const existing = conversations[key];
      if (existing && typeof existing === "object") {
        const hasV2 = existing.hourly_buckets && existing.tool_daily;
        if (
          hasV2 &&
          Number(existing.file_size) === fileSize &&
          String(existing.last_write_utc || "") === lastWriteUtc &&
          String(existing.ann_write_utc || "") === annWriteUtc
        ) {
          skippedCount++;
          continue;
        }
      }

      const parsed = await parseTranscriptFile(tPath, fileStat, spec.source, convId, annInfo);

      if (existing && typeof existing === "object") {
        const exSteps = Number(existing.total_steps) || 0;
        if (parsed.total_steps < exSteps) {
          protectedCount++;
          continue;
        }
        updatedCount++;
      } else {
        newCount++;
      }

      conversations[key] = parsed;
    }
  }

  let archivedOnlyCount = 0;
  for (const k of Object.keys(conversations)) {
    if (!seenKeys.has(k)) archivedOnlyCount++;
  }

  const archiveObj = {
    schema_version: 2,
    machine: machineName,
    updated_at: formatLocalIso(new Date()),
    conversations,
  };
  writeUtf8Atomic(archivePath, JSON.stringify(archiveObj));

  let bundleInfo = buildUsageBundle(dataDir, bundleOut, machineName);

  if (gitSync && gitSyncInfo.ready && gitSyncInfo.repoRoot) {
    syncGitPush(gitSyncInfo.repoRoot, archivePath, machineName, () => {
      bundleInfo = buildUsageBundle(dataDir, bundleOut, machineName);
    });
  }

  console.log("=== Antigravity Token 增量归档完成 ===");
  console.log(`当前设备: ${machineName}`);
  console.log(
    `扫描日志: ${scannedFiles} 个 | 新增: ${newCount} | 更新: ${updatedCount} | 跳过未变: ${skippedCount} | 仅留存于归档: ${archivedOnlyCount} | 防截断保护: ${protectedCount}`
  );
  console.log(
    `已合并设备 (${bundleInfo.machineCount} 台): ${bundleInfo.machineNames.join(", ")} | 归档会话总数: ${bundleInfo.grandConvs} | 工具调用总计: ${bundleInfo.grandTools}`
  );
  console.log(
    `全量合计 (含缓存): ${bundleInfo.grandFull.toLocaleString("en-US")} Token (新增输入 ${bundleInfo.grandIn.toLocaleString("en-US")} + 缓存命中 ${bundleInfo.grandCache.toLocaleString("en-US")} + 输出 ${bundleInfo.grandOut.toLocaleString("en-US")})`
  );
  console.log(`净新增合计 (不含缓存): ${bundleInfo.grandNet.toLocaleString("en-US")} Token`);
  console.log(`归档文件: ${archivePath}`);
  console.log(`看板数据: ${bundleInfo.bundlePath}`);
}

main().catch((err) => {
  console.error("[错误] 归档同步失败:", err);
  process.exit(1);
});
