import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const hostStageScript = path.join(repoRoot, "scripts", "run-host-stage.mjs");

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFakeHost(root) {
  const file = path.join(root, "fake-host.cjs");
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "auth" && process.argv[3] === "list") process.exit(0);
if (process.env.CAPTURE_FILE) {
  fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({
    claude_config_dir: process.env.CLAUDE_CONFIG_DIR ?? null,
    hermes_home: process.env.HERMES_HOME ?? null,
    has_claude_config_dir: Object.hasOwn(process.env, "CLAUDE_CONFIG_DIR"),
    has_hermes_home: Object.hasOwn(process.env, "HERMES_HOME"),
    cwd: process.cwd(),
    args: process.argv.slice(2)
  }));
}
process.exit(0);
`);
  fs.chmodSync(file, 0o755);
  return file;
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.CAPTURE_FILE;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.HERMES_HOME;
  return { ...env, ...overrides };
}

function runHostStage({ args, cwd, root, env = {} }) {
  const captureFile = path.join(root, `capture-${Math.random().toString(16).slice(2)}.json`);
  const result = spawnSync(process.execPath, [hostStageScript, ...args], {
    cwd,
    encoding: "utf8",
    input: "secret prompt",
    env: cleanEnv({
      ROLEBENCH_ROOT: root,
      CAPTURE_FILE: captureFile,
      ...env
    })
  });
  const captured = fs.existsSync(captureFile)
    ? JSON.parse(fs.readFileSync(captureFile, "utf8"))
    : null;
  return { result, captured };
}

function writeClaudeSettings(home, model = "claude-opus-5") {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ model }));
}

function writeHermesCatalog(home) {
  const cache = path.join(home, "cache");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "model_catalog.json"), JSON.stringify({
    providers: {
      nous: { models: [{ id: "anthropic/claude-opus-4.8" }] }
    }
  }));
}

test("explicit --claude-home is used by validation and the child process", () => {
  const root = tempRoot("0genlab-claude-home-");
  const invocationCwd = path.join(root, "invocation");
  const childCwd = path.join(root, "child");
  const claudeHome = path.join(invocationCwd, "claude-config");
  const ambientClaudeHome = path.join(root, "ambient-claude");
  fs.mkdirSync(childCwd, { recursive: true });
  writeClaudeSettings(claudeHome);
  const fakeHost = writeFakeHost(root);

  const { result, captured } = runHostStage({
    cwd: invocationCwd,
    root,
    env: {
      CLAUDE_BIN: fakeHost,
      CLAUDE_CONFIG_DIR: ambientClaudeHome
    },
    args: [
      "--host", "claude",
      "--role", "implementer",
      "--provider", "unknown",
      "--model", "claude-opus-5",
      "--prompt-file", "-",
      "--execute",
      "--root", root,
      "--cwd", childCwd,
      "--claude-home", "claude-config"
    ]
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(captured.has_claude_config_dir, true);
  assert.equal(captured.claude_config_dir, fs.realpathSync(claudeHome));
  assert.equal(captured.has_hermes_home, false);
});

test("explicit --hermes-home is used by validation and the child process", () => {
  const root = tempRoot("0genlab-hermes-home-");
  const invocationCwd = path.join(root, "invocation");
  const childCwd = path.join(root, "child");
  const hermesHome = path.join(invocationCwd, "hermes-config");
  const ambientHermesHome = path.join(root, "ambient-hermes");
  fs.mkdirSync(childCwd, { recursive: true });
  writeHermesCatalog(hermesHome);
  const fakeHost = writeFakeHost(root);

  const { result, captured } = runHostStage({
    cwd: invocationCwd,
    root,
    env: {
      HERMES_BIN: fakeHost,
      HERMES_HOME: ambientHermesHome
    },
    args: [
      "--host", "hermes",
      "--role", "implementer",
      "--provider", "nous",
      "--model", "anthropic/claude-opus-4.8",
      "--prompt-file", "-",
      "--execute",
      "--root", root,
      "--cwd", childCwd,
      "--hermes-home", "hermes-config"
    ]
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(captured.has_hermes_home, true);
  assert.equal(captured.hermes_home, fs.realpathSync(hermesHome));
  assert.equal(captured.has_claude_config_dir, false);
});

test("relative --cwd is resolved once for both the child cwd and Hermes --in", () => {
  const root = tempRoot("0genlab-hermes-relative-cwd-");
  const invocationCwd = path.join(root, "invocation");
  const childCwd = path.join(invocationCwd, "child");
  const hermesHome = path.join(root, "hermes-config");
  fs.mkdirSync(childCwd, { recursive: true });
  writeHermesCatalog(hermesHome);
  const fakeHost = writeFakeHost(root);

  const { result, captured } = runHostStage({
    cwd: invocationCwd,
    root,
    env: {
      HERMES_BIN: fakeHost,
      HERMES_HOME: hermesHome
    },
    args: [
      "--host", "hermes",
      "--role", "implementer",
      "--provider", "nous",
      "--model", "anthropic/claude-opus-4.8",
      "--prompt-file", "-",
      "--execute",
      "--root", root,
      "--cwd", "child"
    ]
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(captured.cwd, fs.realpathSync(childCwd));
  const inIndex = captured.args.indexOf("--in");
  assert.notEqual(inIndex, -1);
  assert.equal(captured.args[inIndex + 1], fs.realpathSync(childCwd));
  assert.equal(captured.args[inIndex + 1].endsWith("/child/child"), false);
});

test("omitting home flags preserves inherited config directories", () => {
  const root = tempRoot("0genlab-default-home-");
  const invocationCwd = path.join(root, "invocation");
  const ambientClaudeHome = path.join(root, "ambient-claude");
  const ambientHermesHome = path.join(root, "ambient-hermes");
  fs.mkdirSync(invocationCwd, { recursive: true });
  writeHermesCatalog(ambientHermesHome);
  const fakeHost = writeFakeHost(root);

  const claude = runHostStage({
    cwd: invocationCwd,
    root,
    env: {
      CLAUDE_BIN: fakeHost,
      CLAUDE_CONFIG_DIR: ambientClaudeHome
    },
    args: [
      "--host", "claude",
      "--role", "implementer",
      "--provider", "unknown",
      "--model", "opus",
      "--prompt-file", "-",
      "--execute",
      "--root", root
    ]
  });
  assert.equal(claude.result.status, 0, claude.result.stderr);
  assert.equal(claude.captured.has_claude_config_dir, true);
  assert.equal(claude.captured.claude_config_dir, ambientClaudeHome);
  assert.equal(claude.captured.has_hermes_home, false);

  const hermes = runHostStage({
    cwd: invocationCwd,
    root,
    env: {
      HERMES_BIN: fakeHost,
      HERMES_HOME: ambientHermesHome
    },
    args: [
      "--host", "hermes",
      "--role", "implementer",
      "--provider", "nous",
      "--model", "anthropic/claude-opus-4.8",
      "--prompt-file", "-",
      "--execute",
      "--root", root
    ]
  });
  assert.equal(hermes.result.status, 0, hermes.result.stderr);
  assert.equal(hermes.captured.has_hermes_home, true);
  assert.equal(hermes.captured.hermes_home, ambientHermesHome);
  assert.equal(hermes.captured.has_claude_config_dir, false);
});
