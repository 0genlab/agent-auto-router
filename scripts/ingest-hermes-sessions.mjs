#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRoleRunStore } from "../adapters/jsonl/role-run-store.mjs";
import { exportHermesRows, ingestHermesSessions } from "../adapters/hermes/session-ingest.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
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
  const hermesHome = option(args, "--hermes-home", process.env.HERMES_HOME || path.join(process.env.HOME || "", ".hermes"));
  const database = option(args, "--db", process.env.HERMES_DB || path.join(hermesHome, "state.db"));
  const outputRoot = path.join(root, "data", "role-runs");
  const policyPath = path.join(root, "configs", "role-policy.json");
  const snapshotsDir = option(args, "--price-snapshots-dir", path.join(root, "data", "model-price-snapshots"));
  const snapshotPath = option(args, "--price-snapshot", process.env.ROLEBENCH_PRICE_SNAPSHOT || null);
  const sinceValue = option(args, "--since", null);
  const since = sinceValue ? Date.parse(sinceValue) : null;
  const policy = fs.existsSync(policyPath) ? JSON.parse(fs.readFileSync(policyPath, "utf8")) : {};
  const prices = loadPriceSnapshots(snapshotsDir, snapshotPath);
  const store = createRoleRunStore(outputRoot);
  const ingested = ingestHermesSessions({
    store,
    exported: exportHermesRows({ database }),
    providerAliases: policy.provider_aliases || {},
    priceSnapshot: prices.explicit,
    priceSnapshots: prices.snapshots,
    since: Number.isFinite(since) ? since : null,
    refresh: args.includes("--refresh")
  });
  console.log(JSON.stringify({
    database,
    ingested: ingested.length,
    runs: ingested.map((item) => item.run_id)
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
