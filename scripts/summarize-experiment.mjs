#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function average(values) {
  const present = values.filter((value) => Number.isFinite(value));
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function summarizeRuns(runs, policy) {
  const grouped = new Map();
  for (const run of runs) {
    const current = grouped.get(run.model) || [];
    current.push(run);
    grouped.set(run.model, current);
  }
  const gate = policy.candidate_gate;
  const models = [...grouped.entries()].map(([model, modelRuns]) => {
    const successful = modelRuns.filter((run) => run.status === "success" && run.evaluation_status === "success").length;
    const metrics = {
      samples: modelRuns.length,
      distinct_tasks: new Set(modelRuns.map((run) => run.task_id || run.experiment_id).filter(Boolean)).size,
      success_rate: modelRuns.length ? successful / modelRuns.length : null,
      quality_avg: average(modelRuns.map((run) => run.quality_score ?? run.metrics?.quality_avg)),
      quality_confidence_avg: average(modelRuns.map((run) => run.quality_confidence)),
      latency_avg_ms: average(modelRuns.map((run) => run.metrics?.latency_avg_ms)),
      cost_avg_usd: average(modelRuns.map((run) => run.metrics?.cost_avg_usd)),
      input_tokens_avg: average(modelRuns.map((run) => run.metrics?.input_tokens_avg)),
      output_tokens_avg: average(modelRuns.map((run) => run.metrics?.output_tokens_avg)),
      rework_avg: average(modelRuns.map((run) => run.metrics?.rework_avg)),
      regression_rate: average(modelRuns.map((run) => run.metrics?.regression_rate))
    };
    const eligible = metrics.samples >= gate.min_samples_per_model
      && metrics.success_rate >= gate.min_success_rate
      && metrics.quality_avg >= gate.min_quality_score
      && metrics.distinct_tasks >= gate.min_distinct_tasks;
    return { model, eligible_for_candidate_pool: eligible, metrics };
  }).sort((left, right) => (right.metrics.quality_avg ?? -1) - (left.metrics.quality_avg ?? -1)
    || (left.metrics.cost_avg_usd ?? Number.POSITIVE_INFINITY) - (right.metrics.cost_avg_usd ?? Number.POSITIVE_INFINITY));
  const eligible = models.filter((model) => model.eligible_for_candidate_pool && model.metrics.cost_avg_usd !== null);
  return {
    models,
    recommended_model: eligible.sort((left, right) => left.metrics.cost_avg_usd - right.metrics.cost_avg_usd)[0]?.model || null,
    recommendation_status: eligible.length ? "candidate" : "insufficient_evidence"
  };
}

function reportPaths(args, root) {
  const direct = option(args, "--report", null);
  const many = option(args, "--reports", null);
  const directory = option(args, "--reports-dir", null);
  const paths = [
    ...(direct ? [direct] : []),
    ...(many ? many.split(",").map((item) => item.trim()).filter(Boolean) : []),
    ...(directory && fs.existsSync(directory)
      ? fs.readdirSync(directory).filter((file) => file.endsWith(".json")).sort().map((file) => path.join(directory, file))
      : [])
  ];
  const unique = [...new Set(paths)];
  if (!unique.length) throw new Error("missing --report, --reports, or --reports-dir");
  return unique.map((file) => ({ path: file, report: JSON.parse(fs.readFileSync(file, "utf8")) }));
}

const args = process.argv.slice(2);
try {
  const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
  const policyPath = option(args, "--policy", path.join(root, "configs", "role-policy.json"));
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const reports = reportPaths(args, root);
  const report = reports[0].report;
  const runs = reports.flatMap(({ report: current }) => current.runs || []);
  const summary = {
    schema_version: 1,
    reports: reports.map(({ path: reportPath }) => reportPath),
    experiment_ids: reports.map(({ report: current }) => current.experiment_id),
    role: report.role,
    task: report.task,
    tasks: [...new Set(runs.map((run) => run.task_id).filter(Boolean))],
    ...summarizeRuns(runs, policy)
  };
  const output = option(args, "--output", null);
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serialized);
  }
  process.stdout.write(serialized);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
