import { assertAdapter } from "../../src/core/contracts.mjs";

export function createOpenAIModelCatalog({
  name,
  endpoint,
  apiKey = null,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!name) throw new Error("model catalog name is required");
  if (!endpoint) throw new Error("model catalog endpoint is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  return assertAdapter("modelCatalog", {
    name,
    async listModels({ signal } = {}) {
      const headers = { Accept: "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetchImpl(endpoint, { method: "GET", headers, signal });
      if (!response.ok) throw new Error(`${name} model catalog failed: HTTP ${response.status}`);
      const payload = await response.json();
      const models = Array.isArray(payload) ? payload : payload?.data;
      if (!Array.isArray(models)) throw new Error(`${name} model catalog returned invalid data`);
      return models.map((model) => ({
        ...model,
        model_id: String(model?.model_id || model?.id || ""),
        model_name: String(model?.model_name || model?.id || model?.model_id || ""),
        provider: name
      })).filter((model) => model.model_id);
    }
  });
}
