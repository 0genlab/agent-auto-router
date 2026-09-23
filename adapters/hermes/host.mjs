import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function lines(text) {
  return String(text || "").split(/\r?\n/);
}

export function parseHermesAuthProviders(output) {
  const providers = new Set();
  for (const line of lines(output)) {
    const match = line.match(/^([A-Za-z0-9_.:-]+)\s+\(\d+\s+credentials?\):/);
    if (match) providers.add(match[1].toLowerCase());
  }
  return [...providers].sort();
}

function parseHermesCurrentModel(configText) {
  let inModel = false;
  let provider = null;
  let model = null;
  for (const line of lines(configText)) {
    if (/^model:\s*$/.test(line)) {
      inModel = true;
      continue;
    }
    if (!inModel) continue;
    if (/^[^\s]/.test(line)) break;
    const providerMatch = line.match(/^\s+provider:\s*['"]?([^'"]+?)['"]?\s*$/);
    const modelMatch = line.match(/^\s+default:\s*['"]?([^'"]+?)['"]?\s*$/);
    if (providerMatch) provider = providerMatch[1].trim();
    if (modelMatch) model = modelMatch[1].trim();
  }
  return { provider, model };
}

function modelIds(providerEntry) {
  return (providerEntry?.models || []).map((model) => typeof model === "string" ? model : model?.id).filter(Boolean);
}

export function loadHermesCatalog({
  homeDir = process.env.HERMES_HOME || path.join(process.env.HOME || "", ".hermes"),
  env = process.env,
  authOutput = null,
  hermesBin = env.HERMES_BIN || "hermes",
  spawnSyncImpl = spawnSync
} = {}) {
  const catalogPath = path.join(homeDir, "cache", "model_catalog.json");
  const configPath = path.join(homeDir, "config.yaml");
  const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, "utf8")) : { providers: {} };
  const config = fs.existsSync(configPath) ? parseHermesCurrentModel(fs.readFileSync(configPath, "utf8")) : {};
  let auth = authOutput;
  if (auth === null) {
    const result = spawnSyncImpl(hermesBin, ["auth", "list"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    auth = result.status === 0 ? result.stdout : "";
  }

  const providers = {};
  for (const [slug, entry] of Object.entries(catalog.providers || {})) {
    providers[slug.toLowerCase()] = {
      slug,
      models: modelIds(entry)
    };
  }
  for (const provider of parseHermesAuthProviders(auth)) {
    providers[provider] ||= { slug: provider, models: [] };
  }
  if (config.provider) {
    const key = config.provider.toLowerCase();
    providers[key] ||= { slug: config.provider, models: [] };
    if (config.model && !providers[key].models.includes(config.model)) providers[key].models.push(config.model);
  }
  return {
    catalog_path: catalogPath,
    config_path: configPath,
    current: config,
    providers
  };
}

export function createHermesHostAdapter({ catalog = loadHermesCatalog(), env = process.env } = {}) {
  function validateRequest({ provider, model }) {
    const requestedProvider = String(provider || "").trim().toLowerCase();
    const requestedModel = String(model || "").trim();
    if (!requestedProvider) throw new Error("Hermes provider is required");
    if (!requestedModel) throw new Error("Hermes model is required");
    const providerEntry = catalog.providers?.[requestedProvider];
    if (!providerEntry) throw new Error(`unknown Hermes provider: ${requestedProvider}`);
    const acceptedModels = providerEntry.models || [];
    if (!acceptedModels.some((candidate) => String(candidate || "").trim() === requestedModel)) {
      throw new Error(`unknown Hermes model for ${requestedProvider}: ${requestedModel}`);
    }
    return {
      provider: requestedProvider,
      model: requestedModel,
      provider_verified: true,
      audit_only: false,
      provider_evidence: "hermes-supported-catalog"
    };
  }

  function buildCommand({ provider, model, prompt, cwd, command = env.HERMES_BIN || "hermes" }) {
    if (!cwd) throw new Error("Hermes cwd is required");
    const args = [
      "chat",
      "--provider", provider,
      "--model", model,
      "--in", cwd,
      "--query-file", "-",
      "--oneshot"
    ];
    return { command, args, stdin: prompt };
  }

  return {
    name: "hermes",
    validateRequest,
    buildCommand,
    catalog
  };
}
