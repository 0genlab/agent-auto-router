# Role experiment report schema v2

Use `scripts/summarize-experiment.mjs` after a batch run:

```bash
node scripts/summarize-experiment.mjs \
  --report data/experiments/role-implementer-implementation-001.json
```

The summary distinguishes three states:

- `insufficient_evidence`: sample, task diversity, success, or quality gate is not met.
- `candidate`: the model is eligible for the candidate pool; it is not the default yet.
- `canary` / `promoted`: reserved for later policy stages and never inferred by this report alone.

The report is intentionally conservative: a low-cost model with insufficient
quality evidence is not recommended.

Summaries are partitioned under `providers`. Reports from different providers
may be read together, but their samples, metrics, recommendations, and
promotion eligibility are never merged. Reports from different roles are
rejected rather than silently combined.

Multiple task reports can be aggregated before judging the candidate gate:

```bash
node scripts/summarize-experiment.mjs \
  --reports-dir data/experiments \
  --output data/experiments/implementer-summary.json
```

The summary counts distinct `task_id` values, so repeated runs of one task do
not masquerade as task diversity.
