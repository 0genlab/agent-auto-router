#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRoleRunStore } from "../adapters/jsonl/role-run-store.mjs";
import { ingestClaudeSessionFiles } from "../adapters/claude/session-ingest.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function sessionFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...sessionFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(fullPath);
  }
  return result.sort();
}

function loadPriceSnapshots(directory, explicitPath) {
  const explicit = explicitPath && fs.existsSync(explicitPath)
    ? JSON.parse(fs.readFileSync(explicitPath, "utf8"))
    : null;
  const snapshots = fs.existsSync(directory)
    ? Object.fromEntries(fs.readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .map((file) => {
          const snapshot = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
          return [snapshot.provider || path.basename(file, ".json"), snapshot];
        }))
    : {};
  return { explicit, snapshots };
}

try {
  const args = process.argv.slice(2);
  const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
  const claudeHome = option(args, "--claude-home", process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "", ".claude"));
  const sessionsDir = option(args, "--sessions-dir", path.join(claudeHome, "projects"));
  const outputRoot = path.join(root, "data", "role-runs");
  const snapshotsDir = option(args, "--price-snapshots-dir", path.join(root, "data", "model-price-snapshots"));
  const snapshotPath = option(args, "--price-snapshot", process.env.ROLEBENCH_PRICE_SNAPSHOT || null);
  const sinceValue = option(args, "--since", null);
  const since = sinceValue ? Date.parse(sinceValue) : null;
  const auditedProvider = option(args, "--audited-provider", null);
  const prices = loadPriceSnapshots(snapshotsDir, snapshotPath);
  const store = createRoleRunStore(outputRoot);
  const ingested = ingestClaudeSessionFiles({
    files: sessionFiles(sessionsDir),
    store,
    auditedProvider,
    auditedProviderVerified: Boolean(auditedProvider),
    priceSnapshot: prices.explicit,
    priceSnapshots: prices.snapshots,
    since: Number.isFinite(since) ? since : null,
    refresh: args.includes("--refresh")
  });
  const providers = [...new Set(ingested.map((item) => item.session.provider))];
  const provider = providers.length === 1 ? providers[0] : providers.length > 1 ? "mixed" : auditedProvider || "unknown";
  const providerVerified = providers.length === 1
    ? ingested.every((item) => item.session.provider_verified)
    : Boolean(auditedProvider && auditedProvider !== "unknown");
  console.log(JSON.stringify({
    sessions_dir: sessionsDir,
    provider,
    provider_verified: providerVerified,
    ingested: ingested.length,
    runs: ingested.map((item) => ({
      run_id: item.run_id,
      model: item.model,
      provider: item.session.provider,
      provider_verified: item.session.provider_verified
    }))
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
