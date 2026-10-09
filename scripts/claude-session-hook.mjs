#!/usr/bin/env node

// Claude Code hook entry for SessionStart and SessionEnd.
// SessionStart records the provider route the live session uses;
// SessionEnd records it if missing and ingests that session's transcript.
// It always exits 0 so a recording failure never blocks Claude Code.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { loadClaudeSettings } from "../adapters/claude/session-ingest.mjs";
import { recordClaudeSessionRoute } from "../adapters/claude/session-routes.mjs";

const root = process.env.ROLEBENCH_ROOT || path.resolve(import.meta.dirname, "..");
const routesDir = path.join(root, "data", "claude-session-routes");
const logFile = path.join(root, "data", "claude-session-hook.log");

function log(message) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging is best-effort.
  }
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

try {
  const input = readStdin();
  const event = input.hook_event_name;
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;

  if (event === "SessionStart" || event === "SessionEnd") {
    const { settings } = loadClaudeSettings();
    const { created, route } = recordClaudeSessionRoute({ routesDir, sessionId, settings });
    if (created) log(`${event} route session=${route.session_id} provider=${route.provider}`);
  }

  if (event === "SessionEnd" && transcriptPath && fs.existsSync(transcriptPath)) {
    const result = spawnSync(process.execPath, [
      path.join(import.meta.dirname, "ingest-claude-sessions.mjs"),
      "--file", transcriptPath,
      "--routes-dir", routesDir
    ], { env: { ...process.env, ROLEBENCH_ROOT: root }, encoding: "utf8", timeout: 30_000 });
    if (result.status === 0) {
      const summary = JSON.parse(result.stdout || "{}");
      log(`SessionEnd ingest session=${sessionId} runs=${summary.ingested ?? 0} provider=${summary.provider}`);
    } else {
      log(`SessionEnd ingest failed session=${sessionId} status=${result.status} ${String(result.stderr || result.error || "").trim()}`);
    }
  }
} catch (error) {
  log(`hook error ${error.message}`);
}
process.exit(0);
