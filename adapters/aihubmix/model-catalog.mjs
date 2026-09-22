import { assertAdapter } from "../../src/core/contracts.mjs";

const DEFAULT_ENDPOINT = "https://aihubmix.com/api/v1/models";

export function createAihubmixModelCatalog({ fetchImpl = globalThis.fetch, endpoint = DEFAULT_ENDPOINT } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  return assertAdapter("modelCatalog", {
    name: "aihubmix",
    async listModels({ signal } = {}) {
      const response = await fetchImpl(`${endpoint}?type=llm`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal
      });
      if (!response.ok) throw new Error(`AIHubMix model catalog failed: HTTP ${response.status}`);
      const payload = await response.json();
      const models = Array.isArray(payload) ? payload : payload?.data;
      if (!Array.isArray(models)) throw new Error("AIHubMix model catalog returned invalid data");
      return models;
    }
  });
}
