import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, renameSync, chmodSync } from "fs";

// Mirrors claude-token.mjs for the ChatGPT (openai) OAuth entry in opencode's
// auth.json. opencode only refreshes lazily while being used interactively;
// the collector probes via the external opencode-quota CLI, so on a headless
// box nobody refreshes and the card dies when the access token expires.
// Refresh grant parameters verified against opencode source
// (packages/opencode/src/plugin/codex.ts): public PKCE client, form-urlencoded,
// refresh tokens rotate on every grant.

export const OPENAI_AUTH_PATH = process.env.AIUD_AUTH_FILE ||
  join(homedir(), ".local", "share", "opencode", "auth.json");

const SIDECAR_PATH = process.env.OPENAI_OAUTH_SIDECAR_PATH ||
  join(homedir(), ".local", "share", "opencode", ".openai-oauth-refresh.json");

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_BUFFER_MS = 30 * 60 * 1000;
const MIN_ATTEMPT_INTERVAL_MS = 15 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

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

// The account id lives in JWT claims (chatgpt_account_id); opencode extracts it
// on login/refresh and keeps it in auth.json. Preserve whatever we already have
// unless the fresh tokens carry a claim.
function extractAccountId(token) {
  if (typeof token !== "string" || !token.includes(".")) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    return payload.chatgpt_account_id || payload["https://api.openai.com/auth"].chatgpt_account_id || undefined;
  } catch {
    return undefined;
  }
}

async function tryRefresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data };
}

export async function refreshOpenAITokenIfNeeded({ force = false } = {}) {
  const cred = readJson(OPENAI_AUTH_PATH);
  if (!cred || !cred.openai || cred.openai.type !== "oauth") {
    return { ok: false, reason: "no-credentials", detail: "no openai oauth entry found" };
  }
  const entry = cred.openai;
  const now = Date.now();

  if (typeof entry.expires === "number") {
    const remaining = entry.expires - now;
    if (!force && remaining > REFRESH_BUFFER_MS) {
      return { ok: true, reason: "fresh", detail: `token valid for ~${Math.round(remaining / 60000)}m` };
    }
    if (remaining <= 0) {
      writeSidecar({ lastExpiredAt: now });
    }
  }

  if (!entry.refresh) {
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

  const last = await tryRefresh(entry.refresh);
  if (last.status === 200 && last.data && last.data.access_token) {
    entry.access = last.data.access_token;
    // Refresh tokens rotate; storing the new one is mandatory, old one may be void.
    if (typeof last.data.refresh_token === "string" && last.data.refresh_token) {
      entry.refresh = last.data.refresh_token;
    }
    const expiresIn = typeof last.data.expires_in === "number" && last.data.expires_in > 0
      ? last.data.expires_in * 1000
      : 3600 * 1000;
    entry.expires = now + expiresIn;
    entry.accountId = extractAccountId(last.data.id_token) ||
      extractAccountId(last.data.access_token) ||
      entry.accountId;
    writeJsonAtomic(OPENAI_AUTH_PATH, cred);
    writeSidecar({ lastSuccessAt: now, rateLimitedUntil: 0 });
    return { ok: true, reason: "refreshed", detail: `new token valid ${Math.round(expiresIn / 60000)}m` };
  }
  if (last.status === 429) {
    writeSidecar({ rateLimitedUntil: now + RATE_LIMIT_COOLDOWN_MS });
    return { ok: false, reason: "rate-limited", detail: "token endpoint returned HTTP 429" };
  }
  if (last.status === 400 && /invalid_grant/i.test(last.data?.error || "")) {
    writeSidecar({ lastInvalidGrantAt: now });
    return { ok: false, reason: "invalid-grant", detail: "refresh token rejected — manual re-login required (opencode auth login -p openai)" };
  }
  return {
    ok: false,
    reason: "refresh-failed",
    detail: last ? `token endpoint HTTP ${last.status}` : "endpoint unreachable",
  };
}

export async function refreshOpenAITokenForced() {
  return refreshOpenAITokenIfNeeded({ force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes("--force");
  const res = await refreshOpenAITokenIfNeeded({ force });
  console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
