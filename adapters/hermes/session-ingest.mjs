import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { calculateCostUsd, normalizeUsage } from "../../src/core/usage-cost.mjs";
import { findModelPrice } from "../../src/core/model-pricing.mjs";
import { canonicalProvider } from "../../src/core/role-policy.mjs";

const readOnlyExport = String.raw`
import json
import os
import sqlite3
import sys
from urllib.parse import quote

db_path = os.path.abspath(sys.argv[1])
uri = "file:" + quote(db_path, safe="/") + "?mode=ro"
connection = sqlite3.connect(uri, uri=True)
connection.row_factory = sqlite3.Row
connection.execute("PRAGMA query_only = ON")

def rows_for(table, wanted):
    columns = {
        row[1]
        for row in connection.execute("PRAGMA table_info(" + table + ")")
    }
    selected = [column for column in wanted if column in columns]
    if not selected:
        return []
    query = "SELECT " + ", ".join(selected) + " FROM " + table
    return [dict(row) for row in connection.execute(query)]

sessions = rows_for("sessions", [
    "id", "source", "model", "parent_session_id", "started_at", "ended_at",
    "end_reason", "message_count", "tool_call_count", "input_tokens",
    "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "reasoning_tokens", "billing_provider", "billing_base_url",
    "billing_mode", "estimated_cost_usd", "actual_cost_usd", "cost_status",
    "cost_source", "cwd", "api_call_count", "last_activity_at", "git_branch"
])
usage = rows_for("session_model_usage", [
    "session_id", "model", "billing_provider", "billing_base_url",
    "billing_mode", "task", "api_call_count", "input_tokens", "output_tokens",
    "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
    "estimated_cost_usd", "actual_cost_usd", "cost_status", "cost_source",
    "first_seen", "last_seen"
])
connection.close()
print(json.dumps({"sessions": sessions, "usage": usage}, separators=(",", ":")))
`;

const providerByHostname = [
  { hostname: "api.anthropic.com", provider: "anthropic" },
  { hostname: "aihubmix.com", provider: "aihubmix" },
  { hostname: "ccsub.inferera.com", provider: "sub2api" },
  { hostname: "openrouter.ai", provider: "openrouter" },
  { hostname: "inference.nousresearch.com", provider: "nous" }
];

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumNullable(rows, field) {
  if (!rows.length) return null;
  let sum = 0;
  for (const row of rows) {
    const value = numberOrNull(row[field]);
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

function sumContributions(rows, field) {
  return rows.reduce((sum, row) => sum + (numberOrNull(row[field]) || 0), 0);
}

function addNullable(left, right) {
  if (right === null) return left;
  return (left ?? 0) + right;
}

function isoFromSeconds(value) {
  const seconds = numberOrNull(value);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function slug(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function providerName(value, providerAliases) {
  const provider = String(value || "").trim().toLowerCase();
  if (!provider) return "unknown";
  return canonicalProvider({ provider_aliases: providerAliases }, provider) || "unknown";
}

function sessionStatus(session) {
  const reason = String(session.end_reason || "").toLowerCase();
  if (["complete", "completed", "success", "succeeded"].includes(reason)) return "success";
  if (reason && ["error", "failed", "failure", "cancelled", "canceled"].some((part) => reason.includes(part))) return "failed";
  return "unknown";
}

export function sanitizeBillingBaseUrl(baseUrl) {
  const value = stringOrNull(baseUrl);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function billingPathHash(baseUrl) {
  const value = stringOrNull(baseUrl);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return createHash("sha256").update(url.pathname).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

export function providerFromBillingBaseUrl(baseUrl) {
  const sanitized = sanitizeBillingBaseUrl(baseUrl);
  if (!sanitized) return null;
  try {
    const url = new URL(sanitized);
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    return providerByHostname.find((entry) => hostname === entry.hostname || hostname.endsWith(`.${entry.hostname}`))?.provider || null;
  } catch {
    return null;
  }
}

function billingIdentity(row, session, providerAliases) {
  const rawBillingBaseUrl = stringOrNull(row?.billing_base_url) || stringOrNull(session?.billing_base_url);
  const billingBaseUrl = sanitizeBillingBaseUrl(rawBillingBaseUrl);
  const billingMode = stringOrNull(row?.billing_mode) || stringOrNull(session?.billing_mode);
  const declaredProvider = providerName(
    stringOrNull(row?.billing_provider) || stringOrNull(session?.billing_provider),
    providerAliases
  );
  const derivedProvider = providerFromBillingBaseUrl(billingBaseUrl);
  const provider = derivedProvider || declaredProvider;
  return {
    provider,
    provider_verified: Boolean(derivedProvider),
    provider_evidence: derivedProvider ? "billing-base-url" : declaredProvider !== "unknown" ? "billing-provider" : "unknown",
    provider_conflict: Boolean(derivedProvider && declaredProvider !== "unknown" && declaredProvider !== derivedProvider),
    billing_base_url: billingBaseUrl,
    billing_path_hash: billingPathHash(rawBillingBaseUrl),
    billing_mode: billingMode
  };
}

function declaredCost(usage) {
  const status = String(usage?.cost_status || "").trim().toLowerCase();
  const source = String(usage?.cost_source || "").trim().toLowerCase();
  if (status === "actual" || source === "actual") {
    return { kind: "actual", value: numberOrNull(usage.actual_cost_usd) };
  }
  if (status === "estimated" || source === "estimated") {
    return { kind: "estimated", value: numberOrNull(usage.estimated_cost_usd) };
  }
  return null;
}

function trustedCost(usage) {
  const cost = declaredCost(usage);
  return cost?.kind === "actual" ? cost.value : null;
}

function estimatedCost(usage) {
  const cost = declaredCost(usage);
  return cost?.kind === "estimated" ? cost.value : null;
}

function groupedCost(rows, costForRow) {
  if (!rows.length) return null;
  const costs = rows.map(costForRow);
  if (costs.some((cost) => cost === null)) return null;
  return costs.reduce((sum, cost) => sum + cost, 0);
}

function isMainUsageRow(row) {
  if (!row || typeof row !== "object") return false;
  if (!Object.hasOwn(row, "task")) return true;
  return typeof row.task === "string" && !row.task.trim();
}

function residualAttribution(groups, usageRows, rowGroupKeys) {
  if (!usageRows.length) return null;

  // Hermes session totals cover the main loop; task-named rows are auxiliary usage.
  const explicitMainRows = usageRows.filter(isMainUsageRow);
  if (!explicitMainRows.length) return null;
  const candidateKeys = new Set(explicitMainRows.map((row) => rowGroupKeys.get(row)));
  if (candidateKeys.size !== 1) return null;
  const [key] = candidateKeys;
  const group = groups.get(key);
  return group ? { group, rows: explicitMainRows } : null;
}

function sessionUsageResidual(session, rows) {
  const usageFields = [
    ["input_tokens", "input_tokens", "input_tokens"],
    ["output_tokens", "output_tokens", "output_tokens"],
    ["cache_read_tokens", "cache_read_tokens", "cache_read_tokens"],
    ["cache_write_tokens", "cache_write_tokens", "cache_write_tokens"],
    ["reasoning_tokens", "reasoning_tokens", "reasoning_tokens"],
    ["api_calls", "api_call_count", "api_call_count"]
  ];
  const residual = {};
  for (const [usageField, sessionField, rowField] of usageFields) {
    const total = numberOrNull(session[sessionField]);
    if (total === null) {
      residual[usageField] = null;
      continue;
    }
    const accounted = sumNullable(rows, rowField);
    if (accounted === null) {
      residual[usageField] = null;
      continue;
    }
    residual[usageField] = total >= accounted ? total - accounted : null;
  }
  return residual;
}

function sessionCostResidual(session, rows, costForRow, expectedKind) {
  const declared = declaredCost(session);
  if (!declared || declared.kind !== expectedKind || declared.value === null) return null;
  const accounted = groupedCost(rows, costForRow);
  if (accounted === null) return null;
  return declared.value >= accounted ? declared.value - accounted : null;
}

function runIdForSession(session) {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      session.session_id,
      session.provider,
      session.model,
      session.billing_base_url,
      session.billing_path_hash,
      session.billing_mode
    ]))
    .digest("hex")
    .slice(0, 32);
  return `hermes-${digest}`;
}

export function exportHermesRows({
  database = process.env.HERMES_DB || path.join(process.env.HERMES_HOME || path.join(process.env.HOME || "", ".hermes"), "state.db"),
  python = process.env.PYTHON || "python3",
  spawnSyncImpl = spawnSync
} = {}) {
  const result = spawnSyncImpl(python, ["-c", readOnlyExport, database], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Hermes SQLite export failed: ${String(result.stderr || "").trim()}`);
  }
  return JSON.parse(result.stdout);
}

export function parseHermesRows(exported, { providerAliases = {} } = {}) {
  const sessions = new Map((exported.sessions || []).map((session) => [session.id, session]));
  const usageBySession = new Map();
  for (const usage of exported.usage || []) {
    if (!usageBySession.has(usage.session_id)) usageBySession.set(usage.session_id, []);
    usageBySession.get(usage.session_id).push(usage);
  }

  const records = [];
  for (const session of sessions.values()) {
    const usageRows = usageBySession.get(session.id) || [];
    const groups = new Map();
    const rowGroupKeys = new Map();
    if (usageRows.length) {
      for (const row of usageRows) {
        const model = stringOrNull(row.model) || stringOrNull(session.model) || "unknown";
        const identity = billingIdentity(row, session, providerAliases);
        const key = JSON.stringify([
          identity.provider,
          model,
          identity.billing_base_url,
          identity.billing_path_hash,
          identity.billing_mode
        ]);
        if (!groups.has(key)) groups.set(key, { ...identity, model, rows: [] });
        groups.get(key).rows.push(row);
        rowGroupKeys.set(row, key);
      }
    } else {
      const model = stringOrNull(session.model) || "unknown";
      const identity = billingIdentity({}, session, providerAliases);
      const key = JSON.stringify([
          identity.provider,
          model,
          identity.billing_base_url,
          identity.billing_path_hash,
          identity.billing_mode
      ]);
      groups.set(key, { ...identity, model, rows: [] });
    }

    const residual = residualAttribution(groups, usageRows, rowGroupKeys);
    for (const group of groups.values()) {
      const aggregate = {
        input_tokens: sumNullable(group.rows, "input_tokens"),
        output_tokens: sumNullable(group.rows, "output_tokens"),
        cache_read_tokens: sumNullable(group.rows, "cache_read_tokens"),
        cache_write_tokens: sumNullable(group.rows, "cache_write_tokens"),
        reasoning_tokens: sumNullable(group.rows, "reasoning_tokens"),
        api_calls: sumNullable(group.rows, "api_call_count")
      };
      let usage = group.rows.length
        ? normalizeUsage({
            input_tokens: aggregate.input_tokens,
            output_tokens: aggregate.output_tokens,
            total_tokens: aggregate.input_tokens !== null && aggregate.output_tokens !== null
              ? aggregate.input_tokens + aggregate.output_tokens
              : undefined,
            cache_read_tokens: aggregate.cache_read_tokens,
            cache_write_tokens: aggregate.cache_write_tokens,
            api_calls: aggregate.api_calls
          })
        : normalizeUsage({
            input_tokens: session.input_tokens,
            output_tokens: session.output_tokens,
            total_tokens: numberOrNull(session.input_tokens) !== null && numberOrNull(session.output_tokens) !== null
              ? numberOrNull(session.input_tokens) + numberOrNull(session.output_tokens)
              : null,
            cache_read_tokens: session.cache_read_tokens,
            cache_write_tokens: session.cache_write_tokens,
            api_calls: session.api_call_count
          });
      if (aggregate.api_calls === null) usage.api_calls = null;
      if (usage.input_tokens === null || usage.output_tokens === null) usage.total_tokens = null;
      usage.reasoning_tokens = group.rows.length
        ? aggregate.reasoning_tokens
        : numberOrNull(session.reasoning_tokens);
      let trustedCostUsd = group.rows.length ? groupedCost(group.rows, trustedCost) : trustedCost(session);
      let estimatedCostUsd = group.rows.length ? groupedCost(group.rows, estimatedCost) : estimatedCost(session);
      if (residual?.group === group) {
        // Reconcile only the main-loop residual; auxiliary rows stay in the group total.
        const usageResidual = sessionUsageResidual(session, residual.rows);
        for (const field of [
          "input_tokens",
          "output_tokens",
          "cache_read_tokens",
          "cache_write_tokens",
          "api_calls"
        ]) {
          usage[field] = addNullable(usage[field], usageResidual[field]);
        }
        usage.reasoning_tokens = addNullable(usage.reasoning_tokens, usageResidual.reasoning_tokens);
        const residualTotal = usageResidual.input_tokens !== null && usageResidual.output_tokens !== null
          ? usageResidual.input_tokens + usageResidual.output_tokens
          : null;
        usage.total_tokens = addNullable(usage.total_tokens, residualTotal);
        trustedCostUsd = addNullable(
          trustedCostUsd,
          sessionCostResidual(session, residual.rows, trustedCost, "actual")
        );
        estimatedCostUsd = addNullable(
          estimatedCostUsd,
          sessionCostResidual(session, residual.rows, estimatedCost, "estimated")
        );
      }
      const endedAt = session.ended_at ?? session.last_activity_at;
      records.push({
        session_id: session.id,
        source: session.source || null,
        model: group.model,
        provider: group.provider,
        provider_verified: group.provider_verified,
        provider_evidence: group.provider_evidence,
        provider_conflict: group.provider_conflict,
        billing_base_url: group.billing_base_url,
        billing_path_hash: group.billing_path_hash,
        billing_mode: group.billing_mode,
        cwd: session.cwd || null,
        git_branch: session.git_branch || null,
        role: "main",
        started_at: isoFromSeconds(session.started_at),
        ended_at: isoFromSeconds(endedAt),
        latency_ms: numberOrNull(session.started_at) !== null && numberOrNull(endedAt) !== null
          ? Math.max(0, Math.round((numberOrNull(endedAt) - numberOrNull(session.started_at)) * 1000))
          : null,
        status: sessionStatus(session),
        usage: {
          ...usage,
          reasoning_tokens: usage.reasoning_tokens
        },
        trusted_cost_usd: trustedCostUsd,
        estimated_cost_usd: estimatedCostUsd,
        message_count: numberOrNull(session.message_count),
        tool_call_count: numberOrNull(session.tool_call_count),
        sensitive_content_included: false
      });
    }
  }
  return records;
}

export function parseHermesDatabase(options = {}) {
  const exported = options.exported || exportHermesRows(options);
  return parseHermesRows(exported, { providerAliases: options.providerAliases });
}

export function ingestHermesSessions({
  store,
  records,
  exported,
  providerAliases = {},
  priceSnapshot = null,
  priceSnapshots = null,
  since = null,
  refresh = false
} = {}) {
  const parsed = records || parseHermesRows(exported || {}, { providerAliases });
  const ingested = [];
  for (const session of parsed) {
    const startedAt = Date.parse(session.started_at || "");
    if (since !== null && Number.isFinite(startedAt) && startedAt < since) continue;
    const runId = runIdForSession(session);
    const runDir = path.join(store.runsRoot, runId);
    if (fs.existsSync(runDir)) {
      if (!refresh) continue;
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    const providerSnapshot = priceSnapshots?.[session.provider] || priceSnapshot;
    const price = findModelPrice(providerSnapshot, session.model, session.provider);
    const calculatedCost = calculateCostUsd(session.usage, {
      inputPricePerMillion: price?.input_price_per_million,
      outputPricePerMillion: price?.output_price_per_million
    });
    const actualCost = session.trusted_cost_usd ?? null;
    const estimatedCostUsd = session.estimated_cost_usd
      ?? (actualCost === null ? calculatedCost : null);

    store.createRun({
      schema_version: 1,
      run_id: runId,
      title: `Hermes session ${session.session_id} (${session.provider}/${session.model})`,
      task_type: "unknown",
      project: session.cwd,
      expected: "",
      task_family: "unknown",
      repo_language: null,
      tool_profile: null,
      context_size_bucket: null,
      source: "hermes-state-sqlite",
      session_id: session.session_id,
      model: session.model,
      provider_verified: session.provider_verified,
      billing_base_url: session.billing_base_url,
      billing_path_hash: session.billing_path_hash,
      billing_mode: session.billing_mode,
      started_at: session.started_at
    }, {
      schema_version: 1,
      run_id: runId,
      event: "run_started",
      timestamp: session.started_at || new Date().toISOString(),
      role: "main",
      provider: session.provider,
      provider_verified: session.provider_verified,
      billing_base_url: session.billing_base_url,
      billing_path_hash: session.billing_path_hash,
      billing_mode: session.billing_mode,
      model: session.model
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
      provider_verified: session.provider_verified,
      billing_base_url: session.billing_base_url,
      billing_path_hash: session.billing_path_hash,
      billing_mode: session.billing_mode,
      deployment: session.model,
      status: session.status,
      latency_ms: session.latency_ms,
      input_tokens: session.usage.input_tokens,
      output_tokens: session.usage.output_tokens,
      total_tokens: session.usage.total_tokens,
      cost_usd: actualCost,
      estimated_cost_usd: estimatedCostUsd,
      regression: null,
      failure_mode: session.status === "failed" ? "session_error" : null,
      evidence: [`hermes-session:${session.session_id}`],
      note: "passive ingestion from Hermes sessions and session_model_usage; messages excluded"
    });
    ingested.push({ run_id: runId, session });
  }
  return ingested;
}
