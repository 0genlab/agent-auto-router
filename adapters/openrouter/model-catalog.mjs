import process from "node:process";
import { createOpenAIModelCatalog } from "../openai/model-catalog.mjs";

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/models";

export function createOpenRouterModelCatalog({
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  apiKey = process.env.OPENROUTER_API_KEY || null
} = {}) {
  return createOpenAIModelCatalog({
    name: "openrouter",
    endpoint,
    apiKey,
    fetchImpl
  });
}
