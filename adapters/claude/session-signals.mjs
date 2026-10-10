// Objective outcome signals derived from Claude Code session JSONL.
// Only counts, exit codes, and pull-request URLs are returned; command text,
// tool output, and prompts never leave this module.

const checkPatterns = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck)\b/,
  /\bnode\s+--test\b/,
  /\bgo\s+(?:test|build|vet)\b/,
  /\bcargo\s+(?:test|build|check|clippy)\b/,
  /\bmake\s+(?:test|build|check)\b/,
  /\b(?:python3?\s+-m\s+)?pytest\b/,
  /\b(?:vitest|jest|tsc)\b/
];

const pullRequestUrlPattern = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

// A pipe, `;`, `||`, or a multi-line script lets another command decide the
// exit code, so such commands cannot attest a test or build result.
export function classifyCommand(command) {
  const text = String(command || "");
  if (/\bgh\s+pr\s+create\b/.test(text)) return "pr_create";
  if (/[|;\n]/.test(text)) return null;
  return checkPatterns.some((pattern) => pattern.test(text)) ? "check" : null;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

// Claude Code reports a non-zero Bash exit as an error result starting with
// "Exit code N". Other errors (permission denials, user rejection) are not
// command outcomes and return null.
export function exitCodeOf(toolResult) {
  if (toolResult?.is_error !== true) return 0;
  const match = /^Exit code (\d+)\b/.exec(toolResultText(toolResult.content));
  return match ? Number(match[1]) : null;
}

function emptySignals() {
  return { check_commands: 0, check_failures: 0, last_check_exit_code: null, pull_requests: [] };
}

export function createClaudeSignalCollector() {
  const pending = new Map();
  const byModel = new Map();

  const signalsFor = (model) => {
    const key = model || "";
    if (!byModel.has(key)) byModel.set(key, emptySignals());
    return byModel.get(key);
  };

  return {
    consume(record) {
      const content = Array.isArray(record?.message?.content) ? record.message.content : [];
      if (record?.type === "assistant") {
        for (const part of content) {
          if (part?.type !== "tool_use" || part.name !== "Bash" || typeof part.id !== "string") continue;
          const kind = classifyCommand(part.input?.command);
          if (kind) pending.set(part.id, { kind, model: record.message?.model || null });
        }
        return;
      }
      if (record?.type !== "user") return;
      for (const part of content) {
        if (part?.type !== "tool_result") continue;
        const use = pending.get(part.tool_use_id);
        if (!use) continue;
        pending.delete(part.tool_use_id);
        const exitCode = exitCodeOf(part);
        if (exitCode === null) continue;
        const signals = signalsFor(use.model);
        if (use.kind === "check") {
          signals.check_commands += 1;
          if (exitCode !== 0) signals.check_failures += 1;
          signals.last_check_exit_code = exitCode;
        } else if (exitCode === 0) {
          for (const url of toolResultText(part.content).match(pullRequestUrlPattern) || []) {
            if (!signals.pull_requests.includes(url)) signals.pull_requests.push(url);
          }
        }
      }
    },
    forModel(model) {
      return byModel.get(model || "") || emptySignals();
    }
  };
}
