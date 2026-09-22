#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createAihubmixModelCatalog } from "../adapters/aihubmix/model-catalog.mjs";
import { createPriceSnapshot } from "../src/core/model-pricing.mjs";

const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
const output = process.env.ROLEBENCH_PRICE_SNAPSHOT || path.join(root, "data", "model-price-snapshot.json");

try {
  const catalog = createAihubmixModelCatalog();
  const models = await catalog.listModels();
  const active = models.filter((model) => model?.types === "llm" && model?.retire_stage === "active");
  const snapshot = createPriceSnapshot(active, { source: "aihubmix:/api/v1/models?type=llm" });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({ output, models: Object.keys(snapshot.models).length, fetched_at: snapshot.fetched_at }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
