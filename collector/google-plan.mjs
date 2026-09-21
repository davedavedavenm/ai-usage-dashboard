// Google (Antigravity) plan probe.
//
// The quota CLI's per-model windows come from Google's quota buckets, and those
// buckets are a constant "full" for accounts Google does not meter — which reads
// on the dashboard as four 100% rows that never move. This probe asks the one
// endpoint that states the account's plan outright (`v1internal:loadCodeAssist`)
// so the card can name the reason instead of showing placeholders.
//
// Credentials come from the files the antigravity plugin already owns: the
// account store (refresh token + project) and the plugin's companion package
// (Google's public OAuth client id/secret, which is baked into that npm
// package — the quota CLI reads the same file). Nothing is copied, written, or
// logged: no token, email, or client secret ever leaves this module.

import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const USER_AGENT = "antigravity/1.11.9 linux/x64";
const PROBE_TIMEOUT_MS = 15000;

function accountsPathCandidates() {
  return [
    process.env.AIUD_ANTIGRAVITY_ACCOUNTS,
    join(homedir(), ".config", "opencode", "antigravity-accounts.json"),
    join(homedir(), ".local", "share", "opencode", "antigravity-accounts.json"),
  ].filter(Boolean);
}

function constantsPathCandidates() {
  const out = [process.env.AIUD_ANTIGRAVITY_CONSTANTS].filter(Boolean);
  const packagesDir = join(homedir(), ".cache", "opencode", "packages");
  try {
    for (const dir of readdirSync(packagesDir)) {
      if (!dir.startsWith("opencode-antigravity-auth@")) continue;
      out.push(join(packagesDir, dir, "node_modules", "opencode-antigravity-auth", "dist", "src", "constants.js"));
    }
  } catch {
    // No plugin cache: the caller falls back to the generic placeholder message.
  }
  return out;
}

function readAccount() {
  for (const path of accountsPathCandidates()) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : (Array.isArray(parsed) ? parsed : []);
    const usable = accounts.find(a => a && a.refreshToken && (a.projectId || a.managedProjectId || a.quotaProjectId));
    if (usable) return { refreshToken: usable.refreshToken, projectId: usable.managedProjectId || usable.quotaProjectId || usable.projectId };
  }
  return null;
}

// Google's Antigravity OAuth client is public and ships inside the plugin's
// companion package; only the two values are read, and only ever passed on.
function readClientCredentials() {
  for (const path of constantsPathCandidates()) {
    let source;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const id = /ANTIGRAVITY_CLIENT_ID\s*[:=]\s*["'`]([^"'`]+)["'`]/.exec(source);
    const secret = /ANTIGRAVITY_CLIENT_SECRET\s*[:=]\s*["'`]([^"'`]+)["'`]/.exec(source);
    if (id && secret) return { clientId: id[1], clientSecret: secret[1] };
  }
  return null;
}

async function post(url, { headers, body, timeoutMs = PROBE_TIMEOUT_MS }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Returns { ok, tier, paidTier, upgradeOffered, project } on success and
// { ok: false, error } on any failure — a failed plan probe must never be able
// to take the collector down or change what it publishes.
export async function probeGooglePlan() {
  try {
    const account = readAccount();
    if (!account) return { ok: false, error: "no Antigravity account store on this host" };
    const credentials = readClientCredentials();
    if (!credentials) return { ok: false, error: "Antigravity plugin companion not found" };

    const tokenResponse = await post(TOKEN_URL, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: account.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenResponse.ok) return { ok: false, error: "Antigravity token refresh HTTP " + tokenResponse.status };
    const token = await tokenResponse.json().catch(() => null);
    if (!token?.access_token) return { ok: false, error: "Antigravity token refresh returned no access token" };

    const planResponse = await post(LOAD_CODE_ASSIST_URL, {
      headers: { Authorization: "Bearer " + token.access_token, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ cloudaicompanionProject: account.projectId }),
    });
    if (!planResponse.ok) return { ok: false, error: "loadCodeAssist HTTP " + planResponse.status };
    const plan = await planResponse.json().catch(() => null);
    const tier = plan?.currentTier?.id || null;
    if (!tier) return { ok: false, error: "loadCodeAssist returned no tier" };
    // Google's upsell text embeds the account email in a URL, so only its
    // presence is read; the wording is never published.
    const upgradeOffered = Boolean(plan?.currentTier?.upgradeSubscriptionUri || plan?.currentTier?.upgradeSubscriptionText);
    const paid = plan?.paidTier;
    return {
      ok: true,
      tier,
      paidTier: typeof paid === "string" ? paid : (paid?.id || null),
      upgradeOffered,
      project: account.projectId,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 160) };
  }
}

// Card text for the placeholder state: what Google actually said, and the only
// action that makes real numbers appear.
export function antigravityPlaceholderMessage(plan) {
  const parts = [];
  if (plan?.ok && plan.paidTier && plan.paidTier !== plan.tier) {
    parts.push(`Antigravity is running on the "${plan.tier}" project while this account's paid tier is "${plan.paidTier}" — Google meters only the project enrolled in the plan`);
  } else if (plan?.ok) {
    parts.push(`Google meters no allowance for this Antigravity account — plan "${plan.tier}"${plan.upgradeOffered ? " (Google is offering it a paid-plan upgrade)" : ""}`);
  } else {
    parts.push("Google reports a constant full allowance for this Antigravity account (unmetered placeholder)");
  }
  parts.push("every model pinned to 100% with one rolling 5 h reset, so no real window can be shown");
  parts.push(plan?.ok && plan.paidTier && plan.paidTier !== plan.tier
    ? "fix: on khpi5, run opencode auth login → Google (Antigravity) and pick the project that carries the Google AI plan"
    : "fix: on khpi5, run opencode auth login → Google (Antigravity) as the account holding the Google AI plan");
  return parts.join(" · ");
}
