import { createOpenAIModelCatalog } from "../openai/model-catalog.mjs";

const DEFAULT_ENDPOINT = "https://aihubmix.com/v1/models";

export function createAihubmixModelCatalog({ fetchImpl = globalThis.fetch, endpoint = DEFAULT_ENDPOINT } = {}) {
  return createOpenAIModelCatalog({
    name: "aihubmix",
    endpoint,
    fetchImpl
  });
}
