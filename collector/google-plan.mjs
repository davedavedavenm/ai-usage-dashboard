// Google (Antigravity) plan probe.
//
// The quota CLI's per-model windows come from Google's quota buckets, and those
// buckets are a constant "full" for accounts Google does not meter — which reads
// on the dashboard as four 100% rows that never move. This probe reads the
// account's plan from `v1internal:loadCodeAssist` and, separately, the live
// G4Argon bucket from `v1internal:retrieveUserQuotaSummary` (the older
// per-model endpoints omit Argon entirely), so the card can show a real
// percentage instead of a placeholder.
//
// Credentials come from the files the antigravity plugin already owns: the
// account store (refresh token + project) and the plugin's companion package
// (Google's public OAuth client id/secret, which is baked into that npm
// package — the quota CLI reads the same file). Nothing is copied, written, or
// logged: no token, email, or client secret ever leaves this module.

import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { antigravityQuotaSummaryArgon } from "./quota-parsers.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
// The summary endpoint is the only one that publishes the Gemini 4 Argon
// bucket. It also requires the newer AGY client UA; the old UA returns only
// the Claude/GPT family (verified 2026-10-30).
const QUOTA_SUMMARY_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const QUOTA_SUMMARY_UA = "antigravity/cli/1.4.7 darwin/amd64";
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

// Returns { ok, tier, paidTier, upgradeOffered, project, argon } on success,
// and { ok: false, error, argon } on failure. `argon` is the live G4Argon
// percent entry from the quota-summary endpoint when Google publishes one.
// A failed plan probe must never take the collector down or change what it
// publishes.
export async function probeGooglePlan() {
  let argon = null;
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

    try {
      const summaryResponse = await post(QUOTA_SUMMARY_URL, {
        headers: {
          Authorization: "Bearer " + token.access_token,
          "Content-Type": "application/json",
          "User-Agent": QUOTA_SUMMARY_UA,
          "x-activity-request-id": randomUUID(),
        },
        body: JSON.stringify({ project: account.projectId }),
      });
      if (summaryResponse.ok) {
        const summary = await summaryResponse.json().catch(() => null);
        argon = antigravityQuotaSummaryArgon(summary);
      }
    } catch {
      // The plan probe still works without the summary; the card falls back to
      // a "not reported" Argon row instead.
    }

    const planResponse = await post(LOAD_CODE_ASSIST_URL, {
      headers: { Authorization: "Bearer " + token.access_token, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ cloudaicompanionProject: account.projectId }),
    });
    if (!planResponse.ok) return { ok: false, error: "loadCodeAssist HTTP " + planResponse.status, argon };
    const plan = await planResponse.json().catch(() => null);
    const tier = plan?.currentTier?.id || null;
    if (!tier) return { ok: false, error: "loadCodeAssist returned no tier", argon };
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
      argon,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 160), argon };
  }
}

// Card text for the placeholder state: what Google actually said, and where the
// fix actually lives. Re-authenticating does NOT clear this state (verified
// 2026-09-22, DECISIONS.md) — the wording must not send anyone down that path.
export function antigravityPlaceholderMessage(plan) {
  const parts = [];
  if (plan?.ok && plan.paidTier && plan.paidTier !== plan.tier) {
    parts.push(`Google's API answers "${plan.tier}" for this account while naming "${plan.paidTier}" as its paid tier — the account's active AI subscription is not linked into Antigravity's entitlement system right now`);
  } else if (plan?.ok) {
    parts.push(`Google treats this Antigravity account as "${plan.tier}" with no metered allowance${plan.upgradeOffered ? " (and offers it a paid-plan upgrade)" : ""}`);
  } else {
    parts.push("Google reports a constant full allowance for this Antigravity account (unmetered placeholder)");
  }
  parts.push("every model pinned to 100% with one rolling 5 h reset, so no real window can be shown");
  parts.push("fix: Google-side entitlement sync, not a login problem — re-adding this Antigravity account on khpi5 changed nothing (verified 2026-09-22); report it to Google (Antigravity Help → Send Feedback, or discuss.ai.google.dev) and this card recovers by itself");
  return parts.join(" · ");
}
