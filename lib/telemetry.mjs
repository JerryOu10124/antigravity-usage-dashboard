import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export const DEFAULT_FX_RATE = 6.7;
export const RETENTION_MS = 90 * 86400000;
const DAY_MS = 86400000;
const MAX_PROTOBUF_KEY = 0xffffffffn;
const MAX_PROTOBUF_FIELD = 536870911;

export function formatLocalYmdFromMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return "";
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

export function sanitizeErrorText(raw = "", maxLen = 220) {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s
    .replace(/(Authorization\s*:\s*)(?:Bearer|Basic)\s+[^\s"',;)}\]]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /\b(api[_-]?key|access_token|refresh_token|id_token|token|signature|sig|secret|password|x-goog-api-key)\s*([:=])\s*[^\s&"',;)}\]]+/gi,
      "$1$2[REDACTED]"
    )
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/https?:\/\/[^\s"'<>)]+/gi, (url) => {
      const qIdx = url.search(/[?#]/);
      return qIdx >= 0 ? `${url.slice(0, qIdx)}?[redacted]` : url;
    });
  return s.slice(0, maxLen);
}

let cachedDatabaseSync;
function getDatabaseSync() {
  if (cachedDatabaseSync !== undefined) return cachedDatabaseSync;
  let cls = null;
  try {
    ({ DatabaseSync: cls } = process.getBuiltinModule?.("node:sqlite") || {});
  } catch {
    cls = null;
  }
  if (!cls) {
    try {
      const req =
        typeof import.meta?.url === "string" && import.meta.url.startsWith("file:")
          ? createRequire(import.meta.url)
          : typeof require === "function"
          ? require
          : null;
      if (req) ({ DatabaseSync: cls } = req("node:sqlite") || {});
    } catch {
      cls = null;
    }
  }
  cachedDatabaseSync = typeof cls === "function" ? cls : null;
  return cachedDatabaseSync;
}

/** Decode raw protobuf wire fields into a Map<fieldNumber, Array<number|Buffer>>. */
export function decodeProtobufFields(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const result = new Map();
  let offset = 0;
  const readVarint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n && offset < data.length; shift += 7n) {
      const byte = data[offset++];
      if (shift === 63n && byte > 1) {
        throw new Error("Protobuf varint overflow");
      }
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid protobuf varint");
  };
  while (offset < data.length) {
    const keyBig = readVarint();
    if (keyBig <= 0n || keyBig > MAX_PROTOBUF_KEY) {
      throw new Error("Invalid protobuf key");
    }
    const fieldNumber = Number(keyBig >> 3n);
    const wire = Number(keyBig & 7n);
    if (fieldNumber < 1 || fieldNumber > MAX_PROTOBUF_FIELD) {
      throw new Error("Invalid protobuf field");
    }
    let value;
    if (wire === 0) {
      value = Number(BigInt.asIntN(64, readVarint()));
    } else if (wire === 1 || wire === 2 || wire === 5) {
      let length;
      if (wire === 2) {
        const lenBig = readVarint();
        if (lenBig < 0n || lenBig > BigInt(data.length - offset)) {
          throw new Error("Truncated protobuf");
        }
        length = Number(lenBig);
      } else {
        length = wire === 1 ? 8 : 4;
        if (offset + length > data.length) {
          throw new Error("Truncated protobuf");
        }
      }
      value = data.subarray(offset, offset + length);
      offset += length;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    if (!result.has(fieldNumber)) result.set(fieldNumber, []);
    result.get(fieldNumber).push(value);
  }
  return result;
}

export const pbFirst = (map, num, fallback = null) => map.get(num)?.[0] ?? fallback;
export const pbNested = (map, num) => decodeProtobufFields(pbFirst(map, num));
export const pbString = (map, num) => Buffer.from(pbFirst(map, num, [])).toString("utf8");
export function pbMilliseconds(bytes) {
  if (!bytes) return null;
  const map = decodeProtobufFields(bytes);
  return pbFirst(map, 1, 0) * 1000 + pbFirst(map, 2, 0) / 1e6;
}

/** Decode a single gen_metadata protobuf blob (verified against Antigravity 2.31+ descriptors). */
export function decodeGeneration(bytes) {
  const generation = decodeProtobufFields(bytes);
  const chat = pbNested(generation, 1);
  const plannerConfig = pbNested(generation, 3);
  const planExecute = pbNested(plannerConfig, 60);
  const usage = pbNested(chat, 4);
  const start = pbNested(chat, 9);
  const context = pbNested(start, 10);
  const breakdown = pbNested(context, 3);
  const modelEnum = pbFirst(chat, 3, 0) || null;
  const executionModelEnum = pbFirst(planExecute, 1, 0) || null;

  const stepIndices = (generation.get(2) || []).flatMap((value) => {
    if (typeof value === "number") return [value];
    const indices = [];
    let index = 0n;
    let shift = 0n;
    for (const byte of value) {
      if (shift > 63n || (shift === 63n && byte > 1)) {
        throw new Error("Invalid packed stepIndices varint");
      }
      index |= BigInt(byte & 127) << shift;
      if (byte & 128) {
        shift += 7n;
      } else {
        if (index > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("Overflow packed stepIndex");
        }
        indices.push(Number(index));
        index = 0n;
        shift = 0n;
      }
    }
    if (shift !== 0n) {
      throw new Error("Truncated packed stepIndices varint");
    }
    return indices;
  });

  let requestId = "";
  for (const entryBytes of chat.get(20) || []) {
    const entry = decodeProtobufFields(entryBytes);
    if (pbString(entry, 1) === "request_id") {
      requestId = pbString(entry, 2);
      break;
    }
  }

  const maxTokens = pbFirst(context, 4, 0);
  let contextInfo = null;
  if (maxTokens > 0) {
    const rawCats = (breakdown.get(1) || []).map((groupBytes) => {
      const group = decodeProtobufFields(groupBytes);
      const children = (group.get(5) || []).map((childBytes) => {
        const child = decodeProtobufFields(childBytes);
        return { label: pbString(child, 1), tokens: pbFirst(child, 3, 0) };
      });
      return { label: pbString(group, 1), tokens: pbFirst(group, 4, 0), children };
    });
    const hasTopSkills = rawCats.some((g) => /^skills$/i.test(g.label));
    const categories = rawCats
      .flatMap((g) => {
        const skillsChild =
          !hasTopSkills &&
          g.label === "System Prompt" &&
          g.children?.find((c) => c.label === "skills" && c.tokens > 0);
        if (skillsChild) {
          return [
            { label: g.label, tokens: Math.max(0, g.tokens - skillsChild.tokens) },
            { label: "Skills", tokens: skillsChild.tokens },
          ];
        }
        return [{ label: g.label, tokens: g.tokens }];
      })
      .filter((g) => g.label && Number.isFinite(g.tokens) && g.tokens > 0);
    contextInfo = {
      usedTokens: pbFirst(context, 1, 0),
      maxTokens,
      categories,
    };
  }

  return {
    executionId: pbString(generation, 4),
    error: pbString(generation, 5),
    stepIndices,
    modelName: pbString(chat, 21) || pbString(chat, 19),
    modelEnum,
    executionModelEnum,
    role: executionModelEnum ? (modelEnum === executionModelEnum ? "execution" : "planner") : "",
    providerInputTokens:
      usage.has(2) || usage.has(5) ? pbFirst(usage, 2, 0) + pbFirst(usage, 5, 0) : null,
    inputTokens: pbFirst(usage, 2, 0),
    cacheReadTokens: pbFirst(usage, 5, 0),
    outputTokens: pbFirst(usage, 3, 0),
    thinkingTokens: pbFirst(usage, 9, 0),
    responseTokens: pbFirst(usage, 10, 0),
    requestId,
    retries: pbFirst(chat, 14, 0),
    retryErrors: (chat.get(17) || [])
      .map((b) => pbString(decodeProtobufFields(b), 3))
      .filter(Boolean),
    ttftMs: pbMilliseconds(pbFirst(chat, 11)),
    streamingMs: pbMilliseconds(pbFirst(chat, 12)),
    context: contextInfo,
  };
}

/** Return combined mtime+size stamp for a conversation .db and its -wal file. */
export function getDbStamp(baseDir, convId) {
  if (!baseDir || !convId) return "";
  const dbPath = path.join(baseDir, "conversations", `${convId}.db`);
  if (!fs.existsSync(dbPath)) return "";
  return [dbPath, `${dbPath}-wal`]
    .map((p) => {
      try {
        const s = fs.statSync(p);
        return `${Math.trunc(s.mtimeMs)}:${s.size}`;
      } catch {
        return "";
      }
    })
    .join("|");
}

/** Read conversation SQLite DB in strict read-only mode; returns null if unavailable. */
export function readConversationDb(baseDir, convId) {
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync || !baseDir || !convId) return null;
  const dbPath = path.join(baseDir, "conversations", `${convId}.db`);
  if (!fs.existsSync(dbPath)) return null;
  let db;
  let inTx = false;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
    db.exec("BEGIN DEFERRED;");
    inTx = true;
    const generations = [];
    for (const row of db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").iterate()) {
      try {
        generations.push({ index: row.idx, ...decodeGeneration(row.data) });
      } catch {
        // Ignore partial/incomplete protobuf row.
      }
    }
    const times = new Map();
    const checkpointSteps = [];
    const cols = db.prepare("PRAGMA table_info(steps)").all().map((c) => c.name);
    const hasStepType = cols.includes("step_type");
    const stepQuery = hasStepType
      ? "SELECT idx, step_type, metadata FROM steps ORDER BY idx"
      : "SELECT idx, metadata FROM steps ORDER BY idx";
    for (const row of db.prepare(stepQuery).iterate()) {
      if (hasStepType && row.step_type === 23) checkpointSteps.push(row.idx);
      try {
        const f = decodeProtobufFields(row.metadata);
        times.set(row.idx, {
          createdMs: pbMilliseconds(pbFirst(f, 1)),
          viewableMs: pbMilliseconds(pbFirst(f, 6)),
          finishedMs: pbMilliseconds(pbFirst(f, 7)),
          completedMs: pbMilliseconds(pbFirst(f, 8)),
          startedMs: pbMilliseconds(pbFirst(f, 32)),
        });
      } catch {
        // Ignore incomplete step metadata.
      }
    }
    db.exec("COMMIT;");
    inTx = false;
    return { generations, times, checkpointSteps };
  } catch {
    if (inTx) {
      try {
        db?.exec("ROLLBACK;");
      } catch {}
    }
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function isBufferedTailFlush(outputTokens, streamingMs, durationMs) {
  return Boolean(
    durationMs > 0 &&
      streamingMs != null &&
      streamingMs < 1500 &&
      streamingMs / durationMs < 0.06 &&
      outputTokens >= 500
  );
}

/** Calculate streaming vs whole-request decode TPS, preventing buffered-tail spikes. */
export function resolveRequestSpeed({ outputTokens, ttftMs, streamingMs, durationMs } = {}) {
  const outTok = Number.isFinite(outputTokens) ? outputTokens : 0;
  const resolvedDurationMs =
    durationMs != null
      ? durationMs
      : ttftMs != null && streamingMs != null
      ? ttftMs + streamingMs
      : null;
  const bufferedTail = isBufferedTailFlush(outTok, streamingMs, resolvedDurationMs);
  const isStreamed = Boolean(
    streamingMs != null && streamingMs >= 500 && outTok >= 20 && !bufferedTail
  );
  const tpsDurationMs = isStreamed ? streamingMs : resolvedDurationMs;
  const tps =
    tpsDurationMs != null && tpsDurationMs > 0
      ? Number(((outTok * 1000) / tpsDurationMs).toFixed(1))
      : null;
  const wholeTps =
    resolvedDurationMs != null && resolvedDurationMs > 0
      ? Number(((outTok * 1000) / resolvedDurationMs).toFixed(1))
      : null;
  const tpsMode = tps == null ? null : isStreamed ? "stream" : "whole";
  return { durationMs: resolvedDurationMs, tpsDurationMs, tps, wholeTps, tpsMode };
}

/** Robust peak tok/s using sustained streams and a modified Tukey upper fence. */
export function robustPeakTps(
  rows,
  { minStreamMs = 3000, minOutputTokens = 100, iqrFactor = 1.5, minSamplesForFence = 5 } = {}
) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const valid = [];
  for (const r of rows) {
    if (!r) continue;
    const outTok = Number(r.out ?? r.outputTokens);
    if (!(outTok > 0)) continue;
    const ttft = r.ttft ?? r.ttftMs;
    const st = r.st ?? r.streamingMs;
    const rawDur = r.dur ?? r.durationMs;
    const fullDur =
      Number.isFinite(rawDur) && rawDur > 0
        ? rawDur
        : ttft != null && st != null && ttft + st > 0
        ? ttft + st
        : null;
    const rawMode = r.tm ?? r.tpsMode;
    const speed = resolveRequestSpeed({
      outputTokens: outTok,
      ttftMs: ttft,
      streamingMs: st,
      durationMs: fullDur,
    });
    const tpsMode =
      rawMode === "whole" || speed.tpsMode === "whole" ? "whole" : speed.tpsMode;
    const explicitWtps = Number(r.wtps);
    const explicitTps = Number(r.tps);
    const tps =
      tpsMode === "whole"
        ? speed.wholeTps ??
          (Number.isFinite(explicitWtps) && explicitWtps > 0
            ? explicitWtps
            : Number.isFinite(explicitTps) && explicitTps > 0
            ? explicitTps
            : null)
        : speed.tps;
    if (!(tps > 0) || !Number.isFinite(tps)) continue;
    valid.push({
      outputTokens: outTok,
      streamingMs: st,
      tpsMode,
      tps,
      wholeTps: speed.wholeTps,
    });
  }
  if (!valid.length) return null;
  const sustained = valid.filter(
    (r) =>
      r.streamingMs != null &&
      r.streamingMs >= minStreamMs &&
      r.outputTokens >= minOutputTokens &&
      r.tpsMode !== "whole"
  );
  const pool = sustained.length ? sustained : valid;
  const maxOf = (list) => {
    let peak = -Infinity;
    for (const item of list) if (item.tps > peak) peak = item.tps;
    return Number.isFinite(peak) ? peak : null;
  };
  if (pool.length < minSamplesForFence) return maxOf(pool);
  const sorted = pool.map((r) => r.tps).sort((a, b) => a - b);
  const quantile = (p) => {
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  const q1 = quantile(0.25);
  const q3 = quantile(0.75);
  const fence = Math.max(q3 + iqrFactor * (q3 - q1), q3 * 1.25);
  const accepted = pool.filter(
    (r) => r.tps <= fence || (r.wholeTps != null && r.wholeTps >= r.tps * 0.5)
  );
  return accepted.length ? maxOf(accepted) : sorted.at(-1);
}

export function classifyRetryReason(raw = "") {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/unexpected\s+eof|\beof\b|connection\s+reset|broken\s+pipe/i.test(text)) {
    return { code: "eof", label: "网络中断 (EOF)" };
  }
  if (/context\s+deadline\s+exceeded|timeout|timed\s*out/i.test(text)) {
    return { code: "timeout", label: "请求超时" };
  }
  if (/\b429\b|resource_exhausted|rate\s*limit|too\s+many\s+requests|quota/i.test(text)) {
    return { code: "rate-limit", label: "限流 / 配额 (429)" };
  }
  if (/\b503\b|\b502\b|\b504\b|unavailable|overloaded|capacity|high\s+demand/i.test(text)) {
    return { code: "unavailable", label: "服务繁忙 (5xx)" };
  }
  if (/\b403\b|region|location|country|not\s+available\s+in\s+your|unsupported/i.test(text)) {
    return { code: "region", label: "地区或权限受限" };
  }
  if (/econnrefused|proxy|tls|handshake|dns|no\s+such\s+host|network/i.test(text)) {
    return { code: "connection", label: "代理 / 网络异常" };
  }
  return { code: "other", label: text.slice(0, 48) };
}

export function normalizeModelKey(label = "") {
  const raw = String(label || "").trim().toLowerCase();
  if (!raw || raw === "unknown") return "unknown";
  let s = raw
    .replace(/\((minimal|low|medium|high|xhigh|extra\s+high|max|thinking)\)/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-(xhigh|high|medium|low|minimal|max|extra-high|tiered)$/g, "")
    .replace(/-(xhigh|high|medium|low|minimal|max|extra-high|tiered)$/g, "");
  s = s.replace(/(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/, "$1-$2");
  return s || "unknown";
}

/** Extract compact, prompt-free request events from decoded SQLite data. */
export function extractRequestEvents(dbData, convId) {
  const generations = (dbData?.generations || []).filter(
    (g) => g.modelName || g.error || g.outputTokens
  );
  const knownExecutionEnum =
    generations.find((g) => g.executionModelEnum)?.executionModelEnum || null;
  const events = [];
  for (const g of generations) {
    const times = g.stepIndices.map((idx) => dbData.times.get(idx)).filter(Boolean);
    const created = times.map((t) => t.createdMs).filter(Number.isFinite);
    const fallbackTimes = created.length
      ? created
      : times
          .flatMap((t) => [t.startedMs, t.viewableMs, t.finishedMs, t.completedMs])
          .filter(Number.isFinite);
    const ts = fallbackTimes.length ? Math.round(Math.min(...fallbackTimes)) : null;
    const role =
      g.role ||
      (knownExecutionEnum && g.modelEnum
        ? g.modelEnum === knownExecutionEnum
          ? "execution"
          : "planner"
        : "");
    const { durationMs, tps, wholeTps, tpsMode } = resolveRequestSpeed({
      outputTokens: g.outputTokens,
      ttftMs: g.ttftMs,
      streamingMs: g.streamingMs,
    });
    const retryErrors = (g.retryErrors || [])
      .map((s) => sanitizeErrorText(s, 180))
      .filter(Boolean)
      .slice(0, 3);
    const errText = sanitizeErrorText(g.error || "", 220);
    const reason = classifyRetryReason(errText || retryErrors.at(-1) || "");
    events.push({
      id: g.requestId || `${g.executionId}:${g.index}:${ts ?? 0}:${g.modelName}`,
      cid: convId,
      ts,
      d: Number.isFinite(ts) && ts > 0 ? formatLocalYmdFromMs(ts) : "",
      m: g.modelName || "unknown",
      r: role,
      in: g.inputTokens || 0,
      ca: g.cacheReadTokens || 0,
      out: g.outputTokens || 0,
      th: g.thinkingTokens || 0,
      resp: g.responseTokens || 0,
      ttft: Number.isFinite(g.ttftMs) ? Math.round(g.ttftMs) : null,
      st: Number.isFinite(g.streamingMs) ? Math.round(g.streamingMs) : null,
      dur: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      tps,
      wtps: wholeTps,
      tm: tpsMode,
      ok: errText ? 0 : 1,
      err: errText,
      err_code: reason?.code || "",
      ret: g.retries || 0,
      rerr: retryErrors,
    });
  }
  return events;
}

export function isRequestWithinRetention(req, cutoff) {
  return Boolean(
    req &&
      typeof req === "object" &&
      req.ts != null &&
      Number.isFinite(Number(req.ts)) &&
      Number(req.ts) > 0 &&
      Number(req.ts) >= cutoff
  );
}

function normalizeArchivedRequest(req) {
  const ts = Number(req.ts);
  const err = sanitizeErrorText(req.err || "", 220);
  const rerr = Array.isArray(req.rerr)
    ? req.rerr
        .map((s) => sanitizeErrorText(s, 180))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const d =
    typeof req.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.d)
      ? req.d
      : formatLocalYmdFromMs(ts);
  return { ...req, ts, d, err, rerr };
}

/** Prune expired/timeless requests, backfill local billing day, and sanitize error text. */
export function pruneRequestList(
  list = [],
  { now = Date.now(), retentionMs = RETENTION_MS, maxPerConv = 2000 } = {}
) {
  const cutoff = now - retentionMs;
  const byId = new Map();
  for (const r of list || []) {
    if (!r || typeof r.id !== "string" || !r.id) continue;
    if (!isRequestWithinRetention(r, cutoff)) continue;
    byId.set(r.id, normalizeArchivedRequest(r));
  }
  return [...byId.values()]
    .sort((a, b) => a.ts - b.ts)
    .slice(-maxPerConv);
}

/** Merge incoming request events into archived list by ID (preserves older history). */
export function mergeRequestLists(
  existingList = [],
  incomingList = [],
  { now = Date.now(), retentionMs = RETENTION_MS, maxPerConv = 2000 } = {}
) {
  return pruneRequestList([...(existingList || []), ...(incomingList || [])], {
    now,
    retentionMs,
    maxPerConv,
  });
}

/** Detect short-interval cache clears/drops while excluding cold starts and /compact drops. */
export function annotateCacheAnomalies(
  requests = [],
  {
    maxGapMs = 180000,
    minPrevCache = 4000,
    minPrevHit = 50,
    minCurInput = 4000,
    minMissedInput = 16000,
    minKeepRatio = 0.6,
  } = {}
) {
  const anomalies = new Map();
  if (!Array.isArray(requests) || !requests.length) return anomalies;
  const ordered = requests
    .filter((r) => r && r.cid && Number.isFinite(r.ts) && r.ok !== 0)
    .slice()
    .sort((a, b) => a.ts - b.ts || String(a.id || "").localeCompare(String(b.id || "")));
  const priorHitKeys = new Set();
  const lastByKey = new Map();
  for (const r of ordered) {
    const modelId = normalizeModelKey(r.m);
    const key = `${r.cid}::${modelId}`;
    const curIn = r.in || 0;
    const curCache = r.ca || 0;
    const curTotalIn = curIn + curCache;
    const curHit = curTotalIn > 0 ? Number(((curCache / curTotalIn) * 100).toFixed(1)) : null;
    const prev = lastByKey.get(key);
    let anomalous = false;
    if (prev && curHit != null && curTotalIn >= minCurInput && curTotalIn >= prev.totalIn * minKeepRatio) {
      const gapMs = r.ts - prev.ts;
      if (gapMs >= 0 && gapMs <= maxGapMs) {
        if (prev.cache >= minPrevCache && prev.hit >= minPrevHit) {
          if (curCache === 0) {
            anomalies.set(r.id, {
              kind: "cleared",
              gap: gapMs,
              ph: prev.hit,
              ch: 0,
              pc: prev.cache,
              cc: 0,
            });
            anomalous = true;
          } else if (prev.hit - curHit >= 40 && curHit < 20 && curCache < prev.cache * 0.5) {
            anomalies.set(r.id, {
              kind: "dropped",
              gap: gapMs,
              ph: prev.hit,
              ch: curHit,
              pc: prev.cache,
              cc: curCache,
            });
            anomalous = true;
          }
        } else if (
          curCache === 0 &&
          priorHitKeys.has(key) &&
          (prev.anomalous || prev.totalIn >= minMissedInput)
        ) {
          anomalies.set(r.id, {
            kind: "missed",
            gap: gapMs,
            ph: prev.hit,
            ch: 0,
            pc: prev.cache,
            cc: 0,
          });
          anomalous = true;
        }
      }
    }
    if (curCache > 0) priorHitKeys.add(key);
    if (curTotalIn >= 2000 && curHit != null) {
      lastByKey.set(key, {
        ts: r.ts,
        cache: curCache,
        hit: curHit,
        totalIn: curTotalIn,
        anomalous,
      });
    }
  }
  return anomalies;
}

function aggregateRequestMetrics(list = []) {
  let thinking = 0;
  let response = 0;
  let ttftSum = 0;
  let ttftCount = 0;
  let streamMs = 0;
  let timedOutput = 0;
  let errorCount = 0;
  let retryCount = 0;

  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    thinking += Number(r.th) || 0;
    response += Number(r.resp) || 0;
    if (r.ttft != null && Number.isFinite(Number(r.ttft)) && Number(r.ttft) >= 0) {
      ttftSum += Number(r.ttft);
      ttftCount++;
    }
    const outTok = Number(r.out) || 0;
    const speedDur =
      r.tm === "stream" && r.st > 0 ? r.st : r.dur > 0 ? r.dur : null;
    if (speedDur && outTok > 0) {
      streamMs += speedDur;
      timedOutput += outTok;
    }
    if (r.ok === 0) errorCount++;
    const ret = Math.max(Number(r.ret) || 0, Array.isArray(r.rerr) ? r.rerr.length : 0);
    retryCount += ret;
  }

  return {
    req_count: list.length,
    thinking_tokens: thinking,
    response_tokens: response,
    ttft_sum_ms: ttftSum,
    ttft_count: ttftCount,
    stream_ms: streamMs,
    timed_output: timedOutput,
    peak_tps: robustPeakTps(list),
    error_count: errorCount,
    retry_count: retryCount,
  };
}

/** Refresh request-derived telemetry counters after pruning aged requests. */
export function refreshTelemetryFromRequests(existingTelemetry, requests = []) {
  const base = existingTelemetry && typeof existingTelemetry === "object" ? existingTelemetry : {};
  const list = Array.isArray(requests) ? requests : [];
  return {
    ...aggregateRequestMetrics(list),
    compactions: Number(base.compactions) || 0,
    context: base.context || null,
  };
}

/** Build compact conversation-level telemetry summary including latest context breakdown. */
export function summarizeDbTelemetry(dbData, requests = []) {
  const list = Array.isArray(requests) ? requests : [];
  if (!dbData && list.length === 0) return null;

  let detectedCompactions = 0;
  const lastUsedByModel = new Map();
  let latestContext = null;
  for (const g of dbData?.generations || []) {
    const used =
      Number.isFinite(g.providerInputTokens) && g.providerInputTokens > 0
        ? g.providerInputTokens
        : g.context?.usedTokens || 0;
    const max = g.context?.maxTokens > 0 ? g.context.maxTokens : null;
    if (g.modelName && used > 0) {
      const key = `${g.role || ""}:${normalizeModelKey(g.modelName)}`;
      const prev = lastUsedByModel.get(key);
      if (prev && used < prev * 0.72 && prev - used > 30000) detectedCompactions++;
      lastUsedByModel.set(key, used);
    }
    if (g.context || g.providerInputTokens > 0) {
      latestContext = {
        used,
        max,
        categories: (g.context?.categories || []).map((c) => ({
          label: c.label,
          tokens: c.tokens,
        })),
      };
    }
  }

  const compactions = Math.max(
    dbData?.checkpointSteps?.length || 0,
    detectedCompactions
  );

  return {
    ...aggregateRequestMetrics(list),
    compactions,
    context: latestContext,
  };
}

// --- On-demand FX & official pricing refresh (never called during default offline sync) ---

const FX_URLS = [
  "https://open.er-api.com/v6/latest/USD",
  "https://api.frankfurter.app/latest?from=USD&to=CNY",
];
const GOOGLE_PRICING_URL = "https://aistudio.google.com/docs/pricing";
const PARTNER_PRICING_URL = "https://cloud.google.com/model-garden/partner-models/pricing";

export async function fetchLiveFxRate({ timeoutMs = 5000 } = {}) {
  for (const url of FX_URLS) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.result != null && data.result !== "success") continue;
      const val = data?.rates?.CNY;
      if (typeof val === "number" && Number.isFinite(val) && val >= 3 && val <= 15) {
        return {
          rate: Number(val.toFixed(4)),
          source: new URL(url).hostname,
          updatedAt: new Date().toISOString(),
        };
      }
    } catch {
      // Try next fallback source.
    }
  }
  return null;
}

export function parseOfficialPricingMarkdown(markdown) {
  if (typeof markdown !== "string" || !markdown) return {};
  const updates = {};
  const mapModelToFamily = (id) => {
    const s = String(id || "").toLowerCase();
    if (s.includes("neon")) return "neon";
    if (s.includes("hydrogen")) return "hydrogen";
    if (s.includes("carbon")) return "carbon";
    if (s.includes("argon")) return "argon";
    if (s.includes("flash")) return "flash";
    return null;
  };
  for (const section of markdown.split(/^## /m).slice(1)) {
    const id = section.match(/id="(gemini-[^"]+)"/i)?.[1];
    const fam = mapModelToFamily(id);
    if (!fam || /image|live|tts|embedding|robotics/.test(id)) continue;
    const standard = section.split(/tab title="Standard"/)[1]?.split(/\{% \/tab %\}/)[0];
    if (!standard) continue;
    const extract = (label) => {
      const chunk = standard
        .split(new RegExp(`\\* ${label}[^\\n]*\\n`, "i"))[1]
        ?.split(/\n\s*---/)[0];
      return chunk?.match(/\$([\d.]+)/g)?.map((s) => Number(s.slice(1))) || [];
    };
    const input = extract("Input price");
    const output = extract("Output price");
    const cache = extract("Context caching price");
    if (!input.length || !output.length || !cache.length) continue;
    const entry = {
      standard: { input: input[0], cache_read: cache[0], output: output[0] },
    };
    const future = standard.match(/starting ([A-Z][a-z]+ \d{1,2}, \d{4})/i);
    if (future && input[1] != null && output[1] != null && cache[1] != null) {
      const dt = new Date(`${future[1]} 00:00:00 UTC`);
      if (!Number.isNaN(dt.getTime())) {
        entry.promo = { input: input[0], cache_read: cache[0], output: output[0] };
        entry.promoEnd = new Date(dt.getTime() - DAY_MS).toISOString().slice(0, 10);
        entry.standard = { input: input[1], cache_read: cache[1], output: output[1] };
      }
    } else if ([input, output, cache].some((v) => v.length > 1)) {
      continue;
    }
    updates[fam] = entry;
  }
  return updates;
}

export function parsePartnerPricingHtml(html) {
  if (typeof html !== "string" || !html) return {};
  const matches = [];
  const re = />\s*(?:Claude\s+)?(Opus|Sonnet)\s+(5\.5)\s*</gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    matches.push({ family: m[1].toLowerCase(), index: m.index });
  }
  const updates = {};
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const fam = cur.family === "opus" ? "claude_opus_5_5" : "claude_sonnet_5_5";
    if (updates[fam]) continue;
    const end = Math.min(
      i + 1 < matches.length ? matches[i + 1].index : html.length,
      cur.index + 6500
    );
    const text = html.slice(cur.index, end).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const input = Number(text.match(/\bInput\s*\$([\d.]+)/i)?.[1]);
    const output = Number(text.match(/\bOutput\s*\$([\d.]+)/i)?.[1]);
    const cache = Number(text.match(/\bCache\s+(?:Hit|Read)\s*\$([\d.]+)/i)?.[1]);
    if ([input, output, cache].every(Number.isFinite)) {
      updates[fam] = {
        standard: { input, cache_read: cache, output },
      };
    }
  }
  return updates;
}

export async function fetchLiveOfficialPricing({ timeoutMs = 10000 } = {}) {
  const [mainRes, partnerRes] = await Promise.allSettled([
    fetch(GOOGLE_PRICING_URL, {
      headers: { Accept: "text/markdown" },
      signal: AbortSignal.timeout(timeoutMs),
    }),
    fetch(PARTNER_PRICING_URL, {
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
    }),
  ]);
  let families = {};
  if (mainRes.status === "fulfilled" && mainRes.value.ok) {
    families = {
      ...families,
      ...parseOfficialPricingMarkdown(await mainRes.value.text()),
    };
  }
  if (partnerRes.status === "fulfilled" && partnerRes.value.ok) {
    try {
      families = {
        ...families,
        ...parsePartnerPricingHtml(await partnerRes.value.text()),
      };
    } catch {}
  }
  if (!Object.keys(families).length) {
    throw new Error("未能从官方价格页解析到费率");
  }
  return {
    families,
    checkedAt: new Date().toISOString(),
    source: GOOGLE_PRICING_URL,
  };
}

export function loadPricingCache(repoRoot) {
  try {
    const file = path.join(repoRoot, "data", "pricing_cache.json");
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function savePricingCache(repoRoot, payload) {
  const file = path.join(repoRoot, "data", "pricing_cache.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return payload;
}
