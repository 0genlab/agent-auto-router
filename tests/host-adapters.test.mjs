import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRoleRunStore } from "../adapters/jsonl/role-run-store.mjs";
import {
  detectClaudeProvider,
  ingestClaudeSessionFiles,
  parseClaudeSessionFile
} from "../adapters/claude/session-ingest.mjs";
import { createClaudeHostAdapter } from "../adapters/claude/host.mjs";
import {
  exportHermesRows,
  ingestHermesSessions,
  parseHermesDatabase,
  parseHermesRows
} from "../adapters/hermes/session-ingest.mjs";
import { createHermesHostAdapter, loadHermesCatalog } from "../adapters/hermes/host.mjs";
import { executeHostStage, prepareHostStage } from "../scripts/run-host-stage.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function billingPathHash(pathname) {
  return createHash("sha256").update(pathname).digest("hex").slice(0, 32);
}

test("Claude parses a valid final JSONL record without a trailing newline", () => {
  const root = tempRoot("0genlab-claude-final-line-");
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, JSON.stringify({
    type: "assistant",
    sessionId: "final-line",
    timestamp: "2026-09-23T02:40:00.000Z",
    message: { id: "last-message", model: "claude-model", usage: { input_tokens: 3, output_tokens: 2 } }
  }));
  const session = parseClaudeSessionFile(file);
  assert.equal(session.malformed_line_count, 0);
  assert.equal(session.usage.input_tokens, 3);
});

test("Claude legacy migration keeps a complete old run when the new run is incomplete", () => {
  const root = tempRoot("0genlab-claude-partial-migration-");
  const file = path.join(root, "session.jsonl");
  const sessionId = "partial-migration";
  const model = "claude-model";
  fs.writeFileSync(file, `${JSON.stringify({
    type: "assistant", sessionId, timestamp: "2026-09-23T02:40:00.000Z",
    message: { id: "message", model, usage: { input_tokens: 3, output_tokens: 2 } }
  })}\n`);
  const digest = (value) => `claude-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
  const oldId = digest([sessionId]);
  const newId = digest([sessionId, model]);
  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  for (const runId of [oldId, newId]) {
    store.createRun({
      schema_version: 1, run_id: runId, source: "claude-session-jsonl", session_id: sessionId, model
    }, { schema_version: 1, run_id: runId, event: "run_started" });
  }
  store.appendEvent(oldId, { schema_version: 1, run_id: oldId, event: "agent_finished", input_tokens: 3 });
  ingestClaudeSessionFiles({ files: [file], store });
  assert.equal(fs.existsSync(path.join(store.runsRoot, oldId)), false);
  assert.equal(fs.readdirSync(store.runsRoot).length, 1);
  assert.equal(store.readEvents({}).some((event) => event.event === "agent_finished" && event.input_tokens === 3), true);
});

test("Claude rebuilds a confirmed incomplete legacy run from the source session", () => {
  const root = tempRoot("0genlab-claude-incomplete-legacy-");
  const file = path.join(root, "session.jsonl");
  const sessionId = "incomplete-legacy";
  const model = "claude-model";
  fs.writeFileSync(file, `${JSON.stringify({
    type: "assistant", sessionId, timestamp: "2026-09-23T02:40:00.000Z",
    message: { id: "message", model, usage: { input_tokens: 3, output_tokens: 2 } }
  })}\n`);
  const oldId = `claude-${createHash("sha256").update(JSON.stringify([sessionId])).digest("hex").slice(0, 32)}`;
  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  store.createRun({
    schema_version: 1, run_id: oldId, source: "claude-session-jsonl", session_id: sessionId, model
  }, { schema_version: 1, run_id: oldId, event: "run_started" });
  const ingested = ingestClaudeSessionFiles({ files: [file], store });
  assert.equal(ingested.length, 1);
  assert.equal(fs.existsSync(path.join(store.runsRoot, oldId)), false);
  assert.equal(fs.readdirSync(store.runsRoot).length, 1);
  assert.equal(store.readEvents({}).find((event) => event.event === "agent_finished").input_tokens, 3);
});

test("host stage keeps estimated cost separate from actual cost", async () => {
  const root = tempRoot("0genlab-host-estimated-");
  const usageFile = path.join(root, "usage.json");
  fs.writeFileSync(usageFile, JSON.stringify({
    input_tokens: 2, output_tokens: 3, cost_usd: null, estimated_cost_usd: 0.25
  }));
  const prepared = prepareHostStage({
    host: "claude", role: "implementer", provider: "unknown", model: "claude-model",
    prompt: "hello",
    claudeAdapter: {
      name: "claude",
      validateRequest: ({ provider, model }) => ({ provider, model, provider_verified: false, audit_only: true }),
      buildCommand: () => ({ command: "fake-host", args: [], stdin: "hello" })
    }
  });
  const result = await executeHostStage({
    prepared, root, cwd: root, usageFile,
    spawnImpl() {
      const child = new EventEmitter();
      child.stdin = { end() {} };
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }
  });
  assert.equal(result.status, "success");
  const events = fs.readFileSync(path.join(root, "data", "role-runs", result.run_id, "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).cost_usd, null);
  assert.equal(events.at(-1).estimated_cost_usd, 0.25);
});

test("host stage CLI returns nonzero when the host exits unsuccessfully", () => {
  const root = tempRoot("0genlab-host-cli-failure-");
  const claudeHome = path.join(root, ".claude");
  fs.mkdirSync(claudeHome);
  fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({ model: "claude-model" }));
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-host-stage.mjs"),
    "--host", "claude", "--role", "implementer", "--provider", "unknown",
    "--model", "claude-model", "--prompt-file", "-", "--claude-home", claudeHome,
    "--root", root, "--execute"
  ], {
    cwd: root, encoding: "utf8", input: "hello",
    env: { ...process.env, CLAUDE_BIN: "/usr/bin/false" }
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "failed");
});

function writeClaudeFixture(root) {
  const home = path.join(root, ".claude");
  const sessions = path.join(home, "projects", "project-a");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ model: "claude-opus-5" }));
  const file = path.join(sessions, "session-1.jsonl");
  const records = [
    {
      type: "user",
      sessionId: "session-1",
      timestamp: "2026-09-23T01:00:00.000Z",
      cwd: "/workspace/project-a",
      gitBranch: "feature/test",
      version: "2.1.272",
      message: { role: "user", content: "SECRET_PROMPT_SENTINEL" }
    },
    {
      type: "assistant",
      sessionId: "session-1",
      timestamp: "2026-09-23T01:00:01.000Z",
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        content: [{ type: "text", text: "SECRET_RESPONSE_SENTINEL" }],
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 7
        }
      }
    },
    {
      type: "assistant",
      sessionId: "session-1",
      timestamp: "2026-09-23T01:00:01.100Z",
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        content: [{ type: "text", text: "SECRET_RESPONSE_SENTINEL" }],
        usage: {
          input_tokens: 4,
          output_tokens: 6,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 10
        }
      }
    },
    {
      type: "assistant",
      sessionId: "session-1",
      timestamp: "2026-09-23T01:00:02.000Z",
      message: {
        id: "msg-2",
        model: "claude-opus-5",
        content: [{ type: "text", text: "SECRET_RESPONSE_SENTINEL" }],
        usage: {
          input_tokens: 4,
          output_tokens: 5,
          cache_read_input_tokens: 6,
          cache_creation_input_tokens: 8
        }
      }
    }
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return { home, file };
}

function createHermesFixture(root) {
  const database = path.join(root, "state.db");
  const python = String.raw`
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.executescript("""
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    model TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    billing_provider TEXT,
    billing_base_url TEXT,
    billing_mode TEXT,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    cost_status TEXT,
    cost_source TEXT,
    cwd TEXT,
    api_call_count INTEGER DEFAULT 0,
    last_activity_at REAL,
    git_branch TEXT
);
CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    billing_provider TEXT NOT NULL DEFAULT '',
    billing_base_url TEXT NOT NULL DEFAULT '',
    billing_mode TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '',
    api_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0,
    cost_status TEXT,
    cost_source TEXT,
    first_seen REAL,
    last_seen REAL,
    PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
);
CREATE TABLE messages (session_id TEXT, content TEXT);
""")
connection.execute(
    "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ("session-1", "cli", "claude-opus-4.8", None, 100.0, 102.0, "completed", 4, 1,
     100, 10, 20, 0, 5, "nous", "https://inference.nousresearch.com", "", 0.0, None,
     "unknown", "none", "/workspace/hermes", 2, 102.0, "main")
)
connection.execute(
    "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ("session-2", "cli", "gpt-5-mini", None, 200.0, 201.0, None, 1, 0,
     20, 4, 0, 0, 0, "ccsub", "https://ccsub.inferera.com/v1", "", 0.1, None,
     "estimated", "provider", "/workspace/hermes", 1, 201.0, None)
)
connection.executemany(
    "INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      ("session-1", "claude-opus-4.8", "nous", "https://inference.nousresearch.com", "", "", 2, 15, 3, 5, 0, 1, 0.03, 0.0, "estimated", "provider", 100.0, 102.0),
      ("session-1", "claude-sonnet-5", "aihubmix", "https://aihubmix.com/v1", "", "title_generation", 2, 25, 6, 0, 2, 0, 0.0, 0.0, "unknown", "none", 101.0, 102.0),
      ("session-2", "gpt-5-mini", "ccsub", "https://ccsub.inferera.com/v1", "", "", 1, 20, 4, 0, 0, 0, 0.1, 0.0, "estimated", "provider", 200.0, 201.0)
    ]
)
connection.execute("INSERT INTO messages VALUES (?, ?)", ("session-1", "SECRET_MESSAGE_SENTINEL"))
connection.commit()
connection.close()
`;
  const result = spawnSync("python3", ["-c", python, database], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return database;
}

test("Claude ingestion keeps metadata, retains the latest message usage, and stays provider-unknown without evidence", () => {
  const root = tempRoot("0genlab-claude-");
  const { file } = writeClaudeFixture(root);
  const session = parseClaudeSessionFile(file, { provider: "unknown" });

  assert.equal(session.provider, "unknown");
  assert.equal(session.provider_verified, false);
  assert.equal(session.model, "claude-opus-5");
  assert.equal(session.usage.api_calls, 2);
  assert.equal(session.usage.input_tokens, 8);
  assert.equal(session.usage.output_tokens, 11);
  assert.equal(session.usage.cache_read_tokens, 14);
  assert.equal(session.usage.cache_write_tokens, 18);
  assert.equal(JSON.stringify(session).includes("SECRET_PROMPT_SENTINEL"), false);
  assert.equal(JSON.stringify(session).includes("SECRET_RESPONSE_SENTINEL"), false);

  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  const first = ingestClaudeSessionFiles({ files: [file], store, provider: "unknown" });
  const second = ingestClaudeSessionFiles({ files: [file], store, provider: "unknown" });
  const refreshed = ingestClaudeSessionFiles({ files: [file], store, provider: "unknown", refresh: true });

  assert.match(first[0].run_id, /^claude-[a-f0-9]{32}$/);
  assert.equal(second.length, 0);
  assert.equal(refreshed.length, 1);
  const event = JSON.parse(fs.readFileSync(path.join(store.runsRoot, first[0].run_id, "events.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(event.provider, "unknown");
  assert.equal(event.provider_verified, false);
  assert.equal(event.input_tokens, 8);
  assert.equal(JSON.stringify(event).includes("SECRET_"), false);
});

test("Claude provider is only marked verified when settings or a base URL proves the route", () => {
  assert.deepEqual(
    detectClaudeProvider({ settings: { model: "claude-opus-5" }, env: {} }),
    {
      provider: "unknown",
      verified: false,
      evidence: "no-verifiable-provider-route",
      base_url: null
    }
  );
  assert.equal(
    detectClaudeProvider({ settings: { provider: "aihubmix" }, env: {} }).provider,
    "unknown"
  );
  assert.equal(
    detectClaudeProvider({ settings: { env: { ANTHROPIC_BASE_URL: "https://aihubmix.com/v1" } }, env: {} }).provider,
    "aihubmix"
  );
  assert.equal(
    detectClaudeProvider({ settings: {}, env: { ANTHROPIC_BASE_URL: "https://aihubmix.com/v1" } }).provider,
    "aihubmix"
  );
  assert.deepEqual(
    detectClaudeProvider({ settings: {}, env: { ANTHROPIC_BASE_URL: "http://aihubmix.com/v1" } }),
    {
      provider: "unknown",
      verified: false,
      evidence: "no-verifiable-provider-route",
      base_url: "http://aihubmix.com/v1"
    }
  );

  const adapter = createClaudeHostAdapter({ settings: { model: "claude-opus-5" }, env: {} });
  assert.deepEqual(adapter.validateRequest({ provider: "unknown", model: "claude-opus-5" }), {
    provider: "unknown",
    model: "claude-opus-5",
    provider_verified: false,
    audit_only: true,
    provider_evidence: "no-verifiable-provider-route"
  });
  assert.throws(
    () => adapter.validateRequest({ provider: "aihubmix", model: "claude-opus-5" }),
    /not verifiably configured/
  );
  assert.throws(
    () => adapter.validateRequest({ provider: "unknown", model: "claude-unknown" }),
    /unknown Claude model/
  );
});

test("Claude run IDs hash untrusted session IDs instead of using them as paths", () => {
  const root = tempRoot("0genlab-claude-path-");
  const file = path.join(root, "untrusted.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({
    type: "assistant",
    sessionId: "../../escaped",
    timestamp: "2026-09-23T01:00:00.000Z",
    message: {
      id: "msg-1",
      model: "claude-opus-5",
      usage: { input_tokens: 1, output_tokens: 1 }
    }
  })}\n`);
  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  const ingested = ingestClaudeSessionFiles({ files: [file], store, provider: "unknown" });

  const expectedRunId = `claude-${createHash("sha256")
    .update(JSON.stringify(["../../escaped", "claude-opus-5"]))
    .digest("hex")
    .slice(0, 32)}`;
  assert.equal(ingested[0].run_id, expectedRunId);
  assert.equal(fs.existsSync(path.join(store.runsRoot, ingested[0].run_id, "events.jsonl")), true);
  assert.equal(fs.existsSync(path.join(root, "escaped")), false);
});

test("Claude adding a second model reuses the first model run instead of leaving an aggregate duplicate", () => {
  const root = tempRoot("0genlab-claude-growing-session-");
  const file = path.join(root, "growing.jsonl");
  const firstRecord = {
    type: "assistant",
    sessionId: "growing-session",
    timestamp: "2026-09-23T02:30:00.000Z",
    message: {
      id: "msg-a",
      model: "claude-model-a",
      usage: { input_tokens: 1, output_tokens: 1 }
    }
  };
  const secondRecord = {
    type: "assistant",
    sessionId: "growing-session",
    timestamp: "2026-09-23T02:30:01.000Z",
    message: {
      id: "msg-b",
      model: "claude-model-b",
      usage: { input_tokens: 2, output_tokens: 2 }
    }
  };
  fs.writeFileSync(file, `${JSON.stringify(firstRecord)}\n`);

  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  const first = ingestClaudeSessionFiles({ files: [file], store });
  assert.equal(first.length, 1);
  assert.equal(first[0].model, "claude-model-a");

  fs.appendFileSync(file, `${JSON.stringify(secondRecord)}\n`);
  const second = ingestClaudeSessionFiles({ files: [file], store });
  assert.equal(second.length, 1);
  assert.equal(second[0].model, "claude-model-b");
  assert.equal(second[0].run_id, `claude-${createHash("sha256")
    .update(JSON.stringify(["growing-session", "claude-model-b"]))
    .digest("hex")
    .slice(0, 32)}`);

  const expectedModelARunId = `claude-${createHash("sha256")
    .update(JSON.stringify(["growing-session", "claude-model-a"]))
    .digest("hex")
    .slice(0, 32)}`;
  assert.equal(first[0].run_id, expectedModelARunId);
  assert.equal(fs.existsSync(path.join(store.runsRoot, expectedModelARunId, "events.jsonl")), true);
  assert.equal(fs.readdirSync(store.runsRoot).length, 2);
  const finished = fs.readFileSync(path.join(store.runsRoot, expectedModelARunId, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .at(-1);
  assert.equal(finished.input_tokens, 1);
  assert.equal(finished.output_tokens, 1);
});

test("Claude appending messages to the same model refreshes the existing run by default", () => {
  const root = tempRoot("0genlab-claude-growing-same-model-");
  const file = path.join(root, "growing.jsonl");
  const sessionId = "growing-same-model";
  const model = "claude-model-a";
  const records = [
    {
      type: "assistant",
      sessionId,
      timestamp: "2026-09-23T02:35:00.000Z",
      message: {
        id: "msg-a",
        model,
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    },
    {
      type: "assistant",
      sessionId,
      timestamp: "2026-09-23T02:35:01.000Z",
      message: {
        id: "msg-b",
        model,
        usage: { input_tokens: 2, output_tokens: 2 }
      }
    }
  ];
  fs.writeFileSync(file, `${JSON.stringify(records[0])}\n`);

  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  const first = ingestClaudeSessionFiles({ files: [file], store });
  fs.appendFileSync(file, `${JSON.stringify(records[1])}\n`);
  const second = ingestClaudeSessionFiles({ files: [file], store });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].run_id, first[0].run_id);
  assert.equal(fs.readdirSync(store.runsRoot).length, 1);
  const finished = JSON.parse(fs.readFileSync(path.join(store.runsRoot, first[0].run_id, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .at(-1));
  assert.equal(finished.input_tokens, 3);
  assert.equal(finished.output_tokens, 3);
  assert.equal(finished.total_tokens, 6);
});

test("Claude ingestion migrates a confirmed legacy single-model run and preserves refresh behavior", () => {
  const root = tempRoot("0genlab-claude-legacy-migrate-");
  const file = path.join(root, "legacy.jsonl");
  const sessionId = "legacy-session";
  const model = "claude-model-a";
  fs.writeFileSync(file, `${JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp: "2026-09-23T02:40:00.000Z",
    message: {
      id: "msg-a",
      model,
      usage: { input_tokens: 1, output_tokens: 1 }
    }
  })}\n`);

  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  const legacyRunId = `claude-${createHash("sha256")
    .update(JSON.stringify([sessionId]))
    .digest("hex")
    .slice(0, 32)}`;
  const runId = `claude-${createHash("sha256")
    .update(JSON.stringify([sessionId, model]))
    .digest("hex")
    .slice(0, 32)}`;
  store.createRun({
    schema_version: 1,
    run_id: legacyRunId,
    source: "claude-session-jsonl",
    session_id: sessionId,
    model,
    started_at: "2026-09-23T02:40:00.000Z"
  }, {
    schema_version: 1,
    run_id: legacyRunId,
    event: "run_started",
    model,
    provider: "unknown"
  });
  store.appendEvent(legacyRunId, {
    schema_version: 1,
    run_id: legacyRunId,
    event: "agent_finished",
    model,
    provider: "unknown",
    note: "legacy-preserved"
  });

  const migrated = ingestClaudeSessionFiles({ files: [file], store });
  assert.equal(migrated.length, 0);
  assert.equal(fs.existsSync(path.join(store.runsRoot, legacyRunId)), false);
  assert.equal(fs.existsSync(path.join(store.runsRoot, runId)), true);
  assert.equal(fs.readdirSync(store.runsRoot).length, 1);
  const migratedManifest = JSON.parse(fs.readFileSync(path.join(store.runsRoot, runId, "manifest.json"), "utf8"));
  assert.equal(migratedManifest.run_id, runId);
  const migratedEvents = fs.readFileSync(path.join(store.runsRoot, runId, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(migratedEvents.every((event) => event.run_id === runId), true);
  assert.equal(migratedEvents.at(-1).note, "legacy-preserved");

  const refreshed = ingestClaudeSessionFiles({ files: [file], store, refresh: true });
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].run_id, runId);
  const refreshedEvents = fs.readFileSync(path.join(store.runsRoot, runId, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(refreshedEvents.length, 2);
  assert.equal(refreshedEvents.at(-1).note, "passive ingestion from Claude Code session JSONL; metadata only");
});

test("Claude legacy migration refreshes the first model when a second model is appended", () => {
  const root = tempRoot("0genlab-claude-legacy-append-");
  const file = path.join(root, "session.jsonl");
  const sessionId = "legacy-append-session";
  const firstModel = "claude-model-a";
  const secondModel = "claude-model-b";
  const legacyRunId = `claude-${createHash("sha256")
    .update(JSON.stringify([sessionId]))
    .digest("hex")
    .slice(0, 32)}`;
  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  store.createRun({
    schema_version: 1,
    run_id: legacyRunId,
    source: "claude-session-jsonl",
    session_id: sessionId,
    model: firstModel
  }, {
    schema_version: 1,
    run_id: legacyRunId,
    event: "run_started",
    model: firstModel
  });
  store.appendEvent(legacyRunId, {
    schema_version: 1,
    run_id: legacyRunId,
    event: "agent_finished",
    model: firstModel,
    input_tokens: 1
  });
  fs.writeFileSync(file, [
    { type: "assistant", sessionId, timestamp: "2026-09-23T02:40:00.000Z", message: { id: "msg-a", model: firstModel, usage: { input_tokens: 2, output_tokens: 1 } } },
    { type: "assistant", sessionId, timestamp: "2026-09-23T02:41:00.000Z", message: { id: "msg-b", model: secondModel, usage: { input_tokens: 3, output_tokens: 1 } } }
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const ingested = ingestClaudeSessionFiles({ files: [file], store });
  assert.equal(ingested.length, 2);
  assert.equal(fs.readdirSync(store.runsRoot).length, 2);
  const firstRun = ingested.find((item) => item.model === firstModel);
  const firstEvents = store.readEvents({ model: firstModel });
  assert.equal(firstRun.run_id !== legacyRunId, true);
  assert.equal(firstEvents.find((event) => event.event === "agent_finished").input_tokens, 2);
});

test("Claude ingestion leaves legacy-looking directories untouched unless the manifest confirms the import", () => {
  const mismatches = [
    { name: "session", session_id: "other-session", source: "claude-session-jsonl", run_id: null },
    { name: "source", session_id: "unmatched-session", source: "other-source", run_id: null },
    { name: "run-id", session_id: "unmatched-session", source: "claude-session-jsonl", run_id: "other-run" }
  ];

  for (const mismatch of mismatches) {
    const root = tempRoot(`0genlab-claude-legacy-${mismatch.name}-`);
    const file = path.join(root, "session.jsonl");
    const sessionId = "unmatched-session";
    const model = "claude-model-a";
    fs.writeFileSync(file, `${JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: "2026-09-23T02:50:00.000Z",
      message: {
        id: "msg-a",
        model,
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    })}\n`);

    const store = createRoleRunStore(path.join(root, "data", "role-runs"));
    const legacyRunId = `claude-${createHash("sha256")
      .update(JSON.stringify([sessionId]))
      .digest("hex")
      .slice(0, 32)}`;
    store.createRun({
      schema_version: 1,
      run_id: legacyRunId,
      session_id: mismatch.session_id,
      source: mismatch.source,
      started_at: "2026-09-23T02:50:00.000Z"
    }, {
      schema_version: 1,
      run_id: legacyRunId,
      event: "run_started",
      model,
      provider: "unknown"
    });
    if (mismatch.run_id) {
      const manifestPath = path.join(store.runsRoot, legacyRunId, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.run_id = mismatch.run_id;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    const ingested = ingestClaudeSessionFiles({ files: [file], store });
    assert.equal(ingested.length, 1, mismatch.name);
    assert.equal(fs.existsSync(path.join(store.runsRoot, legacyRunId)), true, mismatch.name);
    assert.equal(fs.readdirSync(store.runsRoot).length, 2, mismatch.name);
  }
});

test("Claude mixed-model usage keeps the aggregate and creates independent model runs", () => {
  const root = tempRoot("0genlab-claude-models-");
  const file = path.join(root, "mixed.jsonl");
  const records = [
    {
      type: "assistant",
      sessionId: "mixed-session",
      timestamp: "2026-09-23T02:00:00.000Z",
      message: {
        id: "msg-a",
        model: "claude-model-a",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    },
    {
      type: "assistant",
      sessionId: "mixed-session",
      timestamp: "2026-09-23T02:00:01.000Z",
      message: {
        id: "msg-b",
        model: "claude-model-b",
        usage: { input_tokens: 2, output_tokens: 2 }
      }
    }
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const session = parseClaudeSessionFile(file);
  assert.equal(session.usage.input_tokens, 3);
  assert.equal(session.usage.output_tokens, 3);
  assert.deepEqual(session.models, ["claude-model-a", "claude-model-b"]);
  assert.equal(session.model_groups.length, 2);
  assert.equal(session.model_groups.find((group) => group.model === "claude-model-a").usage.input_tokens, 1);
  assert.equal(session.model_groups.find((group) => group.model === "claude-model-b").usage.output_tokens, 2);

  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  const priceSnapshots = {
    aihubmix: {
      provider: "aihubmix",
      models: {
        "claude-model-a": { input_price_per_million: 1, output_price_per_million: 2 },
        "claude-model-b": { input_price_per_million: 3, output_price_per_million: 4 }
      }
    }
  };
  const ingested = ingestClaudeSessionFiles({
    files: [file],
    store,
    auditedProvider: "aihubmix",
    priceSnapshots
  });

  assert.equal(ingested.length, 2);
  assert.equal(new Set(ingested.map((item) => item.run_id)).size, 2);
  for (const item of ingested) {
    const expectedRunId = `claude-${createHash("sha256")
      .update(JSON.stringify(["mixed-session", item.model]))
      .digest("hex")
      .slice(0, 32)}`;
    assert.equal(item.run_id, expectedRunId);
    const events = fs.readFileSync(path.join(store.runsRoot, item.run_id, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).model, item.model);
    assert.equal(events.at(-1).provider, "aihubmix");
    assert.equal(events.at(-1).provider_verified, true);
  }
  const costs = Object.fromEntries(ingested.map((item) => [
    item.model,
    JSON.parse(fs.readFileSync(path.join(store.runsRoot, item.run_id, "events.jsonl"), "utf8").trim().split("\n").at(-1)).cost_usd
  ]));
  assert.ok(Math.abs(costs["claude-model-a"] - 0.000003) < 1e-12);
  assert.ok(Math.abs(costs["claude-model-b"] - 0.000014) < 1e-12);
});

test("Claude parsing streams long files, skips malformed or truncated lines, and bounds timestamps", () => {
  const root = tempRoot("0genlab-claude-stream-");
  const file = path.join(root, "long.jsonl");
  const padding = "x".repeat(70 * 1024);
  fs.writeFileSync(file, [
    JSON.stringify({
      type: "user",
      sessionId: "stream-session",
      timestamp: "2026-09-23T03:00:02.000Z",
      baseUrl: "http://aihubmix.com/v1",
      message: { content: padding }
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "stream-session",
      timestamp: "2026-09-23T03:00:00.000Z",
      message: { id: "msg-1", model: "claude-model-a", usage: { input_tokens: 1, output_tokens: 1 } }
    }),
    "{not-json",
    JSON.stringify({
      type: "assistant",
      sessionId: "stream-session",
      timestamp: "2026-09-23T03:00:03.000Z",
      message: { id: "msg-2", model: "claude-model-a", usage: { input_tokens: 2, output_tokens: 2 } }
    }),
    "{\"type\":\"assistant\""
  ].join("\n"));

  const session = parseClaudeSessionFile(file);
  assert.equal(session.started_at, "2026-09-23T03:00:00.000Z");
  assert.equal(session.ended_at, "2026-09-23T03:00:03.000Z");
  assert.equal(session.latency_ms, 3000);
  assert.equal(session.malformed_line_count, 2);
  assert.equal(session.usage.input_tokens, 3);
  assert.equal(session.provider, "unknown");
  assert.equal(session.provider_verified, false);

  const evidenceFile = path.join(root, "evidence.jsonl");
  fs.writeFileSync(evidenceFile, `${JSON.stringify({
    type: "system",
    sessionId: "evidence-session",
    timestamp: "2026-09-23T03:10:00.000Z",
    env: { ANTHROPIC_BASE_URL: "https://aihubmix.com/v1" }
  })}\n`);
  const evidenced = parseClaudeSessionFile(evidenceFile);
  assert.equal(evidenced.provider, "aihubmix");
  assert.equal(evidenced.provider_verified, true);
  assert.equal(evidenced.provider_evidence, "session-base-url");
});

test("Claude parsing does not spread long per-model timestamp arrays", () => {
  const root = tempRoot("0genlab-claude-many-timestamps-");
  const file = path.join(root, "many-timestamps.jsonl");
  const recordCount = 150_000;
  const records = new Array(recordCount);
  for (let index = 0; index < recordCount; index += 1) {
    records[index] = JSON.stringify({
      type: "assistant",
      sessionId: "many-timestamps",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      message: {
        id: `msg-${index}`,
        model: "claude-model-a",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    });
  }
  fs.writeFileSync(file, `${records.join("\n")}\n`);

  const session = parseClaudeSessionFile(file);
  assert.equal(session.model_groups.length, 1);
  assert.equal(session.model_groups[0].usage.api_calls, recordCount);
  assert.equal(session.model_groups[0].started_at, "2026-01-01T00:00:00.000Z");
  assert.equal(session.model_groups[0].ended_at, "2026-01-01T00:02:29.999Z");
});

test("Claude historical ingestion ignores current settings and only accepts audited overrides", () => {
  const root = tempRoot("0genlab-claude-history-");
  const home = path.join(root, ".claude");
  const sessions = path.join(home, "projects", "historical");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://aihubmix.com/v1" }
  }));
  const file = path.join(sessions, "history.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({
    type: "assistant",
    sessionId: "history-session",
    timestamp: "2026-09-23T04:00:00.000Z",
    message: { id: "msg-1", model: "claude-model-a", usage: { input_tokens: 1, output_tokens: 1 } }
  })}\n`);

  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "ingest-claude-sessions.mjs"),
    "--sessions-dir", sessions,
    "--claude-home", home,
    "--price-snapshots-dir", path.join(root, "missing-prices")
  ], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ROLEBENCH_ROOT: root } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, "unknown");
  assert.equal(output.provider_verified, false);
  const event = JSON.parse(fs.readFileSync(path.join(root, "data", "role-runs", output.runs[0].run_id, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .at(-1));
  assert.equal(event.provider, "unknown");
  assert.equal(event.provider_verified, false);

  const audited = parseClaudeSessionFile(file, { auditedProvider: "aihubmix" });
  assert.equal(audited.provider, "aihubmix");
  assert.equal(audited.provider_verified, true);
  assert.equal(audited.provider_evidence, "audited-provider-override");
});

test("Claude audited provider does not override conflicting HTTPS session evidence", () => {
  const root = tempRoot("0genlab-claude-audited-conflict-");
  const file = path.join(root, "history.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({
      type: "system",
      sessionId: "audited-conflict",
      timestamp: "2026-09-23T04:10:00.000Z",
      env: { ANTHROPIC_BASE_URL: "https://aihubmix.com/v1" }
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "audited-conflict",
      timestamp: "2026-09-23T04:10:01.000Z",
      message: { id: "msg-1", model: "claude-model-a", usage: { input_tokens: 1, output_tokens: 1 } }
    })
  ].join("\n") + "\n");

  const session = parseClaudeSessionFile(file, { auditedProvider: "openrouter" });
  assert.equal(session.provider, "aihubmix");
  assert.equal(session.provider_verified, true);
  assert.equal(session.provider_evidence, "session-base-url");
});

test("Hermes ingestion reads only session metadata and usage rows, splits mixed identities, and is idempotent", () => {
  const root = tempRoot("0genlab-hermes-");
  const database = createHermesFixture(root);
  const exported = exportHermesRows({ database });
  assert.equal(JSON.stringify(exported).includes("SECRET_MESSAGE_SENTINEL"), false);

  const records = parseHermesDatabase({
    exported,
    providerAliases: { ccsub: "sub2api" }
  });
  assert.equal(records.length, 3);
  const nous = records.find((record) => record.session_id === "session-1" && record.provider === "nous");
  const aihubmix = records.find((record) => record.session_id === "session-1" && record.provider === "aihubmix");
  const sub2api = records.find((record) => record.session_id === "session-2");
  assert.equal(nous.usage.input_tokens, 100);
  assert.equal(nous.usage.output_tokens, 10);
  assert.equal(nous.usage.api_calls, 2);
  assert.equal(nous.trusted_cost_usd, null);
  assert.equal(nous.estimated_cost_usd, 0.03);
  assert.equal(aihubmix.usage.input_tokens, 25);
  assert.equal(aihubmix.usage.output_tokens, 6);
  assert.equal(aihubmix.trusted_cost_usd, null);
  assert.equal(aihubmix.estimated_cost_usd, null);
  assert.equal(sub2api.provider, "sub2api");
  assert.equal(sub2api.trusted_cost_usd, null);
  assert.equal(sub2api.estimated_cost_usd, 0.1);

  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  const first = ingestHermesSessions({ store, exported, providerAliases: { ccsub: "sub2api" } });
  const second = ingestHermesSessions({ store, exported, providerAliases: { ccsub: "sub2api" } });
  assert.equal(first.length, 3);
  assert.equal(second.length, 0);
  for (const item of first) assert.match(item.run_id, /^hermes-[a-f0-9]{32}$/);
  assert.equal(new Set(first.map((item) => item.run_id)).size, 3);
  for (const item of first) {
    const text = fs.readFileSync(path.join(store.runsRoot, item.run_id, "events.jsonl"), "utf8");
    assert.equal(text.includes("SECRET_MESSAGE_SENTINEL"), false);
  }
});

test("Hermes export tolerates older schemas with missing columns and no usage table", () => {
  const root = tempRoot("0genlab-hermes-old-");
  const database = path.join(root, "old-state.db");
  const python = String.raw`
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, started_at REAL)")
connection.execute("INSERT INTO sessions VALUES (?, ?, ?)", ("old-session", "legacy-model", 123.0))
connection.commit()
connection.close()
`;
  const created = spawnSync("python3", ["-c", python, database], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);

  const exported = exportHermesRows({ database });
  assert.equal(exported.sessions.length, 1);
  assert.deepEqual(exported.usage, []);
  const records = parseHermesDatabase({ exported });
  assert.equal(records.length, 1);
  assert.equal(records[0].provider, "unknown");
  assert.equal(records[0].model, "legacy-model");
  assert.equal(records[0].usage.input_tokens, null);
  assert.equal(records[0].status, "unknown");
});

test("Hermes keeps session usage residual on an unambiguous main group without double-counting auxiliary tasks", () => {
  const exported = {
    sessions: [{
      id: "residual-session",
      source: "cli",
      model: "main-model",
      started_at: 1,
      ended_at: 2,
      end_reason: "completed",
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 7,
      cache_write_tokens: 8,
      reasoning_tokens: 9,
      billing_provider: "aihubmix",
      billing_base_url: "https://aihubmix.com/v1",
      billing_mode: "",
      api_call_count: 4,
      estimated_cost_usd: 1.25,
      cost_status: "estimated",
      cost_source: "provider"
    }],
    usage: [
      {
        session_id: "residual-session",
        model: "main-model",
        billing_provider: "aihubmix",
        billing_base_url: "https://aihubmix.com/v1",
        billing_mode: "",
        task: "",
        api_call_count: 3,
        input_tokens: 70,
        output_tokens: 30,
        cache_read_tokens: 5,
        cache_write_tokens: 6,
        reasoning_tokens: 7,
        estimated_cost_usd: 1,
        actual_cost_usd: 0,
        cost_status: "estimated",
        cost_source: "provider"
      },
      {
        session_id: "residual-session",
        model: "auxiliary-model",
        billing_provider: "aihubmix",
        billing_base_url: "https://aihubmix.com/v1",
        billing_mode: "",
        task: "title_generation",
        api_call_count: 1,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost_usd: 0.25,
        actual_cost_usd: 0,
        cost_status: "estimated",
        cost_source: "provider"
      }
    ]
  };

  const records = parseHermesRows(exported);
  const main = records.find((record) => record.model === "main-model");
  const auxiliary = records.find((record) => record.model === "auxiliary-model");
  assert.equal(main.usage.api_calls, 4);
  assert.equal(main.usage.input_tokens, 100);
  assert.equal(main.usage.output_tokens, 40);
  assert.equal(main.usage.total_tokens, 140);
  assert.equal(main.usage.cache_read_tokens, 7);
  assert.equal(main.usage.cache_write_tokens, 8);
  assert.equal(main.usage.reasoning_tokens, 9);
  assert.equal(main.estimated_cost_usd, 1.25);
  assert.equal(auxiliary.usage.input_tokens, 10);
  assert.equal(auxiliary.usage.output_tokens, 5);
  assert.equal(auxiliary.estimated_cost_usd, 0.25);
  assert.equal(
    records.reduce((sum, record) => sum + record.estimated_cost_usd, 0),
    1.5
  );
});

test("Hermes keeps auxiliary usage once when main and auxiliary rows share an identity", () => {
  const exported = {
    sessions: [{
      id: "shared-identity-residual-session",
      source: "cli",
      model: "shared-model",
      started_at: 1,
      ended_at: 2,
      input_tokens: 100,
      output_tokens: 40,
      api_call_count: 4,
      estimated_cost_usd: 1.25,
      cost_status: "estimated",
      cost_source: "provider"
    }],
    usage: [
      {
        session_id: "shared-identity-residual-session",
        model: "shared-model",
        billing_provider: "aihubmix",
        billing_base_url: "https://aihubmix.com/v1",
        billing_mode: "",
        task: "",
        api_call_count: 3,
        input_tokens: 70,
        output_tokens: 30,
        estimated_cost_usd: 1,
        cost_status: "estimated",
        cost_source: "provider"
      },
      {
        session_id: "shared-identity-residual-session",
        model: "shared-model",
        billing_provider: "aihubmix",
        billing_base_url: "https://aihubmix.com/v1",
        billing_mode: "",
        task: "title_generation",
        api_call_count: 1,
        input_tokens: 10,
        output_tokens: 5,
        estimated_cost_usd: 0.25,
        cost_status: "estimated",
        cost_source: "provider"
      }
    ]
  };

  const [record] = parseHermesRows(exported);
  assert.equal(record.usage.api_calls, 5);
  assert.equal(record.usage.input_tokens, 110);
  assert.equal(record.usage.output_tokens, 45);
  assert.equal(record.usage.total_tokens, 155);
  assert.equal(record.estimated_cost_usd, 1.5);
});

test("Hermes does not assign session residual when multiple main identities are plausible", () => {
  const exported = {
    sessions: [{
      id: "ambiguous-session",
      source: "cli",
      model: "fallback-model",
      started_at: 1,
      ended_at: 2,
      input_tokens: 100,
      output_tokens: 50,
      api_call_count: 4
    }],
    usage: [
      {
        session_id: "ambiguous-session",
        model: "model-a",
        task: "",
        api_call_count: 2,
        input_tokens: 20,
        output_tokens: 10
      },
      {
        session_id: "ambiguous-session",
        model: "model-b",
        task: "",
        api_call_count: 1,
        input_tokens: 10,
        output_tokens: 5
      }
    ]
  };

  const records = parseHermesRows(exported);
  assert.equal(records.length, 2);
  assert.equal(records.find((record) => record.model === "model-a").usage.input_tokens, 20);
  assert.equal(records.find((record) => record.model === "model-b").usage.input_tokens, 10);
  assert.equal(records.some((record) => record.usage.input_tokens === 100), false);
});

test("Hermes does not assign session residual to auxiliary-only usage", () => {
  const exported = {
    sessions: [{
      id: "auxiliary-only-session",
      source: "cli",
      model: "main-model",
      started_at: 1,
      ended_at: 2,
      input_tokens: 100,
      output_tokens: 40,
      api_call_count: 4,
      estimated_cost_usd: 1.25,
      cost_status: "estimated",
      cost_source: "provider"
    }],
    usage: [{
      session_id: "auxiliary-only-session",
      model: "auxiliary-model",
      billing_provider: "aihubmix",
      billing_base_url: "https://aihubmix.com/v1",
      billing_mode: "",
      task: "title_generation",
      api_call_count: 1,
      input_tokens: 10,
      output_tokens: 5,
      estimated_cost_usd: 0.25,
      cost_status: "estimated",
      cost_source: "provider"
    }]
  };

  const [record] = parseHermesRows(exported);
  assert.equal(record.model, "auxiliary-model");
  assert.equal(record.usage.input_tokens, 10);
  assert.equal(record.usage.output_tokens, 5);
  assert.equal(record.usage.api_calls, 1);
  assert.equal(record.estimated_cost_usd, 0.25);
});

test("Hermes does not treat missing main-row usage or cost as zero residual", () => {
  const exported = {
    sessions: [{
      id: "partial-residual-session",
      source: "cli",
      model: "main-model",
      started_at: 1,
      ended_at: 2,
      input_tokens: 100,
      output_tokens: 40,
      estimated_cost_usd: 1.25,
      cost_status: "estimated",
      cost_source: "provider"
    }],
    usage: [{
      session_id: "partial-residual-session",
      model: "main-model",
      billing_provider: "aihubmix",
      billing_base_url: "https://aihubmix.com/v1",
      billing_mode: "",
      task: "",
      input_tokens: 70,
      output_tokens: null,
      estimated_cost_usd: null,
      cost_status: "estimated",
      cost_source: "provider"
    }]
  };

  const [record] = parseHermesRows(exported);
  assert.equal(record.usage.input_tokens, 100);
  assert.equal(record.usage.output_tokens, null);
  assert.equal(record.usage.total_tokens, null);
  assert.equal(record.estimated_cost_usd, null);
});

test("Hermes keeps an all-null usage row as unknown instead of zero", () => {
  const exported = {
    sessions: [{
      id: "unknown-usage-session",
      source: "cli",
      model: "unknown-usage-model",
      started_at: 1,
      ended_at: 2
    }],
    usage: [{
      session_id: "unknown-usage-session",
      model: "unknown-usage-model",
      billing_provider: "",
      billing_base_url: "",
      billing_mode: "",
      task: "",
      api_call_count: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      cost_status: null,
      cost_source: null
    }]
  };

  const [record] = parseHermesRows(exported);
  assert.deepEqual(record.usage, {
    api_calls: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    cost_usd: null
  });
  assert.equal(record.trusted_cost_usd, null);
  assert.equal(record.estimated_cost_usd, null);
});

test("Hermes actual and estimated costs remain distinct without treating schema defaults as actual", () => {
  const exported = {
    sessions: [{
      id: "cost-session",
      source: "cli",
      model: "fallback-model",
      started_at: 1,
      ended_at: 2,
      end_reason: "completed",
      billing_provider: "aihubmix",
      billing_base_url: "https://aihubmix.com/v1"
    }],
    usage: [
      {
        session_id: "cost-session",
        model: "model-actual-zero",
        billing_provider: "aihubmix",
        billing_base_url: "https://aihubmix.com/v1",
        billing_mode: "",
        api_call_count: 1,
        input_tokens: 1,
        output_tokens: 1,
        actual_cost_usd: 0,
        estimated_cost_usd: 9,
        cost_status: "actual",
        cost_source: "provider"
      },
      {
        session_id: "cost-session",
        model: "model-estimated",
        billing_provider: "aihubmix",
        billing_base_url: "https://aihubmix.com/v1",
        billing_mode: "",
        api_call_count: 1,
        input_tokens: 1,
        output_tokens: 1,
        actual_cost_usd: 99,
        estimated_cost_usd: 0.25,
        cost_status: "estimated",
        cost_source: "provider"
      },
      {
        session_id: "cost-session",
        model: "model-unknown",
        billing_provider: "aihubmix",
        billing_base_url: "https://aihubmix.com/v1",
        billing_mode: "",
        api_call_count: 1,
        input_tokens: 1,
        output_tokens: 1,
        actual_cost_usd: 5,
        estimated_cost_usd: 0,
        cost_status: "unknown",
        cost_source: "none"
      }
    ]
  };

  const records = parseHermesRows(exported);
  assert.equal(records.find((record) => record.model === "model-actual-zero").trusted_cost_usd, 0);
  assert.equal(records.find((record) => record.model === "model-estimated").trusted_cost_usd, null);
  assert.equal(records.find((record) => record.model === "model-estimated").estimated_cost_usd, 0.25);
  assert.equal(records.find((record) => record.model === "model-unknown").trusted_cost_usd, null);

  const store = createRoleRunStore(path.join(tempRoot("0genlab-hermes-cost-"), "data", "role-runs"));
  const ingested = ingestHermesSessions({ store, records });
  for (const item of ingested) {
    const finished = JSON.parse(fs.readFileSync(path.join(store.runsRoot, item.run_id, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .at(-1));
    if (item.session.model === "model-estimated") {
      assert.equal(finished.cost_usd, null);
      assert.equal(finished.estimated_cost_usd, 0.25);
    } else if (item.session.model === "model-actual-zero") {
      assert.equal(finished.cost_usd, 0);
      assert.equal(finished.estimated_cost_usd, null);
    }
  }
});

test("Hermes billing identity groups base URL and mode, derives HTTPS providers, and flags conflicts", () => {
  const root = tempRoot("0genlab-hermes-identity-");
  const exported = {
    sessions: [{
      id: "identity-session",
      source: "cli",
      model: "fallback-model",
      started_at: 10,
      ended_at: 11,
      end_reason: "completed",
      billing_provider: "aihubmix",
      billing_base_url: "https://aihubmix.com/v1",
      billing_mode: "default"
    }],
    usage: [
      {
        session_id: "identity-session",
        model: "same-model",
        billing_provider: "openai",
        billing_base_url: "https://aihubmix.com/v1",
        billing_mode: "default",
        api_call_count: 1,
        input_tokens: 1,
        output_tokens: 1,
        actual_cost_usd: 0,
        estimated_cost_usd: 0,
        cost_status: "actual",
        cost_source: "provider"
      },
      {
        session_id: "identity-session",
        model: "same-model",
        billing_provider: "openai",
        billing_base_url: "https://openrouter.ai/api/v1",
        billing_mode: "default",
        api_call_count: 1,
        input_tokens: 2,
        output_tokens: 2,
        actual_cost_usd: 0,
        estimated_cost_usd: 0,
        cost_status: "actual",
        cost_source: "provider"
      },
      {
        session_id: "identity-session",
        model: "same-model",
        billing_provider: "aihubmix",
        billing_base_url: "https://aihubmix.com/v1",
        billing_mode: "alternate",
        api_call_count: 1,
        input_tokens: 3,
        output_tokens: 3,
        actual_cost_usd: 0,
        estimated_cost_usd: 0,
        cost_status: "actual",
        cost_source: "provider"
      },
      {
        session_id: "identity-session",
        model: "same-model",
        billing_provider: "aihubmix",
        billing_base_url: "http://aihubmix.com/v1",
        billing_mode: "default",
        api_call_count: 1,
        input_tokens: 4,
        output_tokens: 4,
        actual_cost_usd: 0,
        estimated_cost_usd: 0,
        cost_status: "actual",
        cost_source: "provider"
      }
    ]
  };

  const records = parseHermesRows(exported);
  assert.equal(records.length, 4);
  const aihubmix = records.find((record) => record.billing_base_url === "https://aihubmix.com"
    && record.billing_path_hash === billingPathHash("/v1")
    && record.billing_mode === "default");
  assert.equal(aihubmix.provider, "aihubmix");
  assert.equal(aihubmix.provider_verified, true);
  assert.equal(aihubmix.provider_conflict, true);
  const openrouter = records.find((record) => record.billing_base_url === "https://openrouter.ai"
    && record.billing_path_hash === billingPathHash("/api/v1"));
  assert.equal(openrouter.provider, "openrouter");
  assert.equal(openrouter.provider_verified, true);
  assert.equal(openrouter.provider_conflict, true);
  const alternate = records.find((record) => record.billing_mode === "alternate");
  assert.equal(alternate.billing_base_url, "https://aihubmix.com");
  const http = records.find((record) => record.billing_base_url === "http://aihubmix.com");
  assert.equal(http.provider, "aihubmix");
  assert.equal(http.provider_verified, false);
  assert.equal(records.some((record) => record.provider === "openai" && record.provider_verified), false);

  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  const ingested = ingestHermesSessions({ store, records });
  assert.equal(ingested.length, 4);
  assert.equal(new Set(ingested.map((item) => item.run_id)).size, 4);
  for (const item of ingested) {
    const event = JSON.parse(fs.readFileSync(path.join(store.runsRoot, item.run_id, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .at(-1));
    assert.equal(event.provider_verified, item.session.provider_verified);
    assert.equal(event.billing_base_url, item.session.billing_base_url);
    assert.equal(event.billing_path_hash, item.session.billing_path_hash);
    assert.equal(event.billing_mode, item.session.billing_mode);
  }
});

test("Hermes billing URLs redact secrets while path hashes preserve identity isolation", () => {
  const root = tempRoot("0genlab-hermes-billing-secrets-");
  const secret = "SECRET_BILLING_KEY";
  const pathSecret = "SECRET_PATH_TOKEN";
  const exported = {
    sessions: [{
      id: "secret-session",
      source: "cli",
      model: "fallback-model",
      started_at: 20,
      ended_at: 21,
      end_reason: "completed",
      billing_provider: "aihubmix",
      billing_base_url: "https://session-user:session-pass@aihubmix.com/v1?session_key=SECRET_BILLING_KEY#session-fragment",
      billing_mode: "default"
    }],
    usage: [
      {
        session_id: "secret-session",
        model: "same-model",
        billing_provider: "aihubmix",
        billing_base_url: `https://row-user:row-pass@aihubmix.com/v1?row_key=${secret}#row-fragment`,
        billing_mode: "default",
        api_call_count: 1,
        input_tokens: 1,
        output_tokens: 1,
        actual_cost_usd: 0,
        estimated_cost_usd: 0,
        cost_status: "actual",
        cost_source: "provider"
      },
      {
        session_id: "secret-session",
        model: "same-model",
        billing_provider: "aihubmix",
        billing_base_url: "https://aihubmix.com/v1?other_key=another-secret",
        billing_mode: "default",
        api_call_count: 1,
        input_tokens: 2,
        output_tokens: 2,
        actual_cost_usd: 0,
        estimated_cost_usd: 0,
        cost_status: "actual",
        cost_source: "provider"
      },
      {
        session_id: "secret-session",
        model: "same-model",
        billing_provider: "aihubmix",
        billing_base_url: `https://aihubmix.com/v1/${pathSecret}?api_key=path-query-secret#path-fragment`,
        billing_mode: "default",
        api_call_count: 1,
        input_tokens: 4,
        output_tokens: 4,
        actual_cost_usd: 0,
        estimated_cost_usd: 0,
        cost_status: "actual",
        cost_source: "provider"
      }
    ]
  };

  const records = parseHermesRows(exported);
  assert.equal(records.length, 2);
  const sharedPath = records.find((record) => record.usage.input_tokens === 3);
  const embeddedSecret = records.find((record) => record.usage.input_tokens === 4);
  assert.equal(sharedPath.billing_base_url, "https://aihubmix.com");
  assert.equal(sharedPath.billing_path_hash, billingPathHash("/v1"));
  assert.equal(sharedPath.provider, "aihubmix");
  assert.equal(embeddedSecret.billing_base_url, "https://aihubmix.com");
  assert.equal(embeddedSecret.billing_path_hash, billingPathHash(`/v1/${pathSecret}`));
  assert.notEqual(embeddedSecret.billing_path_hash, sharedPath.billing_path_hash);

  const store = createRoleRunStore(path.join(root, "data", "role-runs"));
  const ingested = ingestHermesSessions({ store, records });
  assert.equal(ingested.length, 2);
  const persisted = ingested.map((item) => [
    fs.readFileSync(path.join(store.runsRoot, item.run_id, "manifest.json"), "utf8"),
    fs.readFileSync(path.join(store.runsRoot, item.run_id, "events.jsonl"), "utf8")
  ].join("\n")).join("\n");
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes(pathSecret), false);
  assert.equal(persisted.includes("api_key"), false);
  assert.equal(persisted.includes("path-query-secret"), false);
  assert.equal(persisted.includes("path-fragment"), false);
  assert.equal(persisted.includes("session-user"), false);
  assert.equal(persisted.includes("session-pass"), false);
  assert.equal(persisted.includes("session-fragment"), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(store.runsRoot, ingested[0].run_id, "manifest.json"), "utf8"));
  assert.equal(manifest.billing_base_url, "https://aihubmix.com");
  assert.match(manifest.billing_path_hash, /^[a-f0-9]{32}$/);
});

test("Hermes host validation uses the local supported catalog and rejects unknown identities", () => {
  const root = tempRoot("0genlab-hermes-host-");
  const home = path.join(root, ".hermes");
  fs.mkdirSync(path.join(home, "cache"), { recursive: true });
  fs.writeFileSync(path.join(home, "config.yaml"), "model:\n  default: anthropic/claude-opus-4.8\n  provider: nous\n");
  fs.writeFileSync(path.join(home, "cache", "model_catalog.json"), JSON.stringify({
    providers: {
      nous: { models: [{ id: "anthropic/claude-opus-4.8" }] }
    }
  }));
  const catalog = loadHermesCatalog({ homeDir: home, authOutput: "" });
  const adapter = createHermesHostAdapter({ catalog });
  assert.equal(adapter.validateRequest({ provider: "nous", model: "anthropic/claude-opus-4.8" }).provider, "nous");
  assert.throws(() => adapter.validateRequest({ provider: "nous", model: "claude-opus-4.8" }), /unknown Hermes model/);
  assert.throws(() => adapter.validateRequest({ provider: "nous", model: "other/anthropic/claude-opus-4.8" }), /unknown Hermes model/);
  assert.throws(() => adapter.validateRequest({ provider: "nous", model: "ANTHROPIC/claude-opus-4.8" }), /unknown Hermes model/);
  assert.throws(() => adapter.validateRequest({ provider: "nous", model: "anthropic/claude-opus-4.8-preview" }), /unknown Hermes model/);
  assert.throws(() => adapter.validateRequest({ provider: "not-a-provider", model: "claude-opus-4.8" }), /unknown Hermes provider/);
  assert.throws(() => adapter.validateRequest({ provider: "nous", model: "not-a-model" }), /unknown Hermes model/);

  const command = adapter.buildCommand({
    provider: "nous",
    model: "anthropic/claude-opus-4.8",
    cwd: "/workspace/project",
    prompt: "SECRET_HERMES_PROMPT"
  });
  assert.deepEqual(command.args, [
    "chat",
    "--provider", "nous",
    "--model", "anthropic/claude-opus-4.8",
    "--in", "/workspace/project",
    "--query-file", "-",
    "--oneshot"
  ]);
  assert.equal(command.args.includes("SECRET_HERMES_PROMPT"), false);
  assert.equal(command.stdin, "SECRET_HERMES_PROMPT");
});

test("host stage CLI defaults to a redacted dry-run and execution can be tested without invoking a paid model", async () => {
  const root = tempRoot("0genlab-host-stage-");
  const claudeHome = path.join(root, ".claude");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({ model: "claude-opus-5" }));

  const dryRun = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-host-stage.mjs"),
    "--host", "claude",
    "--role", "implementer",
    "--provider", "unknown",
    "--model", "claude-opus-5",
    "--prompt-file", "-",
    "--claude-home", claudeHome
  ], { cwd: repoRoot, encoding: "utf8", input: "SECRET_HOST_PROMPT" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const preview = JSON.parse(dryRun.stdout);
  assert.equal(preview.execute, false);
  assert.equal(preview.audit_only, true);
  assert.equal(dryRun.stdout.includes("SECRET_HOST_PROMPT"), false);
  assert.equal(preview.prompt_bytes, 18);

  const rejected = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-host-stage.mjs"),
    "--host", "claude",
    "--role", "implementer",
    "--provider", "aihubmix",
    "--model", "claude-opus-5",
    "--prompt-file", "-",
    "--claude-home", claudeHome
  ], { cwd: repoRoot, encoding: "utf8", input: "hello" });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /not verifiably configured/);

  const plaintextPrompt = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-host-stage.mjs"),
    "--host", "claude",
    "--role", "implementer",
    "--provider", "unknown",
    "--model", "claude-opus-5",
    "--prompt", "SECRET_HOST_PROMPT",
    "--claude-home", claudeHome
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(plaintextPrompt.status, 2);
  assert.equal(plaintextPrompt.stderr.includes("SECRET_HOST_PROMPT"), false);

  const adapter = {
    name: "claude",
    validateRequest: () => ({
      provider: "unknown",
      model: "claude-opus-5",
      provider_verified: false,
      audit_only: true,
      provider_evidence: "test"
    }),
    buildCommand: () => ({ command: "fake-host", args: ["--print"], stdin: "SECRET_HOST_PROMPT" })
  };
  const prepared = prepareHostStage({
    host: "claude",
    role: "implementer",
    provider: "unknown",
    model: "claude-opus-5",
    prompt: "SECRET_HOST_PROMPT",
    claudeAdapter: adapter
  });
  let spawned = null;
  let stdin = null;
  const result = await executeHostStage({
    prepared,
    root,
    cwd: root,
    uuid: () => "00000000-0000-4000-8000-000000000000",
    spawnImpl(command, args, options) {
      spawned = { command, args, options };
      const child = new EventEmitter();
      child.stdin = { end(value) { stdin = value; } };
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }
  });
  assert.equal(spawned.command, "fake-host");
  assert.equal(spawned.args.includes("SECRET_HOST_PROMPT"), false);
  assert.equal(stdin, "SECRET_HOST_PROMPT");
  assert.match(result.run_id, /-00000000-0000-4000-8000-000000000000$/);
  assert.equal(result.status, "success");
  const events = fs.readFileSync(path.join(root, "data", "role-runs", result.run_id, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).role, "implementer");
  assert.equal(events.at(-1).provider, "unknown");
  assert.equal(events.at(-1).model, "claude-opus-5");
  assert.equal(events.at(-1).note, "host_completed");
  assert.equal(JSON.stringify(events).includes("SECRET_HOST_PROMPT"), false);
});

test("Hermes host stage uses the safe stdin command without injecting usage-file", async () => {
  const root = tempRoot("0genlab-hermes-stage-");
  const adapter = {
    name: "hermes",
    validateRequest: () => ({
      provider: "nous",
      model: "anthropic/claude-opus-4.8",
      provider_verified: true,
      audit_only: false,
      provider_evidence: "test"
    }),
    buildCommand: ({ cwd, prompt }) => ({
      command: "fake-hermes",
      args: [
        "chat",
        "--provider", "nous",
        "--model", "anthropic/claude-opus-4.8",
        "--in", cwd,
        "--query-file", "-",
        "--oneshot"
      ],
      stdin: prompt
    })
  };
  const prepared = prepareHostStage({
    host: "hermes",
    role: "implementer",
    provider: "nous",
    model: "anthropic/claude-opus-4.8",
    prompt: "SECRET_HERMES_PROMPT",
    cwd: root,
    hermesAdapter: adapter
  });
  let spawned = null;
  let stdin = null;
  const result = await executeHostStage({
    prepared,
    root,
    cwd: root,
    uuid: () => "11111111-1111-4111-8111-111111111111",
    spawnImpl(command, args, options) {
      spawned = { command, args, options };
      const child = new EventEmitter();
      child.stdin = { end(value) { stdin = value; } };
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }
  });

  assert.equal(spawned.command, "fake-hermes");
  assert.deepEqual(spawned.args, adapter.buildCommand({ cwd: root, prompt: "SECRET_HERMES_PROMPT" }).args);
  assert.equal(spawned.args.includes("--usage-file"), false);
  assert.equal(spawned.args.includes("SECRET_HERMES_PROMPT"), false);
  assert.equal(stdin, "SECRET_HERMES_PROMPT");
  assert.equal(result.status, "success");
  const event = JSON.parse(fs.readFileSync(path.join(root, "data", "role-runs", result.run_id, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .at(-1));
  assert.equal(event.input_tokens, null);
  assert.equal(event.output_tokens, null);
  assert.equal(event.total_tokens, null);
});

test("host stage records usage_invalid and preserves caller-owned usage files", async () => {
  const cases = [
    ["bad-json", "{not-json"],
    ["array", "[]"],
    ["string", "\"not-an-object\""],
    ["non-finite", JSON.stringify({ input_tokens: "NaN", output_tokens: 1 })],
    ["no-tokens", JSON.stringify({ api_calls: 1 })]
  ];
  const adapter = {
    name: "hermes",
    validateRequest: () => ({
      provider: "nous",
      model: "anthropic/claude-opus-4.8",
      provider_verified: true,
      audit_only: false,
      provider_evidence: "test"
    }),
    buildCommand: ({ cwd, prompt }) => ({
      command: "fake-hermes",
      args: ["chat", "--provider", "nous", "--model", "anthropic/claude-opus-4.8", "--in", cwd, "--query-file", "-", "--oneshot"],
      stdin: prompt
    })
  };

  for (const [index, [name, contents]] of cases.entries()) {
    const root = tempRoot(`0genlab-usage-${name}-`);
    const usageFile = path.join(root, "usage.json");
    fs.writeFileSync(usageFile, contents);
    const prepared = prepareHostStage({
      host: "hermes",
      role: "implementer",
      provider: "nous",
      model: "anthropic/claude-opus-4.8",
      prompt: "hello",
      cwd: root,
      hermesAdapter: adapter
    });
    const result = await executeHostStage({
      prepared,
      root,
      cwd: root,
      usageFile,
      uuid: () => `22222222-2222-4222-8222-22222222222${index}`,
      spawnImpl() {
        const child = new EventEmitter();
        child.stdin = { end() {} };
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      }
    });
    assert.equal(result.status, "failed");
    const events = fs.readFileSync(path.join(root, "data", "role-runs", result.run_id, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events.at(-1).status, "failed");
    assert.equal(events.at(-1).failure_mode, "usage_invalid");
    assert.equal(events.at(-1).note, "usage_invalid");
    assert.equal(fs.existsSync(usageFile), true);
  }

  const root = tempRoot("0genlab-usage-missing-");
  const prepared = prepareHostStage({
    host: "hermes",
    role: "implementer",
    provider: "nous",
    model: "anthropic/claude-opus-4.8",
    prompt: "hello",
    cwd: root,
    hermesAdapter: adapter
  });
  const result = await executeHostStage({
    prepared,
    root,
    cwd: root,
    uuid: () => "33333333-3333-4333-8333-333333333333",
    spawnImpl() {
      const child = new EventEmitter();
      child.stdin = { end() {} };
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }
  });
  assert.equal(result.status, "success");
  const event = JSON.parse(fs.readFileSync(path.join(root, "data", "role-runs", result.run_id, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .at(-1));
  assert.equal(event.failure_mode, null);
  assert.equal(event.input_tokens, null);
});

test("host stage removes a prepared temporary usage file after reading it", async () => {
  const root = tempRoot("0genlab-usage-prepared-");
  const usageFile = path.join(root, "prepared-usage.json");
  fs.writeFileSync(usageFile, JSON.stringify({ input_tokens: 1, output_tokens: 1 }));
  const prepared = prepareHostStage({
    host: "hermes",
    role: "implementer",
    provider: "nous",
    model: "anthropic/claude-opus-4.8",
    prompt: "hello",
    cwd: root,
    hermesAdapter: {
      name: "hermes",
      validateRequest: () => ({
        provider: "nous",
        model: "anthropic/claude-opus-4.8",
        provider_verified: true,
        audit_only: false,
        provider_evidence: "test"
      }),
      buildCommand: ({ cwd, prompt }) => ({
        command: "fake-hermes",
        args: ["chat", "--in", cwd],
        stdin: prompt
      })
    }
  });
  prepared.usage_file = usageFile;

  const result = await executeHostStage({
    prepared,
    root,
    cwd: root,
    uuid: () => "44444444-4444-4444-8444-444444444444",
    spawnImpl() {
      const child = new EventEmitter();
      child.stdin = { end() {} };
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }
  });
  assert.equal(result.status, "success");
  assert.equal(fs.existsSync(usageFile), false);
});
