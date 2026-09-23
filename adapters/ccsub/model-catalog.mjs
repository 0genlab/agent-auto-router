import process from "node:process";
import { createOpenAIModelCatalog } from "../openai/model-catalog.mjs";

const DEFAULT_ENDPOINT = "https://ccsub.inferera.com/v1/models";

export function createCcsubModelCatalog({
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  apiKey = process.env.AIHUBMIX_SUB_CX_API_KEY || null
} = {}) {
  return createOpenAIModelCatalog({
    name: "ccsub",
    endpoint,
    apiKey,
    fetchImpl
  });
}
