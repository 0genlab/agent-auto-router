# agent-auto-router

An evidence-driven routing and evaluation tool that helps agents choose the right model for each task.

> In one sentence: the agent submits a task, `agent-auto-router` selects a model; the agent executes the task, and the router records evidence to improve the next decision.

This is not a leaderboard or a request-only proxy. Model choices are traceable, and the default behavior is observe-and-recommend until there is enough evidence to justify a switch. Codex CLI is the first validated host; other agents can connect through adapters.

## End-to-end loop

```mermaid
flowchart LR
    A[Agent submits task] --> B[Identify role and task type]
    B --> C[Load live model catalog]
    C --> D[Filter available models]
    D --> E[Apply quality and cost gates]
    E --> F[Recommend or select model]
    F --> G[Agent executes task]
    G --> H[Collect tests, tokens, cost, rework]
    H --> I[Create objective evaluation]
    I --> J[Update role-model statistics]
    J -. next task .-> E
```

Selection considers role, task type, tool requirements, model availability, historical quality, success rate, latency, rework, and cost. The default policy is `shadow`: the router explains candidates and switch reasons first; gray rollout or automatic promotion requires the configured admission gates.

## Repository map

| Directory | Purpose |
| --- | --- |
| `src/core/` | Role policy, quality scoring, token/cost calculation, and shared contracts |
| `adapters/` | Codex, command-line agents, AIHubMix catalog, and JSONL adapters |
| `scripts/` | Task execution, session ingestion, price sync, evaluation, and reports |
| `configs/` | Role-model policy and switching thresholds |
| `schema/` | Run, experiment, and report formats |
| `tests/` | Core policy, adapter, and ingestion tests |

## Preview integrations

The current release focuses on role-based model evaluation and switching decisions. The host agent remains responsible for invoking the selected model and completing the task.

| Type | Integration | Status | Notes |
| --- | --- | --- | --- |
| Agent host | Codex CLI | ✅ Validated | Supports role runs, exit status, latency, tokens, cost, and passive local session ingestion |
| Agent host | Generic command-line agent | 🧪 Preview | Uses `adapters/codex/command-runner.mjs`; only Codex has been validated against a real session so far |
| Agent host | Hermes | 📦 Benchmark reference | Existing Hermes benchmark data can be used as experiment input, but the public core does not couple to the Hermes runtime |
| Model catalog/provider | AIHubMix | ✅ Validated | Reads `https://aihubmix.com/api/v1/models?type=llm` and can generate model ID and price snapshots |
| Direct model providers | OpenAI, Anthropic, DeepSeek, and others | 🔌 Extension point | Add a `ModelCatalogProvider` or Agent adapter; this release does not claim direct provider integration |
| Persistence | JSONL | ✅ Validated | Stores structured task, role, model, quality, cost, and evidence metadata |
| Evaluation | CLI tests, regression checks, and diff checks | ✅ Validated | Stores objective results without test command stdout/stderr |

### Role vocabulary

`planner`, `researcher`, `explorer`, `implementer`, `e2e`, and `reviewer` are policy roles, not providers or fixed agents. A host can map these roles to different models without copying Codex-specific configuration.

### Provider boundary

The current real provider integration is the AIHubMix model catalog plus provider metadata collected from Codex sessions. Model IDs come from the live AIHubMix catalog; names such as `gpt-*`, `claude-*`, and `deepseek-*` are not presented as direct integrations unless a provider adapter and real protocol validation have been added.

## How it works

`configs/role-policy.json`, `src/core/role-policy.mjs`, and `scripts/role-run.mjs` provide the model-selection layer used by an agent:

- **Role and task profile:** identify the work stage, tools, language, risk, and expected outcome.
- **Candidate selection:** load available models and remove candidates that fail capability or availability checks.
- **Quality gates:** compare success rate, objective quality, regression results, latency, rework, and cost.
- **Evidence recording:** persist the selected model, execution result, tests, tokens, cost, and evidence references.
- **Policy updates:** aggregate results by role and distinct task; recommend a switch only when the configured sample and quality gates are met.
- **Safety default:** remain in `shadow` mode and never rewrite host configuration without an explicit promotion step.

### Operating principle

```mermaid
flowchart TB
    subgraph HOST[Agent host]
        A[Codex CLI or another agent]
        X[Agent adapter]
        A --> X
    end

    subgraph ROUTER[agent-auto-router]
        P[Role policy\nrole and task profile]
        M[Model catalog\ncapabilities and price]
        S[Scoring\nquality, latency, cost]
        R[Recommendation\nmodel and switch candidate]
        P --> S
        M --> S
        S --> R
    end

    subgraph EVIDENCE[Evidence layer]
        T[Task evaluator\ntests, regression, diff]
        L[JSONL run store\ntask and run metadata]
    end

    X --> P
    R --> X
    X --> A
    A --> T
    A --> L
    T --> L
    L --> P
```

The router answers **which model, why it was selected, whether a switch is allowed, and how the result performed**. The host agent answers **how to call the model, use tools, and complete the task**. The policy core therefore stays independent of Codex and any single provider.

## Quick start

### Record a role run

```bash
RUN_ID="$(node scripts/role-run.mjs start --title "Implement refund retry" --type implementation --expected "Tests pass")"
node scripts/role-run.mjs record --run-id "$RUN_ID" --role implementer \
  --model deepseek-v4.1-flash --status success --quality-score 4.2 \
  --tests-run 8 --tests-passed 8 --rework-count 0
node scripts/role-run.mjs recommend
```

### Record a Codex command

Use the adapter explicitly when you want to record a Codex-compatible command:

```bash
ROLEBENCH_ROOT=/path/to/agent-auto-router node scripts/codex-run.mjs \
  --role implementer --model deepseek-v4.1-flash \
  --title "Implement refund retry" --type implementation \
  --task-family implementation --repo-language go \
  --tool-profile terminal+tests -- \
  codex exec --full-auto "Implement refund retry and run tests"
```

The command records an `agent_finished` event and latency. Add test results, quality, cost, and evidence in the evaluation step; a failed exit code remains a failure and is never converted into a quality score.

### Evaluate objective evidence

```bash
ROLEBENCH_ROOT=/path/to/agent-auto-router node scripts/evaluate-run.mjs \
  --run-id "$RUN_ID" --project /path/to/project \
  --test-command '["npm","test"]' \
  --regression-command '["python3","regression_test.py"]'
```

The evaluator writes structured results without storing test command stdout/stderr.

### Sync model prices

```bash
ROLEBENCH_ROOT=/path/to/agent-auto-router node scripts/sync-model-prices.mjs
```

The default snapshot is `data/model-price-snapshot.json`. It contains model IDs, input/output prices, currency, source, and fetch time. The file is generated data and is ignored by Git.

### Run a multi-model experiment

```bash
ROLEBENCH_ROOT=/path/to/agent-auto-router node scripts/run-role-experiment.mjs \
  --task schema/role-experiment.example.json \
  --role implementer \
  --models deepseek-v4.1-flash,deepseek-v4-pro
```

Each model gets an independent run and evaluation report. The command does not rewrite role configuration. Summarize a report with:

```bash
node scripts/summarize-experiment.mjs \
  --report data/experiments/role-implementer-implementation-001.json
```

The summary reports `insufficient_evidence` instead of recommending a cheap model without enough evidence. Aggregated recommendations use distinct task IDs rather than counting repeated runs of one task as independent evidence.

### Ingest real Codex sessions

Existing local Codex sessions can be ingested without creating synthetic experiments:

```bash
ROLEBENCH_ROOT=/path/to/agent-auto-router node scripts/ingest-codex-sessions.mjs
```

The ingester records session metadata, role, model, latency, tokens, and cost. It does not copy prompts, responses, tool output, or source code, and repeated ingestion is deduplicated by session ID.

## Design boundaries

- Secrets must come from environment variables and be redacted before persistence.
- Objective evidence is preferred over an LLM judge in the default scoring path.
- Missing usage, price, or evaluation evidence stays `null`; the system does not guess.
- Jev is not part of the default Codex role chain or promotion path.
- The core does not rewrite host configuration while operating in `shadow` mode.
- Derived metrics should be regenerated by scripts rather than edited manually.
