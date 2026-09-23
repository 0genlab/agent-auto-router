#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClaudeHostAdapter } from "../adapters/claude/host.mjs";
import { createHermesHostAdapter, loadHermesCatalog } from "../adapters/hermes/host.mjs";
import { createRoleRunStore } from "../adapters/jsonl/role-run-store.mjs";
import { createTaskProfile } from "../src/core/contracts.mjs";
import { normalizeUsage } from "../src/core/usage-cost.mjs";

const validRoles = new Set(["main", "planner", "researcher", "explorer", "implementer", "e2e", "reviewer"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateUsagePayload(raw) {
  const usageObject = isPlainObject(raw.usage) ? raw.usage : raw;
  const tokenFields = [
    "input_tokens",
    "prompt_tokens",
    "input",
    "output_tokens",
    "completion_tokens",
    "output",
    "total_tokens",
    "cache_read_tokens",
    "cached_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "api_calls",
    "cost_usd",
    "estimated_cost_usd"
  ];
  const invalidField = tokenFields.some((field) => {
    if (!Object.hasOwn(usageObject, field)) return false;
    const value = usageObject[field];
    if (value === null || value === undefined || value === "") return false;
    if (typeof value !== "number" && typeof value !== "string") return true;
    return !Number.isFinite(Number(value));
  });
  const usage = normalizeUsage(raw);
  const actualCost = usageObject.cost_usd;
  usage.cost_usd = actualCost === null || actualCost === undefined || actualCost === ""
    ? null
    : Number.isFinite(Number(actualCost)) ? Number(actualCost) : null;
  const hasTokenCount = [
    usage.input_tokens,
    usage.output_tokens,
    usage.total_tokens,
    usage.cache_read_tokens,
    usage.cache_write_tokens
  ].some((value) => value !== null);
  return {
    usage,
    estimated_cost_usd: Object.hasOwn(usageObject, "estimated_cost_usd")
      && usageObject.estimated_cost_usd !== null && usageObject.estimated_cost_usd !== ""
      ? Number(usageObject.estimated_cost_usd)
      : null,
    invalid: invalidField || !hasTokenCount
  };
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function parseCliArgs(args) {
  const valueOptions = new Set([
    "--host",
    "--role",
    "--provider",
    "--model",
    "--prompt-file",
    "--cwd",
    "--root",
    "--title",
    "--type",
    "--expected",
    "--task-family",
    "--repo-language",
    "--tool-profile",
    "--context-size-bucket",
    "--max-budget-usd",
    "--claude-home",
    "--hermes-home"
  ]);
  const flagOptions = new Set(["--execute", "--dry-run"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (valueOptions.has(argument)) {
      index += 1;
      if (!args[index] || args[index].startsWith("--")) throw new Error(`missing value for ${argument}`);
    } else if (!flagOptions.has(argument)) {
      throw new Error(`unknown option: ${argument}`);
    }
  }

  const promptFile = option(args, "--prompt-file");
  const prompt = promptFile
    ? fs.readFileSync(promptFile === "-" ? 0 : promptFile, "utf8")
    : process.stdin.isTTY
      ? null
      : fs.readFileSync(0, "utf8");
  if (!prompt) throw new Error("missing --prompt or --prompt-file");

  const parsed = {
    host: option(args, "--host"),
    role: option(args, "--role"),
    provider: option(args, "--provider"),
    model: option(args, "--model"),
    prompt,
    cwd: path.resolve(option(args, "--cwd", process.cwd())),
    root: option(args, "--root", process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..")),
    title: option(args, "--title", "Host stage run"),
    type: option(args, "--type", "unknown"),
    expected: option(args, "--expected", ""),
    taskFamily: option(args, "--task-family", "unknown"),
    repoLanguage: option(args, "--repo-language", null),
    toolProfile: option(args, "--tool-profile", null),
    contextSizeBucket: option(args, "--context-size-bucket", null),
    maxBudgetUsd: option(args, "--max-budget-usd", null),
    claudeHome: option(args, "--claude-home"),
    hermesHome: option(args, "--hermes-home"),
    execute: args.includes("--execute")
  };
  if (parsed.execute && args.includes("--dry-run")) throw new Error("--execute and --dry-run cannot be combined");
  if (!parsed.host) throw new Error("missing --host");
  if (!parsed.role) throw new Error("missing --role");
  if (!parsed.provider) throw new Error("missing --provider");
  if (!parsed.model) throw new Error("missing --model");
  if (!validRoles.has(parsed.role)) throw new Error(`unknown role: ${parsed.role}`);
  return parsed;
}

function redactedCommand(command, prompt) {
  const args = [...command.args];
  const promptIndex = args.lastIndexOf(prompt);
  if (promptIndex >= 0) args[promptIndex] = `<prompt:${Buffer.byteLength(prompt)} bytes>`;
  const usageIndex = args.indexOf("--usage-file");
  if (usageIndex >= 0 && args[usageIndex + 1]) args[usageIndex + 1] = "<temporary-usage-file>";
  return { command: command.command, args };
}

export function prepareHostStage({
  host,
  role,
  provider,
  model,
  prompt,
  cwd = process.cwd(),
  maxBudgetUsd = null,
  claudeHome,
  hermesHome,
  claudeAdapter,
  hermesAdapter
}) {
  if (!validRoles.has(role)) throw new Error(`unknown role: ${role}`);
  const resolvedCwd = path.resolve(cwd);
  const resolvedClaudeHome = claudeHome ? path.resolve(claudeHome) : undefined;
  const resolvedHermesHome = hermesHome ? path.resolve(hermesHome) : undefined;
  const adapter = host === "claude" || host === "claude-code"
    ? claudeAdapter || createClaudeHostAdapter({ claudeHome: resolvedClaudeHome })
    : host === "hermes"
      ? hermesAdapter || createHermesHostAdapter({
          catalog: resolvedHermesHome ? loadHermesCatalog({ homeDir: resolvedHermesHome }) : undefined
        })
      : null;
  if (!adapter) throw new Error(`unknown host: ${host}`);
  const validated = adapter.validateRequest({ provider, model });
  const command = adapter.buildCommand({ ...validated, prompt, cwd: resolvedCwd, maxBudgetUsd });
  const configEnv = host === "claude" || host === "claude-code"
    ? resolvedClaudeHome ? { CLAUDE_CONFIG_DIR: resolvedClaudeHome } : null
    : host === "hermes" && resolvedHermesHome
      ? { HERMES_HOME: resolvedHermesHome }
      : null;
  const rawCommand = configEnv ? { ...command, env: { ...command.env, ...configEnv } } : command;
  return {
    host: adapter.name,
    role,
    provider: validated.provider,
    model: validated.model,
    provider_verified: validated.provider_verified,
    audit_only: validated.audit_only,
    provider_evidence: validated.provider_evidence,
    execute: false,
    prompt_bytes: Buffer.byteLength(prompt),
    command: redactedCommand(command, prompt),
    raw_command: rawCommand
  };
}

function runIdFor(now, uuid) {
  return `${now().replace(/[-:TZ.]/g, "").slice(0, 14)}-${uuid()}`;
}

export async function executeHostStage({
  prepared,
  root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, ".."),
  title = "Host stage run",
  type = "unknown",
  expected = "",
  taskFamily = "unknown",
  repoLanguage = null,
  toolProfile = null,
  contextSizeBucket = null,
  cwd = process.cwd(),
  spawnImpl = spawn,
  now = () => new Date().toISOString(),
  uuid = randomUUID,
  usageFile: explicitUsageFile = null
}) {
  const runId = runIdFor(now, uuid);
  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  store.createRun({
    schema_version: 1,
    run_id: runId,
    title,
    task_type: type,
    project: cwd,
    expected,
    ...createTaskProfile({
      task_family: taskFamily,
      repo_language: repoLanguage,
      tool_profile: toolProfile,
      context_size_bucket: contextSizeBucket
    }),
    source: "host-stage",
    host: prepared.host,
    provider_verified: prepared.provider_verified,
    audit_only: prepared.audit_only,
    started_at: now()
  }, {
    schema_version: 1,
    run_id: runId,
    event: "run_started",
    timestamp: now(),
    role: prepared.role,
    provider: prepared.provider,
    model: prepared.model
  });

  const usageFile = explicitUsageFile || prepared.usage_file || null;
  const removeUsageFile = Boolean(usageFile && !explicitUsageFile);
  const resolvedCwd = path.resolve(cwd);
  const startedAt = Date.now();
  const stdin = prepared.raw_command.stdin ?? null;
  const childEnv = prepared.raw_command.env
    ? { ...process.env, ...prepared.raw_command.env }
    : process.env;
  const result = await new Promise((resolve, reject) => {
    const child = spawnImpl(prepared.raw_command.command, prepared.raw_command.args, {
      cwd: resolvedCwd,
      stdio: [stdin === null ? "inherit" : "pipe", "inherit", "inherit"],
      env: childEnv
    });
    if (stdin !== null && child.stdin) child.stdin.end(stdin);
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  }).catch((error) => ({ error }));

  let usage = normalizeUsage({});
  let estimatedCostUsd = null;
  let usageInvalid = false;
  if (usageFile && fs.existsSync(usageFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(usageFile, "utf8"));
      if (!isPlainObject(parsed)) {
        usageInvalid = true;
      } else {
        const validated = validateUsagePayload(parsed);
        usage = validated.usage;
        estimatedCostUsd = validated.estimated_cost_usd;
        usageInvalid = validated.invalid;
      }
    } catch {
      usageInvalid = true;
    } finally {
      if (removeUsageFile) fs.rmSync(usageFile, { force: true });
    }
  }
  const hostSucceeded = !result.error && result.exitCode === 0;
  const status = hostSucceeded && !usageInvalid ? "success" : "failed";
  const latencyMs = Date.now() - startedAt;
  const note = usageInvalid
    ? "usage_invalid"
    : result.error
      ? "host_spawn_error"
      : result.signal
        ? "host_terminated_by_signal"
        : result.exitCode === 0
          ? "host_completed"
          : "host_exit_nonzero";
  store.appendEvent(runId, {
    schema_version: 1,
    run_id: runId,
    event: "agent_finished",
    timestamp: now(),
    task_id: runId,
    task_family: taskFamily,
    repo_language: repoLanguage,
    tool_profile: toolProfile,
    context_size_bucket: contextSizeBucket,
    role: prepared.role,
    model: prepared.model,
    provider: prepared.provider,
    provider_verified: prepared.provider_verified,
    audit_only: prepared.audit_only,
    deployment: prepared.model,
    status,
    latency_ms: latencyMs,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    cost_usd: usage.cost_usd ?? null,
    estimated_cost_usd: estimatedCostUsd,
    regression: null,
    failure_mode: usageInvalid ? "usage_invalid" : status === "failed" ? "host_exit" : null,
    evidence: [`host-stage:${prepared.host}`],
    note
  });
  return {
    run_id: runId,
    status,
    exit_code: result.exitCode ?? null,
    signal: result.signal || null,
    latency_ms: latencyMs
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const prepared = prepareHostStage(options);
  if (!options.execute) {
    const { raw_command: _rawCommand, ...preview } = prepared;
    console.log(JSON.stringify(preview, null, 2));
    return;
  }
  const result = await executeHostStage({
    prepared,
    root: options.root,
    title: options.title,
    type: options.type,
    expected: options.expected,
    taskFamily: options.taskFamily,
    repoLanguage: options.repoLanguage,
    toolProfile: options.toolProfile,
    contextSizeBucket: options.contextSizeBucket,
    cwd: options.cwd
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "success") process.exitCode = result.exit_code > 0 ? result.exit_code : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
