#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createAihubmixModelCatalog } from "../adapters/aihubmix/model-catalog.mjs";
import { createSub2apiModelCatalog } from "../adapters/sub2api/model-catalog.mjs";
import { createOpenRouterModelCatalog } from "../adapters/openrouter/model-catalog.mjs";

const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
const outputDir = process.env.ROLEBENCH_MODEL_CATALOGS || path.join(root, "data", "model-catalogs");
const catalogs = [createAihubmixModelCatalog(), createSub2apiModelCatalog(), createOpenRouterModelCatalog()];

try {
  fs.mkdirSync(outputDir, { recursive: true });
  const results = [];
  for (const catalog of catalogs) {
    const models = await catalog.listModels();
    const snapshot = {
      schema_version: 1,
      provider: catalog.name,
      fetched_at: new Date().toISOString(),
      models
    };
    const output = path.join(outputDir, `${catalog.name}.json`);
    fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
    results.push({ provider: catalog.name, output, models: models.length });
  }
  console.log(JSON.stringify({ providers: results }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
