#!/usr/bin/env node

import { promisify } from "node:util";
import { execFile } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { createRoleRunStore } from "../adapters/jsonl/role-run-store.mjs";
import { createObjectiveEvaluator } from "../adapters/command/objective-evaluator.mjs";

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

function commandSpec(value, flag) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => typeof item !== "string")) throw new Error();
    return { command: parsed[0], args: parsed.slice(1) };
  } catch {
    throw new Error(`${flag} must be a JSON command array, for example '["npm","test"]'`);
  }
}

const args = process.argv.slice(2);
const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
const runId = required(args, "--run-id");
const runsRoot = path.join(root, "data", "role-runs");
const store = createRoleRunStore(runsRoot);
const test = commandSpec(required(args, "--test-command"), "--test-command");
const regressionValue = option(args, "--regression-command", null);
const regression = regressionValue ? commandSpec(regressionValue, "--regression-command") : null;
const cwd = option(args, "--project", process.cwd());

const evaluator = createObjectiveEvaluator({
  async runCommand({ command, args: commandArgs = [], cwd: commandCwd }) {
    try {
      const result = await execFileAsync(command, commandArgs, { cwd: commandCwd, maxBuffer: 1024 * 1024 });
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

try {
  const events = store.readEvents().filter((event) => event.run_id === runId && event.event === "agent_finished");
  const latest = events.at(-1);
  if (!latest) throw new Error(`agent_finished event not found: ${runId}`);
  const evaluation = await evaluator.evaluate({ cwd, test, regression, run: latest, diff: option(args, "--skip-diff", "false") !== "true" });
  store.appendEvent(runId, {
    schema_version: 1,
    run_id: runId,
    role: latest.role,
    model: latest.model,
    timestamp: new Date().toISOString(),
    ...evaluation
  });
  console.log(JSON.stringify({ run_id: runId, ...evaluation }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
