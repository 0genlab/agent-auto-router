#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCodexRoleRunCli } from "../adapters/codex/role-run.mjs";
import { runRecordedCommand } from "../adapters/codex/command-runner.mjs";
import { createRoleRunStore } from "../adapters/jsonl/role-run-store.mjs";
import { createObjectiveEvaluator } from "../adapters/command/objective-evaluator.mjs";
import { findModelPrice } from "../src/core/model-pricing.mjs";
import { joinEvaluations, metrics } from "../src/core/role-policy.mjs";

const execFileAsync = promisify(execFile);

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function commandSpec(value, name) {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value;
}

function interpolate(value, variables) {
  return value.replace(/\{(model|prompt|project|task_id)\}/g, (_, key) => String(variables[key] ?? ""));
}

function buildCommand(task, model) {
  const command = commandSpec(task.command, "task.command");
  const variables = {
    model,
    prompt: task.prompt,
    project: task.project,
    task_id: task.id
  };
  return {
    command: interpolate(command[0], variables),
    args: command.slice(1).map((arg) => interpolate(arg, variables))
  };
}

function buildRecordArgs(task, model) {
  return [
    "--task-id", task.id,
    "--task-family", task.task_family || task.type || "unknown",
    "--repo-language", task.repo_language || "",
    "--tool-profile", task.tool_profile || "",
    "--context-size-bucket", task.context_size_bucket || "",
    "--provider", task.provider || "aihubmix",
    "--deployment", model
  ];
}

async function evaluateRun({ store, runId, task, project }) {
  const evaluator = createObjectiveEvaluator({
    async runCommand({ command, args = [], cwd }) {
      try {
        const result = await execFileAsync(command, args, { cwd, maxBuffer: 1024 * 1024 });
        return { exitCode: 0, signal: null, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return {
          exitCode: typeof error.code === "number" ? error.code : 1,
          signal: error.signal || null,
          stdout: error.stdout || "",
          stderr: error.stderr || ""
        };
      }
    }
  });
  const events = store.readEvents().filter((event) => event.run_id === runId && event.event === "agent_finished");
  const latest = events.at(-1);
  if (!latest) throw new Error(`agent_finished event not found: ${runId}`);
  const evaluation = task.test_command
    ? await evaluator.evaluate({
      cwd: project,
      test: { command: task.test_command[0], args: task.test_command.slice(1) },
      regression: task.regression_command
        ? { command: task.regression_command[0], args: task.regression_command.slice(1) }
        : null,
      diff: task.diff_check !== false,
      run: latest
    })
    : {
      event: "evaluation_finished",
      evaluator: "objective-command",
      evaluation_status: "not_configured",
      quality_score: null,
      quality_confidence: 0,
      quality_components: {},
      evidence: []
    };
  store.appendEvent(runId, {
    schema_version: 1,
    run_id: runId,
    role: latest.role,
    model: latest.model,
    timestamp: new Date().toISOString(),
    ...evaluation
  });
  return evaluation;
}

async function main() {
  const args = process.argv.slice(2);
  const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
  const task = readJson(required(args, "--task"));
  const role = option(args, "--role", task.role);
  const models = (option(args, "--models", task.models?.join(",")) || "").split(",").map((model) => model.trim()).filter(Boolean);
  if (!role) throw new Error("missing --role or task.role");
  if (!models.length) throw new Error("missing --models or task.models");
  if (!task.id || !task.prompt || !task.command) throw new Error("task requires id, prompt, and command");
  const project = option(args, "--project", task.project || process.cwd());
  const runsRoot = path.join(root, "data", "role-runs");
  const store = createRoleRunStore(runsRoot);
  const cli = createCodexRoleRunCli({ root });
  const snapshotPath = option(args, "--price-snapshot", process.env.ROLEBENCH_PRICE_SNAPSHOT || path.join(root, "data", "model-price-snapshot.json"));
  const priceSnapshot = snapshotPath && fs.existsSync(snapshotPath) ? readJson(snapshotPath) : null;
  const reportPath = option(args, "--report", path.join(root, "data", "experiments", `role-${role}-${task.id}-${Date.now()}.json`));
  const runs = [];

  for (const model of models) {
    const command = buildCommand(task, model);
    const result = await runRecordedCommand({
      cli,
      command: command.command,
      args: command.args,
      cwd: project,
      role,
      model,
      startArgs: [
        "--title", task.title || task.id,
        "--type", task.type || task.task_family || "unknown",
        "--project", project,
        "--expected", task.expected || "",
        "--task-family", task.task_family || task.type || "unknown",
        "--repo-language", task.repo_language || "",
        "--tool-profile", task.tool_profile || "",
        "--context-size-bucket", task.context_size_bucket || ""
      ],
      recordArgs: buildRecordArgs(task, model),
      usageFile: task.usage_file || null,
      priceSnapshot
    });
    const evaluation = await evaluateRun({ store, runId: result.runId, task, project });
    const events = joinEvaluations(store.readEvents().filter((event) => event.run_id === result.runId));
    const summary = metrics(events);
    runs.push({
      run_id: result.runId,
      task_id: task.id,
      model,
      status: result.status,
      evaluation_status: evaluation.evaluation_status,
      quality_score: evaluation.quality_score,
      quality_confidence: evaluation.quality_confidence,
      metrics: summary,
      pricing: findModelPrice(priceSnapshot, model)
    });
  }

  const report = {
    schema_version: 1,
    experiment_id: `${role}-${task.id}`,
    role,
    task: {
      id: task.id,
      title: task.title || task.id,
      task_family: task.task_family || task.type || "unknown",
      project,
      expected: task.expected || null
    },
    created_at: new Date().toISOString(),
    price_snapshot: snapshotPath || null,
    runs
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: reportPath, runs: runs.length, models }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
