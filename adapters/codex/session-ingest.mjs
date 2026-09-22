import fs from "node:fs";
import path from "node:path";
import { calculateCostUsd, normalizeUsage } from "../../src/core/usage-cost.mjs";
import { findModelPrice } from "../../src/core/model-pricing.mjs";

const roleMap = {
  review: "reviewer",
  reviewer: "reviewer",
  research: "researcher",
  researcher: "researcher",
  plan: "planner",
  planner: "planner",
  explore: "explorer",
  explorer: "explorer",
  implement: "implementer",
  implementer: "implementer",
  e2e: "e2e"
};

function roleFor(source, fallback = "main") {
  const raw = String(source?.subagent || source?.role || "").toLowerCase();
  return roleMap[raw] || fallback;
}

function timestampOf(record) {
  const value = Date.parse(record?.timestamp || "");
  return Number.isFinite(value) ? value : null;
}

export function parseSessionFile(file) {
  const records = fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const meta = records.find((record) => record.type === "session_meta")?.payload || {};
  const contexts = records.filter((record) => record.type === "turn_context").map((record) => record.payload || {});
  const latestContext = contexts.at(-1) || {};
  const usageRecords = records.filter((record) => record.type === "token_usage_record");
  const seenResponses = new Set();
  const usage = usageRecords.reduce((sum, record) => {
    const payload = record.payload || {};
    const responseId = payload.response_id || `${record.timestamp}:${payload.turn_id || ""}`;
    if (seenResponses.has(responseId)) return sum;
    seenResponses.add(responseId);
    const current = normalizeUsage(payload.usage || {});
    return {
      input_tokens: sum.input_tokens + (current.input_tokens || 0),
      output_tokens: sum.output_tokens + (current.output_tokens || 0),
      total_tokens: sum.total_tokens + (current.total_tokens || 0),
      cache_read_tokens: sum.cache_read_tokens + (current.cache_read_tokens || 0),
      cache_write_tokens: sum.cache_write_tokens + (current.cache_write_tokens || 0),
      api_calls: (sum.api_calls || 0) + 1
    };
  }, { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, api_calls: 0 });
  if (!usageRecords.length) {
    usage.input_tokens = null;
    usage.output_tokens = null;
    usage.total_tokens = null;
    usage.cache_read_tokens = null;
    usage.cache_write_tokens = null;
  }
  const timestamps = records.map(timestampOf).filter((value) => value !== null);
  const eventTypes = records.filter((record) => record.type === "event_msg").map((record) => record.payload?.type);
  const hasError = eventTypes.includes("error");
  return {
    session_id: meta.session_id || meta.id || path.basename(file, ".jsonl"),
    cwd: latestContext.cwd || meta.cwd || null,
    model: latestContext.model || meta.model || null,
    provider: latestContext.model_provider || meta.model_provider || null,
    role: roleFor(meta.source),
    source: meta.source || null,
    started_at: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    ended_at: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    latency_ms: timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : null,
    status: hasError ? "failed" : eventTypes.includes("agent_message") ? "success" : "unknown",
    usage,
    event_types: [...new Set(eventTypes)],
    session_file: file
  };
}

export function ingestSessionFiles({ files, store, priceSnapshot = null, since = null, refresh = false } = {}) {
  const ingested = [];
  const seenRunIds = new Set();
  for (const file of files || []) {
    const session = parseSessionFile(file);
    const modifiedAt = fs.statSync(file).mtimeMs;
    if (since !== null && modifiedAt < since) continue;
    const runId = `codex-${session.session_id}`;
    if (seenRunIds.has(runId)) continue;
    seenRunIds.add(runId);
    const runDir = path.join(store.runsRoot, runId);
    if (fs.existsSync(runDir)) {
      if (!refresh) continue;
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    const price = findModelPrice(priceSnapshot, session.model);
    const cost = calculateCostUsd(session.usage, {
      inputPricePerMillion: price?.input_price_per_million,
      outputPricePerMillion: price?.output_price_per_million
    });
    store.createRun({
      schema_version: 1,
      run_id: runId,
      title: `Codex session ${session.session_id}`,
      task_type: "unknown",
      project: session.cwd,
      expected: "",
      task_family: "unknown",
      repo_language: null,
      tool_profile: null,
      context_size_bucket: null,
      source: "codex-session-jsonl",
      session_id: session.session_id,
      session_file: session.session_file,
      started_at: session.started_at
    }, {
      schema_version: 1,
      run_id: runId,
      event: "run_started",
      timestamp: session.started_at || new Date().toISOString(),
      role: "main",
      model: null
    });
    store.appendEvent(runId, {
      schema_version: 1,
      run_id: runId,
      event: "agent_finished",
      timestamp: session.ended_at || new Date().toISOString(),
      task_id: session.session_id,
      task_family: "unknown",
      role: session.role,
      model: session.model,
      provider: session.provider,
      deployment: session.model,
      status: session.status,
      latency_ms: session.latency_ms,
      input_tokens: session.usage.input_tokens,
      output_tokens: session.usage.output_tokens,
      total_tokens: session.usage.total_tokens,
      cost_usd: cost,
      regression: null,
      failure_mode: session.status === "failed" ? "session_error" : null,
      evidence: [`codex-session:${session.session_id}`],
      note: "passive ingestion from Codex session JSONL"
    });
    ingested.push({ run_id: runId, session });
  }
  return ingested;
}
