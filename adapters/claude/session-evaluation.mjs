import { spawnSync } from "node:child_process";
import { calculateQualityScore } from "../../src/core/quality-score.mjs";

// Turns session-derived signals into evaluation_finished events:
// - tests: the exit code of the last unambiguous test/build command
// - acceptance: merged => accepted, all closed unmerged => rejected, otherwise pending

export function githubPullRequestState(url) {
  const result = spawnSync("gh", ["pr", "view", url, "--json", "state", "--jq", ".state"], {
    encoding: "utf8",
    timeout: 15_000
  });
  return result.status === 0 ? String(result.stdout || "").trim() || null : null;
}

export function acceptanceFor(states) {
  const known = states.filter(Boolean);
  if (known.includes("MERGED")) return "accepted";
  if (known.length && known.length === states.length && known.every((state) => state === "CLOSED")) return "rejected";
  return null;
}

function latestBy(events, name) {
  return events.filter((event) => event.event === name).at(-1) || null;
}

export function evaluateClaudeRuns({ store, runIds = null, sessionId = null, prState = githubPullRequestState, now = new Date() } = {}) {
  const byRun = new Map();
  for (const event of store.readEvents()) {
    if (!String(event.run_id || "").startsWith("claude-")) continue;
    if (runIds && !runIds.includes(event.run_id)) continue;
    if (!byRun.has(event.run_id)) byRun.set(event.run_id, []);
    byRun.get(event.run_id).push(event);
  }

  const stateCache = new Map();
  const cachedState = (url) => {
    if (!stateCache.has(url)) stateCache.set(url, prState(url));
    return stateCache.get(url);
  };

  const written = [];
  for (const [runId, events] of byRun) {
    const finished = latestBy(events, "agent_finished");
    if (!finished || (sessionId && finished.task_id !== sessionId)) continue;
    const signals = finished.session_signals;
    if (!signals) continue;
    const pullRequests = signals.pull_requests || [];
    if (signals.last_check_exit_code === null && !pullRequests.length) continue;

    const states = pullRequests.map(cachedState);
    const acceptance = acceptanceFor(states);
    const test = signals.last_check_exit_code === null ? null : { exit_code: signals.last_check_exit_code };
    const quality = calculateQualityScore({ evaluation: { test }, run: { acceptance_status: acceptance } });
    const evaluation = {
      schema_version: 1,
      run_id: runId,
      event: "evaluation_finished",
      evaluator: "claude-session-signals",
      timestamp: now.toISOString(),
      role: finished.role,
      model: finished.model,
      provider: finished.provider,
      evaluation_status: quality.quality_score === null ? "insufficient_evidence" : test?.exit_code === 0 || acceptance === "accepted" ? "success" : "failed",
      test,
      check_commands: signals.check_commands,
      check_failures: signals.check_failures,
      pull_requests: pullRequests.map((url, index) => ({ url, state: states[index] })),
      acceptance_status: acceptance,
      quality_score: quality.quality_score,
      quality_confidence: quality.quality_confidence,
      quality_components: quality.quality_components,
      evidence: [
        test ? "claude-session:check-exit-code" : null,
        pullRequests.length ? "github:pull-request-state" : null
      ].filter(Boolean)
    };

    const previous = latestBy(events, "evaluation_finished");
    const unchanged = previous?.evaluator === evaluation.evaluator
      && JSON.stringify([previous.test, previous.pull_requests, previous.quality_score])
        === JSON.stringify([evaluation.test, evaluation.pull_requests, evaluation.quality_score]);
    if (unchanged) continue;
    store.appendEvent(runId, evaluation);
    written.push(evaluation);
  }
  return written;
}
