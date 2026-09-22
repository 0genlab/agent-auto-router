export function average(values) {
  const present = values.filter((value) => Number.isFinite(value));
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

export function percentile(values, percentileValue) {
  const present = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!present.length) return null;
  const index = Math.min(present.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * present.length) - 1));
  return present[index];
}

export function metrics(events) {
  const finished = events.filter((event) => event.event === "agent_finished");
  const successes = finished.filter((event) => event.status === "success").length;
  return {
    samples: finished.length,
    distinct_tasks: new Set(finished.map((event) => event.task_id).filter(Boolean)).size,
    success_rate: finished.length ? successes / finished.length : null,
    quality_avg: average(finished.map((event) => event.quality_score)),
    latency_avg_ms: average(finished.map((event) => event.latency_ms)),
    latency_p95_ms: percentile(finished.map((event) => event.latency_ms), 95),
    input_tokens_avg: average(finished.map((event) => event.input_tokens)),
    output_tokens_avg: average(finished.map((event) => event.output_tokens)),
    total_tokens_avg: average(finished.map((event) => event.total_tokens)),
    cost_avg_usd: average(finished.map((event) => event.cost_usd)),
    rework_avg: average(finished.map((event) => event.rework_count)),
    regression_rate: finished.length
      ? finished.filter((event) => event.regression === true).length / finished.length
      : null
  };
}

export function joinEvaluations(events) {
  const evaluations = new Map();
  for (const event of events) {
    if (event.event !== "evaluation_finished") continue;
    evaluations.set(`${event.run_id}:${event.role}:${event.model}`, event);
  }
  return events
    .filter((event) => event.event === "agent_finished")
    .map((event) => {
      const evaluation = evaluations.get(`${event.run_id}:${event.role}:${event.model}`);
      return evaluation ? { ...event, quality_score: evaluation.quality_score } : event;
    });
}

function passesCandidateGate(summary, gate) {
  return summary.samples >= gate.min_samples_per_model
    && summary.success_rate >= gate.min_success_rate
    && summary.quality_avg >= gate.min_quality_score
    && summary.distinct_tasks >= gate.min_distinct_tasks;
}

function dominates(left, right) {
  const noWorse = left.metrics.quality_avg >= right.metrics.quality_avg
    && left.metrics.success_rate >= right.metrics.success_rate
    && left.metrics.cost_avg_usd <= right.metrics.cost_avg_usd
    && left.metrics.latency_p95_ms <= right.metrics.latency_p95_ms
    && left.metrics.regression_rate <= right.metrics.regression_rate
    && left.metrics.rework_avg <= right.metrics.rework_avg;
  const strictlyBetter = left.metrics.quality_avg > right.metrics.quality_avg
    || left.metrics.success_rate > right.metrics.success_rate
    || left.metrics.cost_avg_usd < right.metrics.cost_avg_usd
    || left.metrics.latency_p95_ms < right.metrics.latency_p95_ms
    || left.metrics.regression_rate < right.metrics.regression_rate
    || left.metrics.rework_avg < right.metrics.rework_avg;
  return noWorse && strictlyBetter;
}

function paretoFrontier(candidates) {
  return candidates
    .filter((candidate) => !candidates.some((other) => other.model !== candidate.model && dominates(other, candidate)))
    .map((candidate) => candidate.model);
}

function comparison(candidate, baseline, gate) {
  const costSaving = baseline.cost_avg_usd > 0 && candidate.cost_avg_usd !== null
    ? 1 - candidate.cost_avg_usd / baseline.cost_avg_usd
    : null;
  const qualityDrop = baseline.quality_avg !== null && candidate.quality_avg !== null
    ? baseline.quality_avg - candidate.quality_avg
    : null;
  const latencyRatio = baseline.latency_p95_ms > 0 && candidate.latency_p95_ms !== null
    ? candidate.latency_p95_ms / baseline.latency_p95_ms
    : null;
  const reworkIncrease = baseline.rework_avg !== null && candidate.rework_avg !== null
    ? baseline.rework_avg > 0
      ? (candidate.rework_avg - baseline.rework_avg) / baseline.rework_avg
      : candidate.rework_avg > 0 ? Number.POSITIVE_INFINITY : 0
    : null;
  return {
    cost_saving: costSaving,
    quality_drop: qualityDrop,
    latency_ratio: latencyRatio,
    rework_increase: reworkIncrease,
    eligible: Number.isFinite(costSaving)
      && Number.isFinite(qualityDrop)
      && Number.isFinite(latencyRatio)
      && Number.isFinite(reworkIncrease)
      && Number.isFinite(candidate.regression_rate)
      && costSaving >= gate.min_cost_saving
      && qualityDrop <= gate.max_quality_drop
      && latencyRatio <= gate.max_p95_latency_ratio
      && reworkIncrease <= gate.max_rework_increase
      && candidate.regression_rate <= gate.max_regression_rate
  };
}

export function recommendRoles(policy, events) {
  const results = joinEvaluations(events);
  const candidateGate = policy.candidate_gate;
  const autoGate = policy.auto_promote_gate;
  return Object.entries(policy.roles).map(([role, config]) => {
    const candidates = config.candidates.map((model) => {
      const summary = metrics(results.filter((event) => event.role === role && event.model === model));
      return {
        model,
        eligible: passesCandidateGate(summary, candidateGate),
        metrics: summary
      };
    });
    const baseline = candidates.find((candidate) => candidate.model === config.default_model)?.metrics;
    const eligible = candidates
      .filter((candidate) => candidate.eligible && candidate.metrics.cost_avg_usd !== null)
      .sort((left, right) => left.metrics.cost_avg_usd - right.metrics.cost_avg_usd);
    const recommended = eligible[0] || candidates.find((candidate) => candidate.model === config.default_model);
    const frontier = paretoFrontier(eligible);
    const comparisonResult = recommended && baseline && recommended.model !== config.default_model
      ? comparison(recommended.metrics, baseline, autoGate)
      : null;
    const autoPromotable = policy.auto_promote_roles.includes(role)
      && recommended
      && recommended.model !== config.default_model
      && recommended.metrics.samples >= autoGate.min_samples_per_model
      && recommended.metrics.distinct_tasks >= autoGate.min_distinct_tasks
      && recommended.metrics.success_rate >= autoGate.min_success_rate
      && recommended.metrics.quality_avg >= autoGate.min_quality_score
      && comparisonResult?.eligible === true;
    return {
      role,
      default_model: config.default_model,
      recommended_model: recommended?.model || config.default_model,
      eligible_for_candidate_pool: candidates.some((candidate) => candidate.eligible),
      eligible_for_auto_promote: Boolean(autoPromotable),
      pareto_frontier: frontier,
      comparison: comparisonResult,
      candidates
    };
  });
}
