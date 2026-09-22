#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRoleRunStore } from "../adapters/jsonl/role-run-store.mjs";
import { ingestSessionFiles } from "../adapters/codex/session-ingest.mjs";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex");
const sessionsDir = option(args, "--sessions-dir", path.join(codexHome, "sessions"));
const outputRoot = path.join(root, "data", "role-runs");
const snapshotPath = option(args, "--price-snapshot", process.env.ROLEBENCH_PRICE_SNAPSHOT || path.join(root, "data", "model-price-snapshot.json"));
const sinceValue = option(args, "--since", null);
const since = sinceValue ? Date.parse(sinceValue) : null;

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

try {
  const priceSnapshot = snapshotPath && fs.existsSync(snapshotPath)
    ? JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
    : null;
  const store = createRoleRunStore(outputRoot);
  const ingested = ingestSessionFiles({ files: sessionFiles(sessionsDir), store, priceSnapshot, since: Number.isFinite(since) ? since : null, refresh: args.includes("--refresh") });
  console.log(JSON.stringify({ sessions_dir: sessionsDir, ingested: ingested.length, runs: ingested.map((item) => item.run_id) }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
