import fs from "node:fs";
import path from "node:path";
import { detectClaudeProvider, providerFromBaseUrl } from "./session-ingest.mjs";

// Claude Code does not persist ANTHROPIC_BASE_URL in session JSONL. A hook
// spawned by the live Claude process inherits its environment, so it can
// record the route the session actually used. Only the URL origin is kept.

function safeSessionId(sessionId) {
  const value = String(sessionId || "").trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function urlOrigin(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

export function sessionRoutePath(routesDir, sessionId) {
  const id = safeSessionId(sessionId);
  return id ? path.join(routesDir, `${id}.json`) : null;
}

export function recordClaudeSessionRoute({ routesDir, sessionId, settings = {}, env = process.env, now = new Date() } = {}) {
  const file = sessionRoutePath(routesDir, sessionId);
  if (!file) throw new Error("valid Claude session id is required");
  if (fs.existsSync(file)) return { file, created: false, route: JSON.parse(fs.readFileSync(file, "utf8")) };

  const detected = detectClaudeProvider({ settings, env });
  const route = {
    schema_version: 1,
    session_id: safeSessionId(sessionId),
    provider: detected.provider,
    provider_verified: detected.verified,
    base_url_origin: detected.base_url ? urlOrigin(detected.base_url) : null,
    recorded_at: now.toISOString()
  };
  fs.mkdirSync(routesDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(route, null, 2)}\n`, { flag: "wx" });
  return { file, created: true, route };
}

export function readClaudeSessionRoute(routesDir, sessionId) {
  const file = routesDir ? sessionRoutePath(routesDir, sessionId) : null;
  if (!file || !fs.existsSync(file)) return null;
  try {
    const route = JSON.parse(fs.readFileSync(file, "utf8"));
    // Re-derive the provider from the recorded origin instead of trusting the stored label.
    const provider = providerFromBaseUrl(route.base_url_origin);
    return provider
      ? { provider, verified: true, evidence: "session-route-hook", base_url: route.base_url_origin }
      : null;
  } catch {
    return null;
  }
}
