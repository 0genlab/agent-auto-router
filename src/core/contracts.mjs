export const adapterContracts = Object.freeze({
  agent: ["name", "run"],
  modelCatalog: ["name", "listModels"],
  evaluator: ["name", "evaluate"]
});

export function assertAdapter(kind, adapter) {
  const required = adapterContracts[kind];
  if (!required) throw new Error(`unknown adapter contract: ${kind}`);
  if (!adapter || typeof adapter !== "object") throw new Error(`${kind} adapter must be an object`);
  for (const field of required) {
    if (!adapter[field] || (field !== "name" && typeof adapter[field] !== "function")) {
      throw new Error(`${kind} adapter missing ${field}`);
    }
  }
  return adapter;
}

export function createTaskProfile(input = {}) {
  return {
    task_family: input.task_family || "unknown",
    repo_language: input.repo_language || null,
    tool_profile: input.tool_profile || null,
    context_size_bucket: input.context_size_bucket || null,
    failure_mode: input.failure_mode || null
  };
}
