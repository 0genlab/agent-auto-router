import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { calculateCostUsd, normalizeUsage } from "../../src/core/usage-cost.mjs";
import { findModelPrice } from "../../src/core/model-pricing.mjs";

const providerByHostname = [
  { hostname: "api.anthropic.com", provider: "anthropic" },
  { hostname: "aihubmix.com", provider: "aihubmix" },
  { hostname: "ccsub.inferera.com", provider: "sub2api" },
  { hostname: "openrouter.ai", provider: "openrouter" }
];

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestampOf(record) {
  const value = Date.parse(record?.timestamp || "");
  return Number.isFinite(value) ? value : null;
}

export function providerFromBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    return providerByHostname.find((entry) => hostname === entry.hostname || hostname.endsWith(`.${entry.hostname}`))?.provider || null;
  } catch {
    return null;
  }
}

export function loadClaudeSettings({ claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "", ".claude") } = {}) {
  const settingsPath = path.join(claudeHome, "settings.json");
  if (!fs.existsSync(settingsPath)) return { settings: {}, settings_path: settingsPath };
  return {
    settings: JSON.parse(fs.readFileSync(settingsPath, "utf8")),
    settings_path: settingsPath
  };
}

export function detectClaudeProvider({ settings = {}, env = process.env } = {}) {
  const baseUrl = stringOrNull(env.ANTHROPIC_BASE_URL || settings.env?.ANTHROPIC_BASE_URL);
  const provider = providerFromBaseUrl(baseUrl);
  if (provider) {
    return {
      provider,
      verified: true,
      evidence: "anthropic-base-url",
      base_url: baseUrl
    };
  }

  return {
    provider: "unknown",
    verified: false,
    evidence: "no-verifiable-provider-route",
    base_url: baseUrl
  };
}

export function resolveClaudeProvider(options = {}) {
  return detectClaudeProvider(options).provider;
}

function runIdForSession(sessionId, model = null) {
  const digest = createHash("sha256")
    .update(JSON.stringify([String(sessionId || ""), String(model || "")]))
    .digest("hex")
    .slice(0, 32);
  return `claude-${digest}`;
}

function legacyRunIdForSession(sessionId) {
  const digest = createHash("sha256")
    .update(JSON.stringify([String(sessionId || "")]))
    .digest("hex")
    .slice(0, 32);
  return `claude-${digest}`;
}

function readRunManifest(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function hasFinishedEvent(runDir) {
  try {
    return fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .some((line) => JSON.parse(line).event === "agent_finished");
  } catch {
    return false;
  }
}

function isClaudeRunManifest(manifest, { runId, sessionId }) {
  return manifest?.schema_version === 1
    && manifest.run_id === runId
    && manifest.source === "claude-session-jsonl"
    && String(manifest.session_id || "") === String(sessionId || "");
}

function readFinishedEvent(runDir) {
  try {
    return fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .findLast((event) => event.event === "agent_finished") || null;
  } catch {
    return null;
  }
}

function claudeRunNeedsRefresh(runDir, { runId, session, group }) {
  const manifest = readRunManifest(runDir);
  if (!isClaudeRunManifest(manifest, { runId, sessionId: session.session_id })) return false;
  if (!stringOrNull(manifest.session_file)
    || path.resolve(manifest.session_file) !== path.resolve(session.session_file)) {
    return false;
  }
  const finished = readFinishedEvent(runDir);
  if (!finished) return false;
  return finished.model !== group.model
    || finished.provider !== session.provider
    || finished.provider_verified !== session.provider_verified
    || finished.status !== session.status
    || finished.input_tokens !== group.usage.input_tokens
    || finished.output_tokens !== group.usage.output_tokens
    || finished.total_tokens !== group.usage.total_tokens
    || (finished.cache_read_tokens !== undefined
      && finished.cache_read_tokens !== group.usage.cache_read_tokens)
    || (finished.cache_write_tokens !== undefined
      && finished.cache_write_tokens !== group.usage.cache_write_tokens);
}

function rewriteRunId(runDir, fromRunId, toRunId) {
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.run_id = toRunId;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const eventsPath = path.join(runDir, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return;
  const events = fs.readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line);
      if (event.run_id === fromRunId) event.run_id = toRunId;
      return JSON.stringify(event);
    });
  fs.writeFileSync(eventsPath, `${events.join("\n")}\n`);
}

function migrateLegacyClaudeRun({ store, session, groups }) {
  const legacyRunId = legacyRunIdForSession(session.session_id);
  const legacyRunDir = path.join(store.runsRoot, legacyRunId);
  if (!fs.existsSync(legacyRunDir)) return null;

  const legacyManifest = readRunManifest(legacyRunDir);
  if (!isClaudeRunManifest(legacyManifest, {
    runId: legacyRunId,
    sessionId: session.session_id
  })) {
    return null;
  }
  if (!hasFinishedEvent(legacyRunDir)) {
    fs.rmSync(legacyRunDir, { recursive: true, force: true });
    return null;
  }

  const legacyModel = stringOrNull(legacyManifest.model);
  if (!legacyModel && groups.length !== 1) return null;
  const model = legacyModel || groups[0]?.model || session.model || null;
  const runId = runIdForSession(session.session_id, model);
  if (runId === legacyRunId) return null;

  const runDir = path.join(store.runsRoot, runId);
  if (fs.existsSync(runDir)) {
    const currentManifest = readRunManifest(runDir);
    if (!isClaudeRunManifest(currentManifest, {
      runId,
      sessionId: session.session_id
    })) {
      return null;
    }
    if (hasFinishedEvent(runDir)) {
      fs.rmSync(legacyRunDir, { recursive: true, force: true });
      return runId;
    }
    if (!hasFinishedEvent(legacyRunDir)) return null;
    fs.rmSync(runDir, { recursive: true, force: true });
  }

  fs.renameSync(legacyRunDir, runDir);
  rewriteRunId(runDir, legacyRunId, runId);
  return runId;
}

function claudeUsage(message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return null;
  return normalizeUsage({
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_input_tokens,
    cache_write_tokens: usage.cache_creation_input_tokens,
    api_calls: 1
  });
}

function emptyUsage() {
  return {
    api_calls: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null
  };
}

function aggregateUsage(usages) {
  if (!usages.length) return emptyUsage();
  return usages.reduce((sum, usage) => ({
    api_calls: (sum.api_calls || 0) + (usage.api_calls || 0),
    input_tokens: (sum.input_tokens || 0) + (usage.input_tokens || 0),
    output_tokens: (sum.output_tokens || 0) + (usage.output_tokens || 0),
    total_tokens: (sum.total_tokens || 0) + (usage.total_tokens || 0),
    cache_read_tokens: (sum.cache_read_tokens || 0) + (usage.cache_read_tokens || 0),
    cache_write_tokens: (sum.cache_write_tokens || 0) + (usage.cache_write_tokens || 0)
  }), {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0
  });
}

function sessionBaseUrl(record) {
  const candidates = [
    record?.env?.ANTHROPIC_BASE_URL,
    record?.env?.anthropicBaseUrl,
    record?.anthropic_base_url,
    record?.anthropicBaseUrl,
    record?.api_base_url,
    record?.apiBaseUrl,
    record?.base_url,
    record?.baseUrl
  ];
  return candidates.find((value) => stringOrNull(value)) || null;
}

function providerEvidenceFromRecord(record) {
  const baseUrl = sessionBaseUrl(record);
  const provider = providerFromBaseUrl(baseUrl);
  return provider
    ? { provider, verified: true, evidence: "session-base-url", base_url: baseUrl }
    : null;
}

function consumeClaudeLines(file, consume) {
  const descriptor = fs.openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = "";
  let malformedLineCount = 0;

  const consumeLine = (line) => {
    const text = line.replace(/\r$/, "").trim();
    if (!text) return;
    try {
      const record = JSON.parse(text);
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        malformedLineCount += 1;
        return;
      }
      consume(record);
    } catch {
      malformedLineCount += 1;
    }
  };

  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        consumeLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    if (pending.trim()) consumeLine(pending);
  } finally {
    fs.closeSync(descriptor);
  }

  return malformedLineCount;
}

export function parseClaudeSessionFile(file, {
  provider = "unknown",
  providerVerified = false,
  auditedProvider = null,
  auditedProviderVerified = true
} = {}) {
  const uniqueUsage = new Map();
  const eventTypes = new Set();
  let sessionId = null;
  let cwd = null;
  let gitBranch = null;
  let version = null;
  let status = "unknown";
  let minTimestamp = null;
  let maxTimestamp = null;
  let timestampCount = 0;
  let sessionProviderEvidence = null;

  const malformedLineCount = consumeClaudeLines(file, (record) => {
    eventTypes.add(record.type || "unknown");
    const timestamp = timestampOf(record);
    if (timestamp !== null) {
      minTimestamp = minTimestamp === null ? timestamp : Math.min(minTimestamp, timestamp);
      maxTimestamp = maxTimestamp === null ? timestamp : Math.max(maxTimestamp, timestamp);
      timestampCount += 1;
    }
    sessionId ||= stringOrNull(record.sessionId);
    cwd ||= stringOrNull(record.cwd);
    gitBranch ||= stringOrNull(record.gitBranch);
    version ||= stringOrNull(record.version);
    if (record.is_error === true || record.type === "error") status = "failed";
    sessionProviderEvidence ||= providerEvidenceFromRecord(record);

    const message = record.type === "assistant" && record.message && typeof record.message === "object"
      ? record.message
      : null;
    const messageId = stringOrNull(message?.id);
    const usage = claudeUsage(message);
    if (messageId && usage) {
      uniqueUsage.set(messageId, {
        message_id: messageId,
        model: stringOrNull(message.model),
        timestamp,
        usage
      });
    }
  });

  const usageEntries = [...uniqueUsage.values()];
  const usage = aggregateUsage(usageEntries.map((entry) => entry.usage));
  const groupsByModel = new Map();
  for (const entry of usageEntries) {
    const model = stringOrNull(entry.model);
    const key = model || "";
    if (!groupsByModel.has(key)) groupsByModel.set(key, { model, entries: [] });
    groupsByModel.get(key).entries.push(entry);
  }
  const modelGroups = [...groupsByModel.values()].map((group) => {
    let groupStartedAt = null;
    let groupEndedAt = null;
    for (const entry of group.entries) {
      if (entry.timestamp === null) continue;
      groupStartedAt = groupStartedAt === null ? entry.timestamp : Math.min(groupStartedAt, entry.timestamp);
      groupEndedAt = groupEndedAt === null ? entry.timestamp : Math.max(groupEndedAt, entry.timestamp);
    }
    return {
      model: group.model,
      usage: aggregateUsage(group.entries.map((entry) => entry.usage)),
      started_at: groupStartedAt === null ? null : new Date(groupStartedAt).toISOString(),
      ended_at: groupEndedAt === null ? null : new Date(groupEndedAt).toISOString(),
      latency_ms: groupStartedAt !== null && groupEndedAt !== null && groupStartedAt !== groupEndedAt
        ? groupEndedAt - groupStartedAt
        : null
    };
  });

  const models = [...new Set(usageEntries.map((entry) => entry.model).filter(Boolean))];
  const latestModel = usageEntries
    .filter((entry) => entry.model)
    .sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0))[0]?.model || null;
  const startedAt = minTimestamp === null ? null : new Date(minTimestamp).toISOString();
  const endedAt = maxTimestamp === null ? null : new Date(maxTimestamp).toISOString();
  const audited = stringOrNull(auditedProvider);
  const sessionProvider = sessionProviderEvidence?.provider || null;
  const auditedConflict = Boolean(
    audited
    && sessionProvider
    && audited.toLowerCase() !== sessionProvider.toLowerCase()
  );
  const explicitProvider = (audited && audited.toLowerCase() !== "unknown" ? audited : null)
    || (providerVerified && stringOrNull(provider)?.toLowerCase() !== "unknown" ? stringOrNull(provider) : null);
  const resolvedProvider = auditedConflict
    ? sessionProvider
    : explicitProvider || sessionProvider || "unknown";
  const resolvedProviderVerified = auditedConflict
    ? Boolean(sessionProviderEvidence?.verified)
    : explicitProvider
      ? Boolean(stringOrNull(auditedProvider) ? auditedProviderVerified !== false : providerVerified)
      : Boolean(sessionProviderEvidence?.verified);
  const providerEvidence = auditedConflict
    ? sessionProviderEvidence.evidence
    : explicitProvider
      ? (stringOrNull(auditedProvider) ? "audited-provider-override" : "explicit-provider-override")
      : sessionProviderEvidence?.evidence || "no-verifiable-provider-route";

  return {
    session_id: sessionId || path.basename(file, ".jsonl"),
    cwd,
    git_branch: gitBranch,
    version,
    model: latestModel,
    models,
    model_groups: modelGroups,
    provider: resolvedProvider,
    provider_verified: resolvedProviderVerified,
    provider_evidence: providerEvidence,
    role: "main",
    started_at: startedAt,
    ended_at: endedAt,
    latency_ms: timestampCount > 1 ? maxTimestamp - minTimestamp : null,
    status,
    usage,
    event_types: [...eventTypes].sort(),
    malformed_line_count: malformedLineCount,
    session_file: file,
    sensitive_content_included: false
  };
}

export function ingestClaudeSessionFiles({
  files,
  store,
  provider = "unknown",
  providerVerified = false,
  auditedProvider = null,
  auditedProviderVerified = true,
  priceSnapshot = null,
  priceSnapshots = null,
  since = null,
  refresh = false
} = {}) {
  const ingested = [];
  for (const file of files || []) {
    const modifiedAt = fs.statSync(file).mtimeMs;
    if (since !== null && modifiedAt < since) continue;
    const session = parseClaudeSessionFile(file, {
      provider,
      providerVerified,
      auditedProvider,
      auditedProviderVerified
    });
    const groups = session.model_groups.length
      ? session.model_groups
      : [{
          model: session.model,
          usage: session.usage,
          started_at: session.started_at,
          ended_at: session.ended_at,
          latency_ms: session.latency_ms
        }];
    const multipleModels = groups.length > 1;
    const migratedRunId = migrateLegacyClaudeRun({ store, session, groups });

    for (const group of groups) {
      const runId = runIdForSession(session.session_id, group.model);
      const runDir = path.join(store.runsRoot, runId);
      if (fs.existsSync(runDir)) {
        const migratedCurrentRun = migratedRunId === runId;
        const shouldRefresh = refresh
          || (migratedCurrentRun
            ? multipleModels
            : claudeRunNeedsRefresh(runDir, { runId, session, group }));
        if (!shouldRefresh) continue;
        fs.rmSync(runDir, { recursive: true, force: true });
      }
      const providerSnapshot = priceSnapshots?.[session.provider] || priceSnapshot;
      const price = findModelPrice(providerSnapshot, group.model, session.provider);
      const cost = calculateCostUsd(group.usage, {
        inputPricePerMillion: price?.input_price_per_million,
        outputPricePerMillion: price?.output_price_per_million
      });

      store.createRun({
        schema_version: 1,
        run_id: runId,
        title: `Claude Code session ${session.session_id}${multipleModels ? ` (${group.model || "unknown"})` : ""}`,
        task_type: "unknown",
        project: session.cwd,
        expected: "",
        task_family: "unknown",
        repo_language: null,
        tool_profile: null,
        context_size_bucket: null,
        source: "claude-session-jsonl",
        session_id: session.session_id,
        session_file: session.session_file,
        model: group.model,
        started_at: group.started_at || session.started_at
      }, {
        schema_version: 1,
        run_id: runId,
        event: "run_started",
        timestamp: group.started_at || session.started_at || new Date().toISOString(),
        role: "main",
        provider: session.provider,
        provider_verified: session.provider_verified,
        model: group.model
      });
      store.appendEvent(runId, {
        schema_version: 1,
        run_id: runId,
        event: "agent_finished",
        timestamp: group.ended_at || session.ended_at || new Date().toISOString(),
        task_id: session.session_id,
        task_family: "unknown",
        role: session.role,
        model: group.model,
        provider: session.provider,
        provider_verified: session.provider_verified,
        deployment: group.model,
        status: session.status,
        latency_ms: group.latency_ms,
        input_tokens: group.usage.input_tokens,
        output_tokens: group.usage.output_tokens,
        total_tokens: group.usage.total_tokens,
        cost_usd: cost,
        regression: null,
        failure_mode: session.status === "failed" ? "session_error" : null,
        evidence: [`claude-session:${session.session_id}${multipleModels ? `:${group.model || "unknown"}` : ""}`],
        note: "passive ingestion from Claude Code session JSONL; metadata only"
      });
      ingested.push({ run_id: runId, model: group.model, model_group: group, session });
    }
  }
  return ingested;
}
