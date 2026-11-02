import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, renameSync, chmodSync } from "fs";

export const CLAUDE_CREDENTIALS_PATH = process.env.CLAUDE_CREDENTIALS_PATH ||
  join(homedir(), ".claude", ".credentials.json");

const SIDECAR_PATH = process.env.CLAUDE_OAUTH_SIDECAR_PATH ||
  join(homedir(), ".claude", ".oauth-refresh.json");

const TOKEN_URL = process.env.CLAUDE_TOKEN_URL || "https://platform.claude.com/v1/oauth/token";
const CLIENT_IDS = [
  "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "https://claude.ai/oauth/claude-code-client-metadata",
];
const DEFAULT_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const REFRESH_BUFFER_MS = 30 * 60 * 1000;
const MIN_ATTEMPT_INTERVAL_MS = 15 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

function credentialScopes(oauth) {
  const raw = oauth?.scopes;
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw)
      : [];
  const scopes = list.filter((s) => typeof s === "string" && s.trim());
  return scopes.length ? scopes : DEFAULT_SCOPES;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data));
  try {
    chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, file);
}

function readSidecar() {
  return readJson(SIDECAR_PATH) || {};
}

function writeSidecar(patch) {
  writeJsonAtomic(SIDECAR_PATH, { ...readSidecar(), ...patch });
}

async function tryRefresh(refreshToken, clientId, scope) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      scope,
    }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data };
}

// The token endpoint explains refusals in the body (`invalid_grant`,
// "Refresh token expired", ...). Keep that text: without it a dead login and a
// network blip look identical in the collector log (2026-11-02 incident).
function oauthError(result) {
  const body = result?.data || {};
  const code = typeof body.error === "string" ? body.error : "";
  const description = typeof body.error_description === "string" ? body.error_description : "";
  const detail = [code, description].filter(Boolean).join(" — ");
  return detail ? `${result.status} ${detail}` : `HTTP ${result?.status ?? "error"}`;
}

async function requestTokens(refreshToken, scope) {
  let last = null;
  for (const clientId of CLIENT_IDS) {
    try {
      last = await tryRefresh(refreshToken, clientId, scope);
    } catch (e) {
      return { status: "failed", error: String(e.message || e) };
    }
    if (last.status === 200 && last.data) return { status: "ok", result: last };
    if (last.status === 429) return { status: "rate-limited", result: last };
    if (last.status === 400 || last.status === 401) continue;
    break;
  }
  return { status: "failed", result: last };
}

function applyTokens(cred, tokens) {
  const oauth = cred.claudeAiOauth || {};
  const now = Date.now();
  if (typeof tokens.access_token === "string" && tokens.access_token) {
    oauth.accessToken = tokens.access_token;
  }
  if (typeof tokens.refresh_token === "string" && tokens.refresh_token) {
    oauth.refreshToken = tokens.refresh_token;
  }
  if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) {
    oauth.expiresAt = now + tokens.expires_in * 1000;
  }
  if (typeof tokens.refresh_token_expires_in === "number" && tokens.refresh_token_expires_in > 0) {
    oauth.refreshTokenExpiresAt = now + tokens.refresh_token_expires_in * 1000;
  }
  cred.claudeAiOauth = oauth;
}

// Write the rotated pair onto the freshest on-disk document, but never clobber
// a rotation another Claude process (CLI, bridge daemon) completed while our
// request was in flight — that would invalidate their live token.
function applyFreshTokens(usedToken, tokens) {
  const fresh = readJson(CLAUDE_CREDENTIALS_PATH);
  const current = fresh?.claudeAiOauth?.refreshToken;
  if (current && usedToken && current !== usedToken) return false;
  const target = fresh && fresh.claudeAiOauth ? fresh : { claudeAiOauth: {} };
  applyTokens(target, tokens);
  writeJsonAtomic(CLAUDE_CREDENTIALS_PATH, target);
  return true;
}

export async function refreshClaudeTokenIfNeeded({ force = false } = {}) {
  const cred = readJson(CLAUDE_CREDENTIALS_PATH);
  if (!cred || !cred.claudeAiOauth) {
    return { ok: false, reason: "no-credentials", detail: "no claudeAiOauth entry found" };
  }
  const oauth = cred.claudeAiOauth;
  const now = Date.now();

  if (typeof oauth.expiresAt === "number") {
    const remaining = oauth.expiresAt - now;
    if (!force && remaining > REFRESH_BUFFER_MS) {
      return { ok: true, reason: "fresh", detail: `token valid for ~${Math.round(remaining / 60000)}m` };
    }
    if (remaining <= 0) {
      writeSidecar({ lastExpiredAt: now });
    }
  }

  if (!oauth.refreshToken) {
    return { ok: false, reason: "no-refresh-token", detail: "login was cleared on disk; run claude auth login on the host" };
  }

  const sidecar = readSidecar();
  if (!force) {
    if (sidecar.rateLimitedUntil && sidecar.rateLimitedUntil > now) {
      const mins = Math.ceil((sidecar.rateLimitedUntil - now) / 60000);
      return { ok: false, reason: "rate-limited", detail: `token endpoint cooling down ~${mins}m` };
    }
    if (sidecar.lastAttemptAt && now - sidecar.lastAttemptAt < MIN_ATTEMPT_INTERVAL_MS) {
      const mins = Math.ceil((MIN_ATTEMPT_INTERVAL_MS - (now - sidecar.lastAttemptAt)) / 60000);
      return { ok: false, reason: "too-soon", detail: `refresh attempted ~${mins}m ago` };
    }
  }

  writeSidecar({ lastAttemptAt: now });

  const scope = credentialScopes(oauth).join(" ");
  let usedToken = oauth.refreshToken;
  let attempt = await requestTokens(usedToken, scope);

  // Refresh tokens rotate: when the interactive CLI or the bridge daemon
  // refreshes first, our copy is rejected as invalid_grant. Re-read the disk
  // and retry once with the token that won the race.
  if (attempt.status === "failed") {
    const latest = readJson(CLAUDE_CREDENTIALS_PATH)?.claudeAiOauth;
    if (latest?.refreshToken && latest.refreshToken !== usedToken) {
      usedToken = latest.refreshToken;
      attempt = await requestTokens(usedToken, credentialScopes(latest).join(" "));
    }
  }

  if (attempt.status === "ok") {
    const written = applyFreshTokens(usedToken, attempt.result.data);
    writeSidecar({ lastSuccessAt: Date.now(), rateLimitedUntil: 0, lastFailure: null });
    const expiresAt = readJson(CLAUDE_CREDENTIALS_PATH)?.claudeAiOauth?.expiresAt;
    const detail = written
      ? `new token valid ${Math.round(((expiresAt || Date.now()) - Date.now()) / 60000)}m`
      : "another process had already rotated the token";
    return { ok: true, reason: written ? "refreshed" : "rotated-elsewhere", detail };
  }

  if (attempt.status === "rate-limited") {
    writeSidecar({ rateLimitedUntil: now + RATE_LIMIT_COOLDOWN_MS });
    return { ok: false, reason: "rate-limited", detail: "token endpoint returned HTTP 429" };
  }

  const detail = attempt.error || oauthError(attempt.result);
  writeSidecar({ lastFailureAt: now, lastFailure: detail.slice(0, 200) });
  return { ok: false, reason: "refresh-failed", detail };
}

export async function refreshClaudeTokenForced() {
  return refreshClaudeTokenIfNeeded({ force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes("--force");
  const res = await refreshClaudeTokenIfNeeded({ force });
  console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
