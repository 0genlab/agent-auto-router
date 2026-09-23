#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
const policyPath = path.join(root, "configs", "role-policy.json");
const catalogsDir = process.env.ROLEBENCH_MODEL_CATALOGS || path.join(root, "data", "model-catalogs");

try {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const providers = [];
  let invalid = false;
  for (const [provider, providerPolicy] of Object.entries(policy.providers || {})) {
    const catalogPath = path.join(catalogsDir, `${provider}.json`);
    if (!fs.existsSync(catalogPath)) throw new Error(`missing provider catalog: ${catalogPath}`);
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const catalogProviderValid = catalog.provider === provider;
    const modelProvidersValid = (catalog.models || []).every((model) => model.provider === provider);
    if (!catalogProviderValid || !modelProvidersValid) invalid = true;
    const available = new Set((catalog.models || []).map((model) => model.model_id || model.id));
    const roles = Object.entries(providerPolicy.roles || {}).map(([role, rolePolicy]) => {
      const missing = rolePolicy.candidates.filter((model) => !available.has(model));
      const defaultAvailable = available.has(rolePolicy.default_model);
      if (!defaultAvailable || missing.length) invalid = true;
      return { role, default_model: rolePolicy.default_model, default_available: defaultAvailable, missing_candidates: missing };
    });
    providers.push({
      provider,
      catalog_models: available.size,
      catalog_provider_valid: catalogProviderValid,
      model_providers_valid: modelProvidersValid,
      roles
    });
  }
  console.log(JSON.stringify({ valid: !invalid, providers }, null, 2));
  if (invalid) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
