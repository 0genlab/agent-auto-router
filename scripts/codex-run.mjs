#!/usr/bin/env node

import process from "node:process";
import { createCodexRoleRunCli } from "../adapters/codex/role-run.mjs";
import { runRecordedCommand } from "../adapters/codex/command-runner.mjs";
import fs from "node:fs";
import path from "node:path";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function numberOption(args, name) {
  const value = Number(option(args, name, "NaN"));
  return Number.isFinite(value) ? value : null;
}

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0) {
  console.error("usage: codex-run.mjs --role <role> --model <model> --title <title> -- <command> [args]");
  process.exit(2);
}

const options = args.slice(0, separator);
const commandArgs = args.slice(separator + 1);
const command = commandArgs.shift();
if (!command) {
  console.error("missing command after --");
  process.exit(2);
}

const cli = createCodexRoleRunCli();
try {
  const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
  const provider = option(options, "--provider", "");
  if (!provider) throw new Error("missing --provider");
  const snapshotPath = option(options, "--price-snapshot", process.env.ROLEBENCH_PRICE_SNAPSHOT || (provider ? path.join(root, "data", "model-price-snapshots", `${provider}.json`) : null));
  const priceSnapshot = snapshotPath && fs.existsSync(snapshotPath)
    ? JSON.parse(fs.readFileSync(snapshotPath, "utf8"))
    : null;
  const result = await runRecordedCommand({
    cli,
    command,
    args: commandArgs,
    cwd: option(options, "--project", process.cwd()),
    role: required(options, "--role"),
    provider,
    model: required(options, "--model"),
    startArgs: [
      "--title", required(options, "--title"),
      "--type", option(options, "--type", "unknown"),
      "--project", option(options, "--project", process.cwd()),
      "--expected", option(options, "--expected", ""),
      "--task-family", option(options, "--task-family", "unknown"),
      "--repo-language", option(options, "--repo-language", ""),
      "--tool-profile", option(options, "--tool-profile", ""),
      "--context-size-bucket", option(options, "--context-size-bucket", "")
    ],
    recordArgs: [
      "--task-id", option(options, "--task-id", ""),
      "--task-family", option(options, "--task-family", ""),
      "--repo-language", option(options, "--repo-language", ""),
      "--tool-profile", option(options, "--tool-profile", ""),
      "--context-size-bucket", option(options, "--context-size-bucket", ""),
      "--deployment", option(options, "--deployment", "")
    ],
    usageFile: option(options, "--usage-file", null),
    priceSnapshot,
    inputPricePerMillion: numberOption(options, "--input-price-per-million"),
    outputPricePerMillion: numberOption(options, "--output-price-per-million")
  });
  process.exitCode = result.exitCode ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
