#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createPriceSnapshot, normalizeOpenRouterPrice } from "../src/core/model-pricing.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
const provider = option(process.argv.slice(2), "--provider", "aihubmix");
const output = process.env.ROLEBENCH_PRICE_SNAPSHOT || path.join(root, "data", "model-price-snapshots", `${provider}.json`);

try {
  if (!new Set(["aihubmix", "openrouter"]).has(provider)) throw new Error(`pricing sync is not available for provider: ${provider}`);
  const endpoint = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/models"
    : "https://aihubmix.com/api/v1/models?type=llm";
  const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${provider} pricing metadata failed: HTTP ${response.status}`);
  const payload = await response.json();
  const models = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(models)) throw new Error(`${provider} pricing metadata returned invalid data`);
  const pricedModels = provider === "openrouter"
    ? models.map(normalizeOpenRouterPrice)
    : models.filter((model) => model?.types === "llm" && model?.retire_stage === "active");
  const snapshot = createPriceSnapshot(pricedModels, { provider, source: endpoint });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({ output, models: Object.keys(snapshot.models).length, fetched_at: snapshot.fetched_at }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
