import test from "node:test";
import assert from "node:assert/strict";
import {
  annotateCacheAnomalies,
  classifyRetryReason,
  decodeGeneration,
  decodeProtobufFields,
  formatLocalYmdFromMs,
  mergeRequestLists,
  normalizeModelKey,
  parseOfficialPricingMarkdown,
  parsePartnerPricingHtml,
  pruneRequestList,
  resolveRequestSpeed,
  robustPeakTps,
  sanitizeErrorText,
  summarizeDbTelemetry,
} from "../lib/telemetry.mjs";

function varint(n) {
  let v = BigInt(n);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}
const ld = (field, buf) =>
  Buffer.concat([varint((BigInt(field) << 3n) | 2n), varint(buf.length), buf]);
const vi = (field, val) => Buffer.concat([varint(BigInt(field) << 3n), varint(val)]);
const str = (field, s) => ld(field, Buffer.from(s, "utf8"));
const dur = (sec, nanos = 0) => Buffer.concat([vi(1, sec), vi(2, nanos)]);

test("decodeProtobufFields & decodeGeneration extract telemetry and reject malformed varints", () => {
  const usageBuf = Buffer.concat([
    vi(2, 1200),
    vi(3, 350),
    vi(5, 9500),
    vi(9, 150),
    vi(10, 200),
  ]);
  const sysGroup = Buffer.concat([
    str(1, "System Prompt"),
    vi(4, 1500),
    ld(5, Buffer.concat([str(1, "skills"), vi(3, 500)])),
  ]);
  const rulesGroup = Buffer.concat([str(1, "Rules"), vi(4, 800)]);
  const ctxBuf = Buffer.concat([
    vi(1, 10700),
    ld(3, Buffer.concat([ld(1, sysGroup), ld(1, rulesGroup)])),
    vi(4, 512000),
  ]);
  const chatBuf = Buffer.concat([
    vi(3, 42),
    ld(4, usageBuf),
    ld(9, ld(10, ctxBuf)),
    ld(11, dur(2, 500_000_000)),
    ld(12, dur(1, 250_000_000)),
    vi(14, 1),
    ld(17, str(3, "unexpected EOF")),
    str(21, "Gemini 4 Neon (High)"),
    ld(20, Buffer.concat([str(1, "request_id"), str(2, "req-abc")])),
  ]);
  const genBuf = Buffer.concat([
    ld(1, chatBuf),
    vi(2, 5),
    ld(3, ld(60, vi(1, 42))),
    str(4, "exec-1"),
  ]);

  const parsedMap = decodeProtobufFields(genBuf);
  assert.ok(parsedMap.has(1));

  const decoded = decodeGeneration(genBuf);
  assert.equal(decoded.modelName, "Gemini 4 Neon (High)");
  assert.equal(decoded.role, "execution");
  assert.equal(decoded.inputTokens, 1200);
  assert.equal(decoded.cacheReadTokens, 9500);
  assert.equal(decoded.outputTokens, 350);
  assert.equal(decoded.thinkingTokens, 150);
  assert.equal(decoded.responseTokens, 200);
  assert.equal(decoded.requestId, "req-abc");
  assert.equal(decoded.retries, 1);
  assert.deepEqual(decoded.retryErrors, ["unexpected EOF"]);
  assert.equal(decoded.ttftMs, 2500);
  assert.equal(decoded.streamingMs, 1250);
  assert.equal(decoded.context.maxTokens, 512000);
  assert.deepEqual(decoded.context.categories, [
    { label: "System Prompt", tokens: 1000 },
    { label: "Skills", tokens: 500 },
    { label: "Rules", tokens: 800 },
  ]);

  // Oversized key (0x100000001n << 3n would collide with field 1 if >>> 3 was used).
  const badTagBuf = Buffer.concat([varint((0x100000001n << 3n) | 0n), varint(1)]);
  assert.throws(() => decodeProtobufFields(badTagBuf), /Invalid protobuf key/);

  // Truncated packed stepIndices lacking terminating byte must throw, not return [].
  const truncatedPacked = Buffer.concat([
    ld(1, chatBuf),
    ld(2, Buffer.from([0x81])),
  ]);
  assert.throws(() => decodeGeneration(truncatedPacked), /Truncated packed stepIndices/);
});

test("resolveRequestSpeed & robustPeakTps handle whole mode, buffered tail, and real Tukey outliers", () => {
  const normal = resolveRequestSpeed({
    outputTokens: 400,
    ttftMs: 4000,
    streamingMs: 2000,
  });
  assert.equal(normal.tpsMode, "stream");
  assert.equal(normal.tps, 200);
  assert.equal(normal.wholeTps, 66.7);

  const buffered = resolveRequestSpeed({
    outputTokens: 800,
    ttftMs: 19500,
    streamingMs: 500,
  });
  assert.equal(buffered.tpsMode, "whole");
  assert.equal(buffered.tps, 40);

  // Parity check for explicit whole-mode sample (backend must NOT recalculate 400 tok/s).
  assert.equal(
    robustPeakTps([{ out: 200, st: 500, dur: 10000, tm: "whole", tps: 20 }]),
    20
  );

  // Tukey fence check: outlier actually yields 806.5 tok/s from raw counts (2500 / 3.1s).
  const rows = [
    { out: 300, st: 3500, dur: 4500, tm: "stream" },
    { out: 350, st: 3800, dur: 5000, tm: "stream" },
    { out: 400, st: 4000, dur: 5200, tm: "stream" },
    { out: 420, st: 3900, dur: 5100, tm: "stream" },
    { out: 500, st: 4200, dur: 5400, tm: "stream" },
    { out: 2500, st: 3100, dur: 25000, tm: "stream" },
  ];
  assert.equal(robustPeakTps(rows), 119.0);
});

test("annotateCacheAnomalies detects cleared/dropped and ignores cross-conversation cold starts", () => {
  const t0 = 1_700_000_000_000;
  const reqs = [
    { id: "r1", cid: "c1", ts: t0, m: "Gemini 4 Neon (High)", in: 2000, ca: 50000, out: 100, ok: 1 },
    // Cleared within 60s with 96% input kept
    { id: "r2", cid: "c1", ts: t0 + 60_000, m: "gemini-4-neon-high", in: 50000, ca: 0, out: 100, ok: 1 },
    // After /compact (input dropped from 50k to 10k < 60%): must NOT flag
    { id: "r3", cid: "c1", ts: t0 + 90_000, m: "Gemini 4 Neon (High)", in: 10000, ca: 0, out: 100, ok: 1 },
    // Cold start in separate conversation c2 with zero prior hits in c2: must NOT flag missed
    { id: "c2-1", cid: "c2", ts: t0 + 100_000, m: "Gemini 4 Neon (High)", in: 25000, ca: 0, out: 100, ok: 1 },
    { id: "c2-2", cid: "c2", ts: t0 + 130_000, m: "Gemini 4 Neon (High)", in: 26000, ca: 0, out: 100, ok: 1 },
    // Gap > 3 min in c1: must NOT flag
    { id: "r4", cid: "c1", ts: t0 + 400_000, m: "Gemini 4 Neon (High)", in: 2000, ca: 40000, out: 100, ok: 1 },
    { id: "r5", cid: "c1", ts: t0 + 650_000, m: "Gemini 4 Neon (High)", in: 40000, ca: 0, out: 100, ok: 1 },
  ];
  const anoms = annotateCacheAnomalies(reqs);
  assert.equal(anoms.get("r2")?.kind, "cleared");
  assert.equal(anoms.has("r3"), false);
  assert.equal(anoms.has("c2-2"), false);
  assert.equal(anoms.has("r5"), false);
});

test("pruneRequestList & mergeRequestLists drop stale/timeless rows, sanitize errors, and backfill local date", () => {
  const now = 1_764_300_000_000;
  const old = [
    {
      id: "a",
      ts: now - 10_000,
      in: 100,
      err: "POST https://user:secret@example.com/v1/gen?key=AIza123 Authorization: Bearer tok_secret_999 failed",
    },
    { id: "b", ts: now - 5_000, in: 200 },
    { id: "timeless", ts: null, in: 999 },
    { id: "stale", ts: now - 95 * 86400000, in: 50 },
  ];
  const incoming = [{ id: "b", ts: now - 5_000, in: 250 }];
  const merged = mergeRequestLists(old, incoming, { now });
  assert.deepEqual(
    merged.map((r) => [r.id, r.in]),
    [
      ["a", 100],
      ["b", 250],
    ]
  );
  assert.equal(merged[0].d, formatLocalYmdFromMs(now - 10_000));
  assert.ok(!merged[0].err.includes("AIza123"));
  assert.ok(!merged[0].err.includes("tok_secret_999"));
  assert.ok(!merged[0].err.includes("secret@"));

  const pruned = pruneRequestList(old, { now });
  assert.equal(pruned.length, 2);
  assert.ok(sanitizeErrorText("https://api.example.com/chat?sig=abc&token=xyz").endsWith("?[redacted]"));
});

test("normalizeModelKey & classifyRetryReason & pricing parsers preserve historical promo rates", () => {
  assert.equal(normalizeModelKey("Gemini 4 Neon (High)"), "gemini-4-neon");
  assert.equal(normalizeModelKey("gemini-4-neon-high"), "gemini-4-neon");
  assert.equal(classifyRetryReason("unexpected EOF from upstream")?.code, "eof");
  assert.equal(classifyRetryReason("HTTP 429 RESOURCE_EXHAUSTED")?.code, "rate-limit");

  const futureMd = `
## Gemini 4 Carbon
<a id="gemini-4-carbon"></a>
{% tab title="Standard" %}
* Input price
  * $2.00 per 1M tokens (starting December 1, 2026: $4.00)
---
* Output price
  * $10.00 per 1M tokens ($20.00)
---
* Context caching price
  * $0.10 per 1M tokens ($0.20)
---
{% /tab %}
`;
  const parsedFuture = parseOfficialPricingMarkdown(futureMd);
  assert.equal(parsedFuture.carbon.promo.input, 2);
  assert.equal(parsedFuture.carbon.standard.output, 20);
  assert.equal(parsedFuture.carbon.promoEnd, "2026-11-30");

  // Single current rate after promo ends must NOT overwrite historical promo pricing.
  const postPromoMd = `
## Gemini 4 Carbon
<a id="gemini-4-carbon"></a>
{% tab title="Standard" %}
* Input price
  * $4.00 per 1M tokens
---
* Output price
  * $20.00 per 1M tokens
---
* Context caching price
  * $0.20 per 1M tokens
---
{% /tab %}
`;
  const parsedPost = parseOfficialPricingMarkdown(postPromoMd);
  assert.equal(parsedPost.carbon.standard.input, 4);
  assert.equal(parsedPost.carbon.promo, undefined);
  assert.equal(parsedPost.carbon.promoEnd, undefined);

  const partner = parsePartnerPricingHtml(
    "<h2>Claude Sonnet 5.5</h2><div>Input $3.00 Output $15.00 Cache Read $0.30</div>"
  );
  assert.equal(partner.claude_sonnet_5_5.standard.input, 3);
  assert.equal(partner.claude_sonnet_5_5.promo, undefined);
});

test("in-memory backward compatibility: v2 hourly_buckets + telemetry preserve ai-quota-monitor fields", () => {
  const telemetry = summarizeDbTelemetry(
    { generations: [{ modelName: "Gemini 4 Neon", providerInputTokens: 1000, context: { maxTokens: 512000, categories: [] } }], checkpointSteps: [1] },
    [{ id: "r1", ts: 1764000000000, out: 100, th: 20, resp: 80, ttft: 500, st: 1000, dur: 1500, tm: "stream", ok: 1, ret: 0 }]
  );
  const archive = {
    schema_version: 2,
    machine: "TEST",
    conversations: {
      "desktop:c1": {
        conv_id: "c1",
        source: "desktop",
        hourly_buckets: {
          "2026-11-28T08|gemini-4-neon-high": {
            date: "2026-11-28",
            hour: 8,
            model: "gemini-4-neon-high",
            steps: 1,
            input: 100,
            cache_read: 500,
            output: 50,
          },
          "2026-11-28T09|gemini-4-carbon": {
            date: "2026-11-28",
            hour: 9,
            model: "gemini-4-carbon",
            steps: 2,
            input: 200,
            cache_read: 1000,
            output: 150,
          },
        },
        db_telemetry: telemetry,
        requests: [{ id: "r1", ts: 1764000000000, d: "2026-11-28", m: "Gemini 4 Neon (High)" }],
      },
    },
  };
  let totalInput = 0;
  let totalCache = 0;
  let totalOutput = 0;
  let bucketCount = 0;
  for (const conv of Object.values(archive.conversations)) {
    const buckets = conv?.hourly_buckets || conv?.buckets || {};
    for (const bucket of Object.values(buckets)) {
      if (!bucket?.date || !Number.isInteger(bucket.hour)) continue;
      totalInput += Number(bucket.input) || 0;
      totalCache += Number(bucket.cache_read) || 0;
      totalOutput += Number(bucket.output) || 0;
      bucketCount++;
    }
  }
  assert.equal(bucketCount, 2);
  assert.equal(totalInput, 300);
  assert.equal(totalCache, 1500);
  assert.equal(totalOutput, 200);
  assert.equal(telemetry.thinking_tokens, 20);
  assert.equal(telemetry.compactions, 1);
});
