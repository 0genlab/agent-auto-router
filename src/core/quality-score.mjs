const weights = Object.freeze({
  tests: 0.45,
  regression: 0.2,
  diff: 0.15,
  rework: 0.1,
  acceptance: 0.1
});

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function bounded(value) {
  return Math.max(0, Math.min(1, value));
}

function testsScore(evaluation) {
  const run = finite(evaluation?.tests_run);
  const passed = finite(evaluation?.tests_passed);
  if (run !== null && run > 0 && passed !== null) return bounded(passed / run);
  if (evaluation?.test?.exit_code === 0) return 1;
  if (evaluation?.test?.exit_code !== null && evaluation?.test?.exit_code !== undefined) return 0;
  return null;
}

function acceptanceScore(status) {
  if (status === "accepted" || status === true) return 1;
  if (status === "rejected" || status === false) return 0;
  return null;
}

export function calculateQualityScore({ evaluation = {}, run = {} } = {}) {
  const components = {
    tests: testsScore(evaluation),
    regression: evaluation.regression_failed === true ? 0 : evaluation.regression_failed === false ? 1 : null,
    diff: evaluation.diff_clean === true ? 1 : evaluation.diff_clean === false ? 0 : null,
    rework: finite(run.rework_count) === null
      ? null
      : bounded(1 - Math.min(1, Math.max(0, finite(run.rework_count)) / 3)),
    acceptance: acceptanceScore(run.acceptance_status)
  };
  const available = Object.entries(components).filter(([, value]) => value !== null);
  if (!available.length) return { quality_score: null, quality_confidence: 0, quality_components: components };
  const weightTotal = available.reduce((sum, [name]) => sum + weights[name], 0);
  const weightedScore = available.reduce((sum, [name, value]) => sum + weights[name] * value, 0) / weightTotal;
  return {
    quality_score: Math.round(weightedScore * 500) / 100,
    quality_confidence: Math.round(weightTotal * 100) / 100,
    quality_components: components
  };
}
