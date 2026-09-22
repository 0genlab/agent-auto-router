import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { recommendRoles } from "../src/core/role-policy.mjs";
import { assertAdapter, createTaskProfile } from "../src/core/contracts.mjs";
import { createAihubmixModelCatalog } from "../adapters/aihubmix/model-catalog.mjs";
import { runRecordedCommand } from "../adapters/codex/command-runner.mjs";
import { createObjectiveEvaluator } from "../adapters/command/objective-evaluator.mjs";
import { calculateQualityScore } from "../src/core/quality-score.mjs";
import { calculateCostUsd, normalizeUsage } from "../src/core/usage-cost.mjs";
import { createPriceSnapshot, findModelPrice, normalizeModelPrice } from "../src/core/model-pricing.mjs";
import { parseSessionFile, ingestSessionFiles } from "../adapters/codex/session-ingest.mjs";
import { createRoleRunStore } from "../adapters/jsonl/role-run-store.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "scripts", "role-run.mjs");

function run(root, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ROLEBENCH_ROOT: root },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("records a role run and keeps recommendations in shadow mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "0genlab-role-run-"));
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "role-runs"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "configs", "role-policy.json"), path.join(root, "configs", "role-policy.json"));

  const runId = run(root, ["start", "--title", "test task", "--type", "implementation"]);
  run(root, ["record", "--run-id", runId, "--role", "implementer", "--model", "deepseek-v4.1-flash", "--status", "success", "--quality-score", "4", "--tests-run", "2", "--tests-passed", "2"]);
  const recommendation = JSON.parse(run(root, ["recommend"]));

  assert.equal(recommendation.mode, "shadow");
  assert.equal(recommendation.roles.find((role) => role.role === "implementer").recommended_model, "deepseek-v4.1-flash");
});

function finishedEvent({ role, model, taskId, quality, cost, latency = 100, status = "success", regression = false }) {
  return {
    event: "agent_finished",
    run_id: `${role}-${model}-${taskId}`,
    role,
    model,
    task_id: taskId,
    status,
    quality_score: quality,
    cost_usd: cost,
    latency_ms: latency,
    rework_count: 0,
    regression
  };
}

function loadPolicy() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "configs", "role-policy.json"), "utf8"));
}

test("requires the distinct-task candidate gate", () => {
  const policy = loadPolicy();
  const events = Array.from({ length: 10 }, (_, index) => finishedEvent({
    role: "implementer",
    model: "deepseek-v4.1-flash",
    taskId: "same-task",
    quality: 4.5,
    cost: 0.5,
    latency: 100 + index
  }));

  const role = recommendRoles(policy, events).find((item) => item.role === "implementer");
  const candidate = role.candidates.find((item) => item.model === "deepseek-v4.1-flash");
  assert.equal(candidate.eligible, false);
  assert.equal(role.eligible_for_candidate_pool, false);
});

test("auto-promotes only an objective, cheaper implementer candidate", () => {
  const policy = loadPolicy();
  const events = [];
  for (let index = 0; index < 30; index += 1) {
    const taskId = `task-${index % 5}`;
    events.push(finishedEvent({
      role: "implementer",
      model: "deepseek-v4.1-flash",
      taskId,
      quality: 4.4,
      cost: 1,
      latency: 100
    }));
    events.push(finishedEvent({
      role: "implementer",
      model: "deepseek-v4-pro",
      taskId,
      quality: 4.4,
      cost: 0.7,
      latency: 110
    }));
  }

  const role = recommendRoles(policy, events).find((item) => item.role === "implementer");
  assert.equal(role.recommended_model, "deepseek-v4-pro");
  assert.equal(role.eligible_for_auto_promote, true);
  assert.ok(Math.abs(role.comparison.cost_saving - 0.3) < 1e-9);
});

test("returns a Pareto frontier and validates adapter contracts", () => {
  const policy = loadPolicy();
  const events = [];
  for (let index = 0; index < 10; index += 1) {
    events.push(finishedEvent({ role: "explorer", model: "deepseek-v4.1-flash", taskId: `task-${index}`, quality: 4.1, cost: 0.5 }));
    events.push(finishedEvent({ role: "explorer", model: "deepseek-v4-pro", taskId: `task-${index}`, quality: 4.5, cost: 1 }));
  }
  const role = recommendRoles(policy, events).find((item) => item.role === "explorer");
  assert.deepEqual(role.pareto_frontier.sort(), ["deepseek-v4.1-flash", "deepseek-v4-pro"].sort());
  assert.deepEqual(createTaskProfile({ task_family: "debug", repo_language: "go" }), {
    task_family: "debug",
    repo_language: "go",
    tool_profile: null,
    context_size_bucket: null,
    failure_mode: null
  });
  assert.equal(assertAdapter("agent", { name: "test", run() {} }).name, "test");
});

test("loads the AIHubMix LLM catalog through an adapter", async () => {
  let requestedUrl = null;
  const catalog = createAihubmixModelCatalog({
    endpoint: "https://catalog.example/models",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, async json() { return { data: [{ model_id: "test-model" }] }; } };
    }
  });
  assert.deepEqual(await catalog.listModels(), [{ model_id: "test-model" }]);
  assert.equal(requestedUrl, "https://catalog.example/models?type=llm");
});

test("records the exit status and duration of a Codex-compatible command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "0genlab-codex-run-"));
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "role-runs"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "configs", "role-policy.json"), path.join(root, "configs", "role-policy.json"));
  const { createCodexRoleRunCli } = await import("../adapters/codex/role-run.mjs");
  const result = await runRecordedCommand({
    cli: createCodexRoleRunCli({ root }),
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: root,
    role: "implementer",
    model: "deepseek-v4.1-flash",
    startArgs: ["--title", "recorded command", "--type", "implementation"]
  });
  assert.equal(result.status, "success");
  const runDir = path.join(root, "data", "role-runs", result.runId);
  const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).status, "success");
  assert.ok(events.at(-1).latency_ms >= 0);
});

test("evaluates tests, regression, and diff without storing command output", async () => {
  const calls = [];
  const evaluator = createObjectiveEvaluator({
    async runCommand(spec) {
      calls.push(spec);
      if (spec.command === "npm") return { exitCode: 0, stdout: "8 tests passed", stderr: "" };
      if (spec.args?.[0] === "diff" && spec.args?.[1] === "--check") return { exitCode: 0, stdout: "", stderr: "" };
      if (spec.args?.[0] === "diff" && spec.args?.[1] === "--stat") return { exitCode: 0, stdout: " 2 files changed", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  });
  const result = await evaluator.evaluate({
    cwd: "/tmp/project",
    test: { command: "npm", args: ["test"] },
    regression: { command: "python3", args: ["regression_test.py"] }
  });
  assert.equal(result.evaluation_status, "success");
  assert.equal(result.tests_run, 8);
  assert.equal(result.tests_passed, 8);
  assert.equal(result.regression_failed, false);
  assert.equal(result.diff_clean, true);
  assert.equal(result.diff_stat, "2 files changed");
  assert.equal(Object.hasOwn(result, "stdout"), false);
  assert.equal(calls.length, 4);
});

test("calculates quality from objective evidence and reports confidence", () => {
  const complete = calculateQualityScore({
    run: { rework_count: 0, acceptance_status: "accepted" },
    evaluation: {
      tests_run: 8,
      tests_passed: 8,
      regression_failed: false,
      diff_clean: true
    }
  });
  assert.equal(complete.quality_score, 5);
  assert.equal(complete.quality_confidence, 1);

  const partial = calculateQualityScore({
    run: {},
    evaluation: { test: { exit_code: 1 } }
  });
  assert.equal(partial.quality_score, 0);
  assert.equal(partial.quality_confidence, 0.45);
  assert.equal(partial.quality_components.acceptance, null);
});

test("normalizes usage and calculates cost only from explicit prices", () => {
  const usage = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 250, total_tokens: 1250 });
  assert.deepEqual(usage, {
    api_calls: null,
    input_tokens: 1000,
    output_tokens: 250,
    total_tokens: 1250,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null
  });
  assert.equal(calculateCostUsd(usage), null);
  assert.equal(calculateCostUsd(usage, { inputPricePerMillion: 1, outputPricePerMillion: 2 }), 0.0015);
});

test("builds a model price snapshot with per-million-token prices", () => {
  const model = normalizeModelPrice({
    model_id: "test-model",
    model_name: "Test Model",
    pricing: { input: 0.5, output: 2 },
    retire_stage: "active"
  });
  const snapshot = createPriceSnapshot([model], { source: "test" });
  assert.equal(findModelPrice(snapshot, "test-model").input_price_per_million, 0.5);
  assert.equal(snapshot.pricing_unit, "per_million_tokens");
});

test("runs a multi-model role experiment and writes a comparison report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "0genlab-role-experiment-"));
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "role-runs"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "configs", "role-policy.json"), path.join(root, "configs", "role-policy.json"));
  const taskPath = path.join(root, "task.json");
  const reportPath = path.join(root, "report.json");
  fs.writeFileSync(taskPath, JSON.stringify({
    id: "smoke-001",
    title: "Smoke experiment",
    role: "implementer",
    type: "implementation",
    task_family: "implementation",
    project: root,
    prompt: "smoke",
    command: [process.execPath, "-e", "process.exit(0)"],
    test_command: [process.execPath, "-e", "console.log('2 tests passed')"],
    diff_check: false
  }));
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-role-experiment.mjs"),
    "--task", taskPath,
    "--models", "model-a,model-b",
    "--report", reportPath
  ], { cwd: repoRoot, env: { ...process.env, ROLEBENCH_ROOT: root }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.runs.length, 2);
  assert.deepEqual(report.runs.map((run) => run.model), ["model-a", "model-b"]);
  assert.equal(report.runs[0].evaluation_status, "success");
});

test("summarizes an experiment conservatively when evidence is insufficient", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "0genlab-role-summary-"));
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "configs", "role-policy.json"), path.join(root, "configs", "role-policy.json"));
  const reportPath = path.join(root, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    experiment_id: "implementer-smoke",
    role: "implementer",
    task: { id: "smoke-001" },
    runs: [
      { model: "cheap-model", status: "success", evaluation_status: "success", quality_score: 5, quality_confidence: 1, metrics: { cost_avg_usd: 0.1 } },
      { model: "strong-model", status: "success", evaluation_status: "success", quality_score: 4.5, quality_confidence: 1, metrics: { cost_avg_usd: 1 } }
    ]
  }));
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "summarize-experiment.mjs"), "--report", reportPath], {
    cwd: repoRoot,
    env: { ...process.env, ROLEBENCH_ROOT: root },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.recommendation_status, "insufficient_evidence");
  assert.equal(summary.recommended_model, null);
});

test("aggregates multiple experiment reports by distinct task", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "0genlab-role-reports-"));
  fs.mkdirSync(path.join(root, "configs"), { recursive: true });
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "configs", "role-policy.json"), path.join(root, "configs", "role-policy.json"));
  for (let taskIndex = 0; taskIndex < 3; taskIndex += 1) {
    fs.writeFileSync(path.join(root, "reports", `task-${taskIndex}.json`), JSON.stringify({
      experiment_id: `task-${taskIndex}`,
      role: "implementer",
      task: { id: `task-${taskIndex}` },
      runs: [
        {
          task_id: `task-${taskIndex}`,
          model: "cheap-model",
          status: "success",
          evaluation_status: "success",
          quality_score: 4.2,
          quality_confidence: 1,
          metrics: { cost_avg_usd: 0.1 }
        }
      ]
    }));
  }
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "summarize-experiment.mjs"), "--reports-dir", path.join(root, "reports")], {
    cwd: repoRoot,
    env: { ...process.env, ROLEBENCH_ROOT: root },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.tasks, ["task-0", "task-1", "task-2"]);
  assert.equal(summary.models[0].metrics.distinct_tasks, 3);
  assert.equal(summary.recommendation_status, "insufficient_evidence");
});

test("ingests Codex session metadata without copying conversation content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "0genlab-codex-session-"));
  const sessionPath = path.join(root, "session.jsonl");
  const records = [
    { timestamp: "2026-09-22T12:00:00.000Z", type: "session_meta", payload: { session_id: "session-1", cwd: root, source: { subagent: "review" }, model_provider: "aihubmix" } },
    { timestamp: "2026-09-22T12:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol", cwd: root } },
    { timestamp: "2026-09-22T12:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "secret prompt" } },
    { timestamp: "2026-09-22T12:00:03.000Z", type: "event_msg", payload: { type: "agent_message", message: "secret response" } },
    { timestamp: "2026-09-22T12:00:04.000Z", type: "token_usage_record", payload: { response_id: "response-1", usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 } } }
  ];
  fs.writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const parsed = parseSessionFile(sessionPath);
  assert.equal(parsed.role, "reviewer");
  assert.equal(parsed.model, "gpt-5.6-sol");
  assert.equal(parsed.usage.total_tokens, 1500);
  assert.equal(Object.hasOwn(parsed, "prompt"), false);
  const store = createRoleRunStore(path.join(root, "runs"));
  const ingested = ingestSessionFiles({
    files: [sessionPath],
    store,
    priceSnapshot: createPriceSnapshot([{ model_id: "gpt-5.6-sol", pricing: { input: 1, output: 2 } }])
  });
  assert.equal(ingested.length, 1);
  const events = store.readEvents();
  const finished = events.find((event) => event.event === "agent_finished");
  assert.equal(finished.role, "reviewer");
  assert.equal(finished.cost_usd, 0.002);
  assert.equal(finished.note, "passive ingestion from Codex session JSONL");
});

test("keeps missing session usage and cost as null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "0genlab-codex-no-usage-"));
  const sessionPath = path.join(root, "session.jsonl");
  fs.writeFileSync(sessionPath, `${JSON.stringify({ timestamp: "2026-09-22T12:00:00.000Z", type: "session_meta", payload: { session_id: "session-no-usage", cwd: root, model_provider: "aihubmix" } })}\n`);
  const store = createRoleRunStore(path.join(root, "runs"));
  ingestSessionFiles({ files: [sessionPath], store, priceSnapshot: createPriceSnapshot([{ model_id: "unknown", pricing: { input: 1, output: 1 } }]) });
  const finished = store.readEvents().find((event) => event.event === "agent_finished");
  assert.equal(finished.input_tokens, null);
  assert.equal(finished.output_tokens, null);
  assert.equal(finished.cost_usd, null);
});

test("deduplicates repeated files for the same Codex session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "0genlab-codex-duplicate-"));
  const sessionPath = path.join(root, "session.jsonl");
  fs.writeFileSync(sessionPath, `${JSON.stringify({ timestamp: "2026-09-22T12:00:00.000Z", type: "session_meta", payload: { session_id: "same-session", cwd: root } })}\n`);
  const store = createRoleRunStore(path.join(root, "runs"));
  const result = ingestSessionFiles({ files: [sessionPath, sessionPath], store });
  assert.equal(result.length, 1);
  assert.equal(store.readEvents().filter((event) => event.event === "agent_finished").length, 1);
});
