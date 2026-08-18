import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, renameSync, chmodSync } from "fs";

export const CLAUDE_CREDENTIALS_PATH = process.env.CLAUDE_CREDENTIALS_PATH ||
  join(homedir(), ".claude", ".credentials.json");

const SIDECAR_PATH = process.env.CLAUDE_OAUTH_SIDECAR_PATH ||
  join(homedir(), ".claude", ".oauth-refresh.json");

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
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
    return { ok: false, reason: "no-refresh-token" };
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
  let last = null;
  for (const clientId of CLIENT_IDS) {
    last = await tryRefresh(oauth.refreshToken, clientId, scope);
    if (last.status === 200 && last.data) {
      applyTokens(cred, last.data);
      writeJsonAtomic(CLAUDE_CREDENTIALS_PATH, cred);
      writeSidecar({ lastSuccessAt: now, rateLimitedUntil: 0 });
      return { ok: true, reason: "refreshed", detail: `new token valid ${Math.round((cred.claudeAiOauth.expiresAt - Date.now()) / 60000)}m` };
    }
    if (last.status === 429) {
      writeSidecar({ rateLimitedUntil: now + RATE_LIMIT_COOLDOWN_MS });
      return { ok: false, reason: "rate-limited", detail: "token endpoint returned HTTP 429" };
    }
    if (last.status === 400 || last.status === 401) {
      continue;
    }
    break;
  }
  return {
    ok: false,
    reason: "refresh-failed",
    detail: last ? `token endpoint HTTP ${last.status}` : "no endpoint tried",
  };
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