import { spawnSync } from "node:child_process";
import { calculateQualityScore } from "../../src/core/quality-score.mjs";

// Turns session-derived signals into evaluation_finished events:
// - tests: the exit code of the last unambiguous test/build command
// - acceptance: merged => accepted, all closed unmerged => rejected, otherwise pending
// - rework: failed check commands plus the average number of non-merge commits
//   pushed to the session's pull requests after they were opened

const terminalStates = new Set(["MERGED", "CLOSED"]);

export function followUpCommits(createdAt, commits = []) {
  const opened = Date.parse(createdAt || "");
  if (!Number.isFinite(opened)) return null;
  return commits.filter((commit) => Date.parse(commit?.committedDate || "") > opened
    && !/^Merge\b/.test(String(commit?.messageHeadline || ""))).length;
}

export function githubPullRequestInfo(url) {
  const result = spawnSync("gh", ["pr", "view", url, "--json", "state,createdAt,commits"], {
    encoding: "utf8",
    timeout: 15_000
  });
  if (result.status !== 0) return null;
  try {
    const pr = JSON.parse(result.stdout);
    return { state: pr.state || null, follow_up_commits: followUpCommits(pr.createdAt, pr.commits) };
  } catch {
    return null;
  }
}

function reworkCount(signals, pullRequests) {
  const followUps = pullRequests.map((pr) => pr.follow_up_commits).filter(Number.isFinite);
  const prRework = followUps.length ? followUps.reduce((sum, value) => sum + value, 0) / followUps.length : null;
  const checkRework = signals.check_commands ? signals.check_failures : null;
  if (prRework === null && checkRework === null) return null;
  return Math.round(((checkRework || 0) + (prRework || 0)) * 10) / 10;
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

export function evaluateClaudeRuns({ store, runIds = null, sessionId = null, prInfo = githubPullRequestInfo, now = new Date() } = {}) {
  const byRun = new Map();
  for (const event of store.readEvents()) {
    if (!String(event.run_id || "").startsWith("claude-")) continue;
    if (runIds && !runIds.includes(event.run_id)) continue;
    if (!byRun.has(event.run_id)) byRun.set(event.run_id, []);
    byRun.get(event.run_id).push(event);
  }

  const infoCache = new Map();
  const cachedInfo = (url, previous) => {
    // Merged or closed pull requests no longer change; reuse what was recorded.
    if (terminalStates.has(previous?.state) && Number.isFinite(previous?.follow_up_commits)) return previous;
    if (!infoCache.has(url)) infoCache.set(url, prInfo(url));
    return infoCache.get(url);
  };

  const written = [];
  for (const [runId, events] of byRun) {
    const finished = latestBy(events, "agent_finished");
    if (!finished || (sessionId && finished.task_id !== sessionId)) continue;
    const signals = finished.session_signals;
    if (!signals) continue;
    const pullRequests = signals.pull_requests || [];
    if (signals.last_check_exit_code === null && !pullRequests.length) continue;

    const previous = latestBy(events, "evaluation_finished");
    const previousPrs = new Map((previous?.pull_requests || []).map((pr) => [pr.url, pr]));
    const prs = pullRequests.map((url) => {
      const info = cachedInfo(url, previousPrs.get(url));
      return { url, state: info?.state || null, follow_up_commits: info?.follow_up_commits ?? null };
    });
    const acceptance = acceptanceFor(prs.map((pr) => pr.state));
    const rework = reworkCount(signals, prs);
    const test = signals.last_check_exit_code === null ? null : { exit_code: signals.last_check_exit_code };
    const quality = calculateQualityScore({
      evaluation: { test },
      run: { acceptance_status: acceptance, rework_count: rework }
    });
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
      pull_requests: prs,
      acceptance_status: acceptance,
      rework_count: rework,
      quality_score: quality.quality_score,
      quality_confidence: quality.quality_confidence,
      quality_components: quality.quality_components,
      evidence: [
        test ? "claude-session:check-exit-code" : null,
        pullRequests.length ? "github:pull-request-state" : null,
        rework === null ? null : "claude-session:rework"
      ].filter(Boolean)
    };

    const unchanged = previous?.evaluator === evaluation.evaluator
      && JSON.stringify([previous.test, previous.pull_requests, previous.quality_score])
        === JSON.stringify([evaluation.test, evaluation.pull_requests, evaluation.quality_score]);
    if (unchanged) continue;
    store.appendEvent(runId, evaluation);
    written.push(evaluation);
  }
  return written;
}
