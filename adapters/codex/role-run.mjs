import path from "node:path";
import process from "node:process";
import { createRoleRunStore } from "../jsonl/role-run-store.mjs";
import { recommendRoles } from "../../src/core/role-policy.mjs";
import { createTaskProfile } from "../../src/core/contracts.mjs";
import fs from "node:fs";

export function createCodexRoleRunCli({ root, now = () => new Date().toISOString(), pid = process.pid } = {}) {
  const workspaceRoot = root || process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "../..");
  const runsRoot = path.join(workspaceRoot, "data", "role-runs");
  const policyPath = path.join(workspaceRoot, "configs", "role-policy.json");
  const store = createRoleRunStore(runsRoot);

  function option(args, name, fallback = null) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  }

  function required(args, name) {
    const value = option(args, name);
    if (!value) throw new Error(`missing ${name}`);
    return value;
  }

  function numberOrNull(value) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`invalid number: ${value}`);
    return parsed;
  }

  function start(args) {
    const title = required(args, "--title");
    const runId = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${pid}`;
    store.createRun({
      schema_version: 1,
      run_id: runId,
      title,
      task_type: option(args, "--type", "unknown"),
      project: option(args, "--project", process.cwd()),
      expected: option(args, "--expected", ""),
      ...createTaskProfile({
        task_family: option(args, "--task-family", "unknown"),
        repo_language: option(args, "--repo-language", null),
        tool_profile: option(args, "--tool-profile", null),
        context_size_bucket: option(args, "--context-size-bucket", null)
      }),
      started_at: now()
    }, {
      schema_version: 1,
      run_id: runId,
      event: "run_started",
      timestamp: now(),
      role: "main",
      model: null
    });
    return runId;
  }

  function record(args) {
    const runId = required(args, "--run-id");
    const role = required(args, "--role");
    const model = required(args, "--model");
    store.appendEvent(runId, {
      schema_version: 1,
      run_id: runId,
      event: option(args, "--event", "agent_finished"),
      timestamp: now(),
      task_id: option(args, "--task-id", null),
      task_family: option(args, "--task-family", null),
      repo_language: option(args, "--repo-language", null),
      tool_profile: option(args, "--tool-profile", null),
      context_size_bucket: option(args, "--context-size-bucket", null),
      role,
      model,
      provider: option(args, "--provider", null),
      deployment: option(args, "--deployment", null),
      status: option(args, "--status", "unknown"),
      quality_score: numberOrNull(option(args, "--quality-score", "")),
      tests_run: numberOrNull(option(args, "--tests-run", "")),
      tests_passed: numberOrNull(option(args, "--tests-passed", "")),
      retry_count: numberOrNull(option(args, "--retry-count", "")),
      rework_count: numberOrNull(option(args, "--rework-count", "")),
      latency_ms: numberOrNull(option(args, "--latency-ms", "")),
      input_tokens: numberOrNull(option(args, "--input-tokens", "")),
      output_tokens: numberOrNull(option(args, "--output-tokens", "")),
      total_tokens: numberOrNull(option(args, "--total-tokens", "")),
      cost_usd: numberOrNull(option(args, "--cost-usd", "")),
      acceptance_status: option(args, "--acceptance", null),
      regression: option(args, "--regression", "false") === "true",
      failure_mode: option(args, "--failure-mode", null),
      evidence: option(args, "--evidence", ""),
      note: option(args, "--note", "")
    });
  }

  return {
    start,
    record,
    recommend() {
      const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
      return { schema_version: 1, mode: policy.mode, thresholds: policy.candidate_gate, roles: recommendRoles(policy, store.readEvents()) };
    }
  };
}
