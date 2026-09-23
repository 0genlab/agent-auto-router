import { detectClaudeProvider, loadClaudeSettings } from "./session-ingest.mjs";

const aliases = new Set(["opus", "sonnet", "haiku", "fable"]);

function configuredModels(settings, env) {
  return new Set([
    settings.model,
    env.CLAUDE_MODEL,
    env.ANTHROPIC_MODEL,
    settings.env?.CLAUDE_MODEL,
    settings.env?.ANTHROPIC_MODEL
  ].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()));
}

export function createClaudeHostAdapter({ claudeHome, env = process.env, settings: providedSettings } = {}) {
  const loaded = providedSettings === undefined ? loadClaudeSettings({ claudeHome }) : { settings: providedSettings };
  const providerEvidence = detectClaudeProvider({ settings: loaded.settings, env });
  const models = configuredModels(loaded.settings, env);

  function validateRequest({ provider, model }) {
    const requestedProvider = String(provider || "").trim().toLowerCase();
    const requestedModel = String(model || "").trim();
    if (!requestedProvider) throw new Error("Claude provider is required");
    if (!requestedModel) throw new Error("Claude model is required");

    if (requestedProvider !== "unknown" && (!providerEvidence.verified || providerEvidence.provider !== requestedProvider)) {
      throw new Error(
        `Claude provider "${requestedProvider}" is not verifiably configured; use --provider unknown for audit-only execution`
      );
    }
    if (!models.has(requestedModel) && !aliases.has(requestedModel)) {
      throw new Error(`unknown Claude model: ${requestedModel}`);
    }

    return {
      provider: requestedProvider,
      model: requestedModel,
      provider_verified: requestedProvider !== "unknown" && providerEvidence.verified,
      audit_only: requestedProvider === "unknown",
      provider_evidence: providerEvidence.evidence
    };
  }

  function buildCommand({ model, prompt, maxBudgetUsd = null, command = env.CLAUDE_BIN || "claude" }) {
    const args = ["--print", "--output-format", "json", "--model", model];
    if (maxBudgetUsd !== null && maxBudgetUsd !== undefined && maxBudgetUsd !== "") {
      args.push("--max-budget-usd", String(maxBudgetUsd));
    }
    return { command, args, stdin: prompt };
  }

  return {
    name: "claude",
    validateRequest,
    buildCommand,
    providerEvidence
  };
}
