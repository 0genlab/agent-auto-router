import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { calculateCostUsd, normalizeUsage } from "../../src/core/usage-cost.mjs";
import { findModelPrice } from "../../src/core/model-pricing.mjs";
import { createRoleRunStore } from "../jsonl/role-run-store.mjs";

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
  const subagent = source?.subagent;
  const raw = String(
    (typeof subagent === "string" ? subagent : subagent?.thread_spawn?.agent_role)
      || source?.role || ""
  ).toLowerCase();
  return roleMap[raw] || fallback;
}

function timestampOf(record) {
  const value = Date.parse(record?.timestamp || "");
  return Number.isFinite(value) ? value : null;
}

function legacyAliasFor(manifest, runId) {
  if (manifest?.source !== "codex-session-jsonl" || manifest.session_id !== runId.slice("codex-".length)) return false;
  if (!manifest.session_file || !fs.existsSync(manifest.session_file)) return false;
  const prior = parseSessionFile(manifest.session_file);
  return prior.parent_session_id === manifest.session_id && prior.session_id !== manifest.session_id;
}

export function parseSessionFile(file) {
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n");
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    try {
      records.push(JSON.parse(lines[index]));
    } catch (error) {
      if (index !== lines.length - 1 || content.endsWith("\n")) throw error;
    }
  }
  const meta = records.find((record) => record.type === "session_meta")?.payload || {};
  const emptyUsage = () => ({
    input_tokens: 0, output_tokens: 0, total_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, api_calls: 0
  });
  let segments = [];
  let context = { model: meta.model || null, provider: meta.model_provider || "unknown", cwd: meta.cwd || null };
  let segment = null;
  const seenResponses = new Set();
  const ensureSegment = () => {
    if (!segment || segment.model !== context.model || segment.provider !== context.provider) {
      segment = {
        model: context.model, provider: context.provider,
        usage: emptyUsage(), usage_count: 0, event_types: [],
        started_at: null, ended_at: null
      };
      segments.push(segment);
    }
    return segment;
  };
  for (const record of records) {
    if (record.type === "turn_context") {
      const payload = record.payload || {};
      context = {
        model: payload.model || context.model,
        provider: payload.model_provider || context.provider,
        cwd: payload.cwd || context.cwd
      };
    }
    if (!["turn_context", "event_msg", "token_usage_record"].includes(record.type)) continue;
    const current = ensureSegment();
    const time = timestampOf(record);
    if (time !== null) {
      current.started_at = Math.min(current.started_at ?? time, time);
      current.ended_at = Math.max(current.ended_at ?? time, time);
    }
    if (record.type === "event_msg") current.event_types.push(record.payload?.type);
    if (record.type !== "token_usage_record") continue;
    const payload = record.payload || {};
    const responseId = payload.response_id || `${record.timestamp}:${payload.turn_id || ""}`;
    if (seenResponses.has(responseId)) continue;
    seenResponses.add(responseId);
    const usage = normalizeUsage(payload.usage || {});
    for (const key of ["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"]) {
      current.usage[key] += usage[key] || 0;
    }
    current.usage.api_calls += 1;
    current.usage_count += 1;
  }
  if (!segments.length) ensureSegment();
  if (segments.some((item) => item.model)) {
    segments = segments.filter((item) => item.model || item.usage_count);
  }
  for (const item of segments) {
    if (!item.usage_count) {
      for (const key of ["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"]) {
        item.usage[key] = null;
      }
    }
    item.event_types = [...new Set(item.event_types.filter(Boolean))];
    item.status = item.event_types.includes("error") ? "failed"
      : item.event_types.some((type) => ["agent_message", "task_complete"].includes(type)) ? "success" : "unknown";
    item.started_at = item.started_at === null ? null : new Date(item.started_at).toISOString();
    item.ended_at = item.ended_at === null ? null : new Date(item.ended_at).toISOString();
    item.latency_ms = item.started_at && item.ended_at
      ? Date.parse(item.ended_at) - Date.parse(item.started_at) : null;
    delete item.usage_count;
  }
  const byModel = new Map();
  for (const item of segments) {
    const key = JSON.stringify([item.provider, item.model]);
    const previous = byModel.get(key);
    if (!previous) {
      byModel.set(key, item);
      continue;
    }
    for (const field of ["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"]) {
      previous.usage[field] = previous.usage[field] === null && item.usage[field] === null
        ? null : (previous.usage[field] || 0) + (item.usage[field] || 0);
    }
    previous.usage.api_calls += item.usage.api_calls;
    previous.event_types = [...new Set([...previous.event_types, ...item.event_types])];
    previous.status = previous.status === "failed" || item.status === "failed" ? "failed"
      : previous.status === "success" || item.status === "success" ? "success" : "unknown";
    previous.ended_at = item.ended_at || previous.ended_at;
    previous.latency_ms = (previous.latency_ms || 0) + (item.latency_ms || 0);
  }
  segments = [...byModel.values()];
  const usage = emptyUsage();
  for (const item of segments) {
    for (const key of ["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"]) {
      usage[key] += item.usage[key] || 0;
    }
    usage.api_calls += item.usage.api_calls;
  }
  if (!usage.api_calls) {
    for (const key of ["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"]) usage[key] = null;
  }
  const timestamps = records.map(timestampOf).filter((value) => value !== null);
  const eventTypes = records.filter((record) => record.type === "event_msg").map((record) => record.payload?.type);
  const hasError = eventTypes.includes("error");
  return {
    session_id: /^[a-zA-Z0-9_-]+$/.test(meta.id || meta.session_id || "")
      ? (meta.id || meta.session_id)
      : crypto.createHash("sha256").update(String(meta.id || meta.session_id || file)).digest("hex"),
    parent_session_id: meta.id && meta.session_id !== meta.id && /^[a-zA-Z0-9_-]+$/.test(meta.session_id || "")
      ? meta.session_id : null,
    source_digest: crypto.createHash("sha256").update(content).digest("hex"),
    cwd: context.cwd,
    model: context.model,
    provider: context.provider,
    role: roleFor(meta.source),
    source: meta.source || null,
    started_at: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    ended_at: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    latency_ms: timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : null,
    status: hasError ? "failed" : eventTypes.some((type) => ["agent_message", "task_complete"].includes(type)) ? "success" : "unknown",
    usage,
    segments,
    event_types: [...new Set(eventTypes)],
    session_file: file
  };
}

export function ingestSessionFiles({ files, store, priceSnapshot = null, priceSnapshots = null, since = null, refresh = false } = {}) {
  const ingested = [];
  const seenRunIds = new Set();
  for (const file of files || []) {
    const modifiedAt = fs.statSync(file).mtimeMs;
    if (since !== null && modifiedAt < since) continue;
    const session = parseSessionFile(file);
    const runId = `codex-${session.session_id}`;
    if (seenRunIds.has(runId)) continue;
    seenRunIds.add(runId);
    const runDir = path.join(store.runsRoot, runId);
    if (fs.existsSync(runDir)) {
      const manifestPath = path.join(runDir, "manifest.json");
      const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
      if (existing?.source !== "codex-session-jsonl"
        || (existing.session_file !== file && !legacyAliasFor(existing, runId))) {
        throw new Error(`refusing to replace non-matching run: ${runId}`);
      }
      if (!refresh && existing.session_file === file && existing.source_digest === session.source_digest) continue;
    }
    fs.mkdirSync(store.runsRoot, { recursive: true });
    const stageRoot = fs.mkdtempSync(path.join(store.runsRoot, ".codex-stage-"));
    const stagedStore = createRoleRunStore(stageRoot);
    const manifest = {
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
      source_digest: session.source_digest,
      started_at: session.started_at
    };
    try {
      stagedStore.createRun(manifest, {
      schema_version: 1,
      run_id: runId,
      event: "run_started",
      timestamp: session.started_at || new Date().toISOString(),
      role: "main",
      provider: session.provider,
      model: null
      });
      for (const item of session.segments) {
        const providerSnapshot = priceSnapshots?.[item.provider] || priceSnapshot;
        const price = findModelPrice(providerSnapshot, item.model, item.provider);
        const cost = calculateCostUsd(item.usage, {
          inputPricePerMillion: price?.input_price_per_million,
          outputPricePerMillion: price?.output_price_per_million
        });
        stagedStore.appendEvent(runId, {
          schema_version: 1,
          run_id: runId,
          event: "agent_finished",
          timestamp: item.ended_at || session.ended_at || new Date().toISOString(),
          task_id: session.session_id,
          task_family: "unknown",
          role: session.role,
          model: item.model,
          provider: item.provider,
          deployment: item.model,
          status: item.status,
          latency_ms: item.latency_ms,
          input_tokens: item.usage.input_tokens,
          output_tokens: item.usage.output_tokens,
          total_tokens: item.usage.total_tokens,
          cost_usd: cost,
          regression: null,
          failure_mode: item.status === "failed" ? "session_error" : null,
          evidence: [`codex-session:${session.session_id}`],
          note: "passive ingestion from Codex session JSONL"
        });
      }
      const stagedRun = path.join(stageRoot, runId);
      const backup = path.join(stageRoot, "previous");
      if (fs.existsSync(runDir)) fs.renameSync(runDir, backup);
      try {
        fs.renameSync(stagedRun, runDir);
      } catch (error) {
        if (fs.existsSync(backup)) fs.renameSync(backup, runDir);
        throw error;
      }
      if (session.parent_session_id) {
        const aliasDir = path.join(store.runsRoot, `codex-${session.parent_session_id}`);
        const aliasManifest = path.join(aliasDir, "manifest.json");
        if (fs.existsSync(aliasManifest)) {
          const alias = JSON.parse(fs.readFileSync(aliasManifest, "utf8"));
          if (alias.source === "codex-session-jsonl" && alias.session_file === file) {
            fs.renameSync(aliasDir, path.join(stageRoot, "legacy-alias"));
          }
        }
      }
    } finally {
      fs.rmSync(stageRoot, { recursive: true, force: true });
    }
    ingested.push({ run_id: runId, session });
  }
  return ingested;
}
