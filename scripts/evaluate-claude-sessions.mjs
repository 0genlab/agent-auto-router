#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { createRoleRunStore } from "../adapters/jsonl/role-run-store.mjs";
import { evaluateClaudeRuns } from "../adapters/claude/session-evaluation.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function options(args, name) {
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]] : []));
}

try {
  const args = process.argv.slice(2);
  const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  const runIds = options(args, "--run-id");
  const written = evaluateClaudeRuns({
    store,
    runIds: runIds.length ? runIds : null,
    sessionId: option(args, "--session-id", null),
    ...(args.includes("--skip-github") ? { prInfo: () => null } : {})
  });
  console.log(JSON.stringify({
    evaluated: written.length,
    runs: written.map((event) => ({
      run_id: event.run_id,
      model: event.model,
      role: event.role,
      quality_score: event.quality_score,
      acceptance_status: event.acceptance_status,
      rework_count: event.rework_count,
      last_check_exit_code: event.test?.exit_code ?? null
    }))
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
