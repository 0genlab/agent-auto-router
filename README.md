# agent-auto-router

An evidence-driven routing and evaluation tool that helps agents choose the right model for each task.

> In one sentence: the agent submits a task, `agent-auto-router` selects a model; the agent executes the task, and the router records evidence to improve the next decision.

## Overview / 简介

This is not a leaderboard or a request-only proxy. Model choices are traceable, and the default behavior is observe-and-recommend until there is enough evidence to justify a switch. Codex CLI is the first validated host. Claude Code and Hermes are integrated as preview host adapters for non-interactive execution and metadata-only session ingestion.

### End-to-end loop

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

### How it works

`configs/role-policy.json`, `src/core/role-policy.mjs`, and `scripts/role-run.mjs` provide the model-selection layer used by an agent:

- **Role and task profile:** identify the work stage, tools, language, risk, and expected outcome.
- **Candidate selection:** load available models and remove candidates that fail capability or availability checks.
- **Quality gates:** compare success rate, objective quality, regression results, latency, rework, and cost.
- **Evidence recording:** persist the selected model, execution result, tests, tokens, cost, and evidence references.
- **Policy updates:** aggregate results by role and distinct task; recommend a switch only when the configured sample and quality gates are met.
- **Safety default:** remain in `shadow` mode and never rewrite host configuration without an explicit promotion step.

Passive sessions tagged only as `role = main` are useful for provider usage and cost reporting, but they do not count as `planner`, `implementer`, or other role-specific evidence. Automatic promotion requires provider-tagged, role-tagged, objectively evaluated samples for both the candidate and its provider-local baseline.

### Repository map

| Directory | Purpose |
| --- | --- |
| `src/core/` | Role policy, quality scoring, token/cost calculation, and shared contracts |
| `adapters/` | Codex, Claude Code, Hermes, command-line agents, provider catalogs, and JSONL adapters |
| `scripts/` | Task execution, session ingestion, price sync, evaluation, and reports |
| `configs/` | Role-model policy and switching thresholds |
| `schema/` | Run, experiment, and report formats |
| `tests/` | Core policy, adapter, and ingestion tests |

## Integrations / 集成情况

The host agent remains responsible for invoking the selected model and completing the task.

| Type | Integration | Status | Notes |
| --- | --- | --- | --- |
| Agent host | Codex CLI | ✅ Validated | Supports role runs, exit status, latency, tokens, cost, and passive local session ingestion |
| Agent host | Claude Code | 🧪 Preview | Metadata-only JSONL ingestion; historical provider stays `unknown` unless the session contains HTTPS route evidence or an audited override is supplied |
| Agent host | Hermes | 🧪 Preview | Read-only ingestion from `sessions` and `session_model_usage`; mixed model, provider, base URL, and billing mode usage is stored separately |
| Agent host | Generic command-line agent | 🧪 Preview | Uses `adapters/codex/command-runner.mjs`; only Codex has been validated against a real session so far |
| Model provider | AIHubMix | ✅ Validated | Reads `https://aihubmix.com/v1/models`; all current AIHubMix role defaults are present |
| Model provider | Sub2API | ✅ Validated | Reads authenticated `https://ccsub.inferera.com/v1/models`; uses a separate role pool and statistics |
| Model provider | OpenRouter | ✅ Validated | Reads `https://openrouter.ai/api/v1/models`; Responses API was verified with DeepSeek, Kimi, and GLM models |
| Direct providers | OpenAI, Anthropic, DeepSeek, and others | 🔌 Extension point | Direct connections still require their own catalog and execution adapters |
| Persistence | JSONL | ✅ Validated | Stores structured task, role, model, quality, cost, and evidence metadata |
| Evaluation | CLI tests, regression checks, and diff checks | ✅ Validated | Stores objective results without test command stdout/stderr |

### Host adapter entry points

| Host | Execution adapter | Session ingestion | Integration behavior |
| --- | --- | --- | --- |
| Claude Code | `adapters/claude/host.mjs` | `scripts/ingest-claude-sessions.mjs` | Builds a non-interactive `claude --print --output-format json` request; validates model and provider evidence before execution |
| Hermes | `adapters/hermes/host.mjs` | `scripts/ingest-hermes-sessions.mjs` | Validates the provider and model against the local Hermes catalog, then builds `hermes chat --query-file - --oneshot` |

Both adapters feed the same role-run store as Codex and remain additive: they do not change Codex ingestion, role policy, or the run schema.

### Role vocabulary

`planner`, `researcher`, `explorer`, `implementer`, `e2e`, and `reviewer` are policy roles, not providers or fixed agents. A host can map these roles to different models without copying Codex-specific configuration.

### Provider boundary

The model identity is the pair `(provider, model)`. AIHubMix, Sub2API, and OpenRouter have separate catalogs, role defaults, candidate pools, price snapshots, statistics, recommendations, and promotion decisions. A result from `aihubmix/gpt-6-sol` never contributes to `sub2api/gpt-6-sol`. Historical events using the former provider ID `ccsub` are canonicalized to `sub2api`; events without a provider are treated as `unknown` and are excluded from provider promotion decisions.

OpenRouter uses namespaced IDs such as `deepseek/deepseek-v4.1-flash`. Catalog presence does not guarantee account-level execution: models blocked by provider terms are not used as defaults even when they appear in `/models`.

### Provider configuration and activation

Provider control currently has two separate layers:

| Layer | Configuration | What it controls |
| --- | --- | --- |
| Router policy | `configs/role-policy.json` | Registered providers, provider-specific role defaults, candidate pools, statistics, recommendations, and promotion gates |
| Agent runtime | Host configuration, for example `~/.codex/config.toml` and `~/.codex/agents/*.toml` | Which provider and model actually execute a main or sub-agent session |

A provider present under `providers` in `configs/role-policy.json` participates in catalog validation and provider-specific recommendations. The current schema does not yet expose a separate `enabled`, `catalog_enabled`, or `routing_enabled` flag; removing or adding a provider is therefore a policy change rather than a runtime toggle.

For Codex, provider selection is explicit:

```toml
model_provider = "aihubmix"
model = "gpt-6-sol"

[model_providers.aihubmix]
base_url = "https://aihubmix.com/v1"
env_key = "AIHUBMIX_API_KEY"

[model_providers.sub2api]
base_url = "https://ccsub.inferera.com/v1"
env_key = "AIHUBMIX_SUB_CX_API_KEY"

[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
```

A role config must set both values when overriding the host default:

```toml
model_provider = "aihubmix"
model = "deepseek-v4.1-flash"
```

#### Codex runtime model catalog

Codex resolves the effective `model_provider` from `~/.codex/config.toml`, the selected profile, or a CLI override before launch. The launch wrapper refreshes only that provider's `/models` endpoint and writes the active runtime catalog to `~/.codex/model-catalogs/provider-live.catalog.json`. It never merges model lists from other configured providers, so switching providers regenerates the picker from the newly active provider on the next launch.

The runtime catalog preserves the order returned by the provider API. If the endpoint returns duplicate model IDs, the first occurrence is kept and later duplicates are ignored. If the active provider refresh fails, Codex reuses the last valid cache for that same provider; it does not substitute another provider's cache.

### Current provider defaults

These defaults are independent baselines. They do not compete across providers.

| Role | AIHubMix | Sub2API | OpenRouter |
| --- | --- | --- | --- |
| `planner` | `gpt-6-sol` | `gpt-6-sol` | `z-ai/glm-5.3` |
| `researcher` | `kimi-k3` | `gpt-6-sol` | `moonshotai/kimi-k3` |
| `explorer` | `deepseek-v4.1-flash` | `gpt-6-sol` | `deepseek/deepseek-v4.1-flash` |
| `implementer` | `deepseek-v4.1-flash` | `gpt-6-sol` | `deepseek/deepseek-v4.1-flash` |
| `e2e` | `claude-opus-5-5` | `gpt-6-sol` | `z-ai/glm-5.3` |
| `reviewer` | `gpt-6-sol` | `gpt-6-sol` | `z-ai/glm-5.3` |

The defaults and all candidates were checked against the live catalogs on September 23, 2026. OpenRouter defaults use models that also passed account-level Responses API probes; catalog-only OpenAI and Anthropic entries that returned provider Terms of Service errors were not selected as defaults.

## How to use

Run these commands from the `0genlab` repository. The tool supports two complementary workflows:

- **Execute and record:** wrap a host command or run one host stage, then store role, provider, model, status, latency, token, and cost metadata under `data/role-runs/`.
- **Import and recommend:** ingest metadata from existing Codex, Claude Code, or Hermes sessions, evaluate objective evidence, and generate provider-scoped model recommendations.

Prerequisites are Node.js 22+, the host CLI you intend to use (`codex`, `claude`, or `hermes`), and that host's existing authentication. Hermes session ingestion also requires Python 3 with its standard `sqlite3` module. The repository has no package installation step.

The host remains responsible for calling its model and using tools. `0genlab` recommends and records the provider/model identity; it does not proxy requests or replace the host CLI.

| Goal | Host | Entry point |
| --- | --- | --- |
| Execute a task and record the command | Codex CLI or any command-line agent | `scripts/codex-run.mjs` |
| Execute one non-interactive stage | Claude Code | `scripts/run-host-stage.mjs --host claude` |
| Execute one non-interactive stage | Hermes | `scripts/run-host-stage.mjs --host hermes` |
| Import historical session metadata | Codex, Claude Code, or Hermes | `scripts/ingest-*-sessions.mjs` |
| Evaluate evidence and recommend a model | Any supported host | `scripts/evaluate-run.mjs`, `scripts/role-run.mjs recommend` |

### Use with Codex or another command-line agent

`codex-run.mjs` starts a role run, executes the command after `--`, and records exit status and wall time. Use it for `codex exec` or any other command-line agent; the wrapped command does not need to know about `0genlab`. For normal interactive Codex use, keep using Codex as usual and run `ingest-codex-sessions.mjs` afterward to import session metadata.

```bash
ROLEBENCH_ROOT="$PWD" node scripts/codex-run.mjs \
  --role implementer \
  --provider aihubmix \
  --model deepseek-v4.1-flash \
  --title "Implement refund retry" \
  --type implementation \
  --project "$PWD" \
  -- \
  codex exec --full-auto "Implement refund retry and run tests"
```

The wrapper records process metadata only. It does not copy the prompt, model response, tool output, or source code.

### Use with Claude Code

`run-host-stage.mjs` builds one explicit Claude Code request. It defaults to a redacted dry-run; add `--execute` to start the host:

```bash
ROLEBENCH_ROOT="$PWD" node scripts/run-host-stage.mjs \
  --host claude \
  --role implementer \
  --provider unknown \
  --model opus \
  --prompt-file ./prompt.txt \
  --execute
```

Claude Code runs as `claude --print --output-format json --model <model>`. Use `--provider unknown` only for audit-only runs. A real provider must match the provider proven by the local Claude settings or `ANTHROPIC_BASE_URL`; the adapter never infers a provider from the model name.

For normal interactive Claude Code sessions, keep using `claude` and import the metadata afterward with `ingest-claude-sessions.mjs`.

### Use with Hermes

For Hermes, the provider and model must exist in the local supported catalog or current configuration:

```bash
ROLEBENCH_ROOT="$PWD" node scripts/run-host-stage.mjs \
  --host hermes \
  --role implementer \
  --provider "$HERMES_PROVIDER" \
  --model "$HERMES_MODEL" \
  --prompt-file ./prompt.txt \
  --execute
```

Hermes runs as `hermes chat --provider <provider> --model <model> --in <cwd> --query-file - --oneshot`. The prompt is sent on stdin and is never placed in argv.

For normal interactive Hermes sessions, keep using `hermes` and import the metadata afterward with `ingest-hermes-sessions.mjs`.

### Import existing sessions

Historical sessions can be imported without rerunning the agents:

```bash
ROLEBENCH_ROOT="$PWD" node scripts/ingest-codex-sessions.mjs
ROLEBENCH_ROOT="$PWD" node scripts/ingest-claude-sessions.mjs
ROLEBENCH_ROOT="$PWD" node scripts/ingest-hermes-sessions.mjs
```

All three importers are metadata-only. They do not persist prompts, responses, tool arguments, or source code. Use `--since` to limit an import and `--refresh` to rebuild existing session-derived runs.

Claude Code stores local sessions as JSONL under `~/.claude/projects` by default. Hermes stores state in SQLite, normally at `~/.hermes/state.db`; its adapter reads only `sessions` and `session_model_usage`. Use `--sessions-dir` or `--claude-home` for Claude, and `--db` or `--hermes-home` for Hermes, when the default locations do not apply.

### Evaluate and ask for a recommendation

Use `role-run.mjs` when the host is not wrapped by `codex-run.mjs` or `run-host-stage.mjs`:

```bash
RUN_ID="$(ROLEBENCH_ROOT="$PWD" node scripts/role-run.mjs start \
  --title "Implement refund retry" \
  --type implementation \
  --expected "Tests pass")"

# Run the selected agent and record its result.
ROLEBENCH_ROOT="$PWD" node scripts/role-run.mjs record \
  --run-id "$RUN_ID" \
  --role implementer \
  --provider aihubmix \
  --model deepseek-v4.1-flash \
  --status success \
  --tests-run 8 \
  --tests-passed 8

ROLEBENCH_ROOT="$PWD" node scripts/evaluate-run.mjs \
  --run-id "$RUN_ID" \
  --project "$PWD" \
  --test-command '["npm","test"]'

ROLEBENCH_ROOT="$PWD" node scripts/role-run.mjs recommend --provider aihubmix
```

Recommendations are provider-scoped and remain in `shadow` mode by default. They do not rewrite Codex, Claude Code, or Hermes configuration automatically.

### Manage catalogs and prices

Refresh all provider snapshots used by router policy validation:

```bash
ROLEBENCH_ROOT="$PWD" node scripts/sync-provider-catalogs.mjs
ROLEBENCH_ROOT="$PWD" node scripts/validate-provider-models.mjs
```

The validator fails when a provider-specific default or candidate is missing from that provider's live catalog. This repository command is separate from the provider-scoped runtime catalog generated by the Codex launch wrapper.

Create provider-specific price snapshots with:

```bash
ROLEBENCH_ROOT="$PWD" node scripts/sync-model-prices.mjs --provider aihubmix
ROLEBENCH_ROOT="$PWD" node scripts/sync-model-prices.mjs --provider openrouter
```

Snapshots are written to `data/model-price-snapshots/<provider>.json`. AIHubMix and OpenRouter prices are never shared, even when model names look similar. Sub2API cost remains `null` until a trusted Sub2API price source is configured.

### Run a multi-model experiment

```bash
ROLEBENCH_ROOT="$PWD" node scripts/run-role-experiment.mjs \
  --task schema/role-experiment.example.json \
  --role implementer \
  --provider aihubmix \
  --models deepseek-v4.1-flash,deepseek-v4-pro

ROLEBENCH_ROOT="$PWD" node scripts/summarize-experiment.mjs \
  --report data/experiments/role-implementer-implementation-001.json
```

Each model gets an independent run and evaluation report. The command does not rewrite role configuration. The summary reports `insufficient_evidence` instead of recommending a cheap model without enough evidence. Aggregated recommendations use distinct task IDs rather than counting repeated runs of one task as independent evidence.

## Notes / 注意事项

- All recorded run and imported session metadata is written locally under `data/role-runs/`. `0genlab` has no telemetry or data-upload endpoint and does not send this data to any remote service. Network access is limited to user-invoked catalog or price refreshes and the host's own model calls.
- Codex runtime catalogs contain only the active `model_provider`. Model order follows the provider API, duplicate IDs keep their first occurrence, and a failed refresh falls back only to that provider's cache.
- Provider identity is always `(provider, model)`. Catalogs, statistics, prices, recommendations, and promotion decisions are isolated by provider.
- Recommendations remain in `shadow` mode and never rewrite host configuration. Automatic promotion requires provider-tagged, role-tagged, objectively evaluated samples.
- Passive `role = main` sessions can be used for usage and cost reporting but do not count as role-specific evidence.
- Claude historical provider identity remains `unknown` unless the session contains verifiable HTTPS route evidence or an audited override is supplied. A provider is never inferred from a model name.
- Hermes usage is split by model, provider, billing base URL, and billing mode. Actual and estimated costs remain separate, and missing values stay `null`.
- `run-host-stage.mjs` defaults to a redacted dry-run. The prompt is read from a file or stdin, is not placed in argv, and host output is not persisted.
- Missing usage, price, regression, or evaluation evidence is stored as `null`; exit code alone is not converted into a quality score.

## Design boundaries

- Recorded role-run and imported session metadata remains local under `data/role-runs/`; the tool must not add telemetry or upload this data to a remote service.
- Secrets must come from environment variables and be redacted before persistence.
- Objective evidence is preferred over an LLM judge in the default scoring path.
- Missing usage, price, or evaluation evidence stays `null`; the system does not guess.
- Claude and Hermes adapters are additive and do not change Codex ingestion, role policy, or the run schema.
- Jev is not part of the default Codex role chain or promotion path.
- The core does not rewrite host configuration while operating in `shadow` mode.
- The policy core stays independent of Codex and any single provider.
- Derived metrics should be regenerated by scripts rather than edited manually.
