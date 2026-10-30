// Pure parsing helpers for provider quota payloads. Kept out of collect.mjs so
// they can be unit-tested without the collector's network and state dependencies.

export const ZAI_WINDOW_NAMES = { fiveHour: "Last 5 hours", weekly: "This week", mcp: "Tools (MCP)" };

// Provider reset timestamps arrive as epoch milliseconds (Z.ai) or ISO strings
// (OpenCode Go). A malformed value must not throw while the collector is
// assembling every provider; drop the reset instead.
export function isoFrom(value) {
  if (value == null || value === "") return undefined;
  const text = String(value);
  const ms = typeof value === "number"
    ? value
    : /^\d{10,}$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// Z.ai keys every allowance row by `unit` and has renamed the `type` string more
// than once (TOKENS_LIMIT on the token plans, CREDIT_LIMIT on the credit plans —
// verified live 2026-09-21, when the card died with "no usable windows" because
// the parser matched the old type literally). Mapping on unit keeps the card
// alive through plan renames: 3 = the rolling 5-hour window, 6 = the weekly
// window. TIME_LIMIT is the MCP tool allowance and carries no unit.
const ZAI_UNIT_WINDOWS = { 3: "fiveHour", 6: "weekly" };

export function zaiLimitWindow(limit) {
  const type = String(limit?.type || "");
  if (!type.endsWith("_LIMIT")) return null;
  if (type === "TIME_LIMIT") return "mcp";
  return ZAI_UNIT_WINDOWS[Number(limit?.unit)] || null;
}

// Z.ai's quota endpoint publishes usage windows only; the plan's billing date
// lives on the console subscription endpoint and answers to the same coding
// key. One row per purchased subscription — only a VALID row with a renewal
// date is usable. Keep the date as YYYY-MM-DD text: the console returns local
// dates, and parsing them into a Date would shift the day across timezones.
export function parseZaiSubscription(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const active = rows.find(row => {
    if (!row || String(row.status || "").toUpperCase() !== "VALID") return false;
    return /^\d{4}-\d{2}-\d{2}/.test(String(row.nextRenewTime || ""));
  });
  if (!active) return null;
  const productName = typeof active.productName === "string" ? active.productName.trim() : "";
  const billingCycle = typeof active.billingCycle === "string" ? active.billingCycle.trim().toLowerCase() : "";
  return {
    productName: productName || null,
    nextRenewDate: String(active.nextRenewTime).slice(0, 10),
    billingCycle: billingCycle || null,
    autoRenew: active.autoRenew === true || Number(active.autoRenew) === 1,
  };
}

// Percentage of the window still AVAILABLE. The API's `percentage` field is the
// share USED, floored to a whole percent; when a row carries its raw numbers
// those are exact, so they win (Z.ai "lite" weekly: 39 of 2000 used reads
// 98.05% remaining while `percentage` reports only "1" used).
export function zaiRemainingPercent(limit) {
  const cap = Number(limit?.usage);
  if (Number.isFinite(cap) && cap > 0) {
    const left = Number(limit?.remaining);
    if (Number.isFinite(left) && left >= 0) return clampPercent((left / cap) * 100);
    const used = Number(limit?.currentValue);
    if (Number.isFinite(used) && used >= 0) return clampPercent(((cap - used) / cap) * 100);
  }
  const usedPercent = Number(limit?.percentage);
  if (Number.isFinite(usedPercent)) return clampPercent(100 - usedPercent);
  return null;
}

// Google's quota buckets (`remainingFraction`, surfaced by the quota CLI as
// `percent_remaining`) are a constant 1 for accounts Google does not meter, and
// every model then shares one reset stamped "now + 5 h" (verified 2026-09-21:
// all 27 buckets at 1.0 on a free-tier Antigravity account, pinned at 100%
// across 500 consecutive samples). Such a report carries no information, so the
// collector must not publish it as an allowance. A report is treated as the
// placeholder only when it matches the whole signature: every window exactly
// 100%, one shared reset, and that reset inside the rolling 5-hour window. Real
// usage — or a real rate-limit event, which the CLI reports as 0% with the
// server's own reset time — never matches, so the card resumes normal reporting
// on its own once the account is metered.
export function isConstantAntigravityReport(entries, now = Date.now()) {
  const rows = (entries || []).filter(e => e && e.renderType === "percent" && typeof e.percentRemaining === "number");
  if (rows.length < 2) return false;
  if (!rows.every(e => e.percentRemaining === 100)) return false;
  if (!rows[0].resetAt) return false;
  if (new Set(rows.map(e => e.resetAt)).size !== 1) return false;
  const delta = Date.parse(rows[0].resetAt) - now;
  return delta > 4 * 60 * 60 * 1000 && delta < 6 * 60 * 60 * 1000;
}

function clampPercent(value) {
  // Two decimals is plenty for a percentage and keeps the published JSON free of
  // float dust like 98.00000000000001.
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function parseAnthropicWindow(win) {
  if (!win || typeof win !== "object") return null;
  const rawUsed = win.utilization ?? win.used_percentage ?? win.usedPercentage ?? win.used_percent ?? win.usedPercent;
  const used = typeof rawUsed === "string" ? Number(rawUsed) : rawUsed;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const rawReset = win.resets_at ?? win.resetsAt ?? win.reset_at ?? win.resetAt;
  let resetAt;
  if (typeof rawReset === "string" && rawReset.trim()) {
    const ms = Date.parse(rawReset.trim());
    if (Number.isFinite(ms)) resetAt = new Date(ms).toISOString();
  }
  return {
    percentRemaining: Math.max(0, Math.min(100, Math.round(100 - used))),
    resetAt,
  };
}

export function parseAnthropicOAuthUsage(data) {
  if (!data || typeof data !== "object") return null;
  const roots = [data, data.quota, data.usage, data.rate_limits, data.rateLimits, data.oauth_usage, data.oauthUsage]
    .filter(r => r && typeof r === "object");
  for (const root of roots) {
    const five = parseAnthropicWindow(root.five_hour ?? root.fiveHour);
    const seven = parseAnthropicWindow(root.seven_day ?? root.sevenDay);
    if (!five || !seven) continue;
    const entries = [
      { name: "5h", renderType: "percent", percentRemaining: five.percentRemaining, resetAt: five.resetAt, window: "5h" },
      { name: "Weekly", renderType: "percent", percentRemaining: seven.percentRemaining, resetAt: seven.resetAt, window: "weekly" },
    ];
    const rows = Array.isArray(root.seven_day_breakdown?.rows) ? root.seven_day_breakdown.rows : [];
    const activeRows = rows
      .filter(r => r && typeof r.display_name === "string" && typeof r.percent === "number" && r.percent > 0)
      .map(r => `${r.display_name} ${Math.round(r.percent)}%`);
    const result = { status: "ok", label: "anthropic", entries };
    if (activeRows.length) result.note = "weekly usage: " + activeRows.join(" · ");
    return result;
  }
  return null;
}

const ANTIGRAVITY_MODEL_SPECS = [
  {
    id: "G4ARGON",
    name: "G4Argon",
    window: "agy-g4argon",
    keys: [
      "gemini-4-argon",
      "gemini-4-argon-high",
      "gemini-4-argon-medium",
      "gemini-4-argon-low",
      "gemini-4-argon-contributor",
      "gemini-4-pro",
      "gemini-4-flash",
    ],
    prefixRe: /^gemini-4(?:\.\d+)?-|argon/i,
  },
  {
    id: "G3PRO",
    name: "G3Pro",
    window: "agy-g3pro",
    keys: [
      "gemini-3.1-pro",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "gemini-3-pro-high",
      "gemini-3-pro-low",
      "gemini-3.5-pro-high",
      "gemini-3.5-pro-low",
    ],
    prefixRe: /^gemini-3(?:\.\d+)?-pro(?!-image)/i,
  },
  {
    id: "G3FLASH",
    name: "G3Flash",
    window: "agy-g3flash",
    keys: [
      "gemini-3-flash",
      "gemini-3.8-flash-tiered",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "gemini-3.5-flash-low",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
    ],
    prefixRe: /^gemini-3(?:\.\d+)?-flash(?!-image)/i,
  },
  {
    id: "CLAUDE",
    name: "Claude",
    window: "agy-claude",
    keys: [
      "claude-opus-5-5-high",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-low",
      "claude-sonnet-5-5-high",
      "claude-sonnet-5-5-medium",
      "claude-sonnet-5-5-low",
      "claude-opus-4-6-thinking",
      "claude-opus-4-6",
      "claude-sonnet-4-6-thinking",
      "claude-sonnet-4-6",
      "claude-opus-4-5-thinking",
      "claude-opus-4-5",
    ],
    prefixRe: /^(?:gemini-)?claude-(?:opus|sonnet)-/i,
  },
  {
    id: "G3IMAGE",
    name: "G3Image",
    window: "agy-g3image",
    keys: [
      "gemini-3.1-flash-image",
      "gemini-3-pro-image",
    ],
    prefixRe: /^gemini-3(?:\.\d+)?-(?:pro|flash)-image/i,
  },
];

export function extractAntigravityModelEntries(modelsMap) {
  if (!modelsMap || typeof modelsMap !== "object") return [];
  const allKeys = Object.keys(modelsMap);
  const entries = [];
  for (const spec of ANTIGRAVITY_MODEL_SPECS) {
    let matched = null;
    for (const k of spec.keys) {
      if (modelsMap[k]?.quotaInfo) {
        matched = modelsMap[k].quotaInfo;
        break;
      }
    }
    if (!matched) {
      const fallbackKey = allKeys.find(k => spec.prefixRe.test(k) && modelsMap[k]?.quotaInfo);
      if (fallbackKey) matched = modelsMap[fallbackKey].quotaInfo;
    }
    if (!matched || typeof matched.remainingFraction !== "number") continue;
    entries.push({
      name: spec.name,
      renderType: "percent",
      percentRemaining: Math.max(0, Math.min(100, Math.round(matched.remainingFraction * 100))),
      resetAt: matched.resetTime || undefined,
      window: spec.window,
    });
  }
  return entries;
}

// GPT-OSS is not an Antigravity model Dave uses. The host quota config may
// still ask the CLI for it, so drop it at the display boundary before the
// card and alert code see it. The id is spelled "GPT-OSS" in display output
// and "GPTOSS" in the host config - match both.
export function filterAntigravityDisplayEntries(entries) {
  return (entries || []).filter(e => e && !/gpt[-_]oss/i.test(String(e.name || "")));
}

// v1internal:retrieveUserQuotaSummary (UA antigravity/cli/1.4.7+) publishes
// family groups. Gemini 4 Argon has its own group and is absent from the old
// fetchAvailableModels / retrieveUserQuota endpoints the quota CLI still uses,
// which is why the card used to say Google hid the model. Return a publishable
// percent entry for the Argon bucket, or null when the summary has no usable
// (non-disabled) Argon window.
export function antigravityQuotaSummaryArgon(body) {
  const groups = Array.isArray(body?.groups) ? body.groups : [];
  for (const group of groups) {
    if (!group) continue;
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    const isArgon = /argon/i.test(String(group.displayName || "")) ||
      buckets.some(b => b && /argon/i.test(`${b.bucketId || ""} ${b.displayName || ""}`));
    if (!isArgon) continue;
    for (const bucket of buckets) {
      if (!bucket || bucket.disabled) continue;
      if (typeof bucket.remainingFraction !== "number" || !Number.isFinite(bucket.remainingFraction)) continue;
      const resetAt = typeof bucket.resetTime === "string" && bucket.resetTime.trim()
        ? bucket.resetTime.trim()
        : undefined;
      return {
        name: "G4Argon",
        renderType: "percent",
        percentRemaining: Math.round(Math.max(0, Math.min(1, bucket.remainingFraction)) * 100),
        resetAt,
        window: "agy-g4argon",
      };
    }
  }
  return null;
}

// Fallback when the quota-summary endpoint does not return an Argon bucket.
// The old fetchAvailableModels / retrieveUserQuota path omits Argon, but that
// is an endpoint limitation, not proof the account lacks the model. Keep the
// row honest: "not reported", plus the tier readback for diagnostics.
export function antigravityG4ArgonUnavailable(plan) {
  const tier = plan?.ok && typeof plan.tier === "string" ? plan.tier : "";
  const paid = plan?.ok && typeof plan.paidTier === "string" ? plan.paidTier : "";
  const contradiction = Boolean(tier && paid && tier !== paid);
  const tierNote = contradiction
    ? ` (loadCodeAssist still answers ${tier} while naming ${paid} as the paid tier)`
    : tier
      ? ` (loadCodeAssist answers ${tier})`
      : "";
  return {
    entry: {
      name: "G4Argon",
      renderType: "value",
      value: "not reported by Google",
      window: "agy-g4argon",
      degraded: true,
    },
    note: `Google's quota summary did not return a G4Argon bucket this run${tierNote}; the Antigravity app may still offer the model. This is not proof the model is unavailable.`,
  };
}

const MAX_RETAIN_AGE_MS = 24 * 60 * 60 * 1000;

export function retainSkippedProviders(newProviders, prevRecord, now = Date.now()) {
  const merged = { ...(newProviders || {}) };
  const prevProviders = prevRecord?.envelope?.providers;
  const prevAt = Number(prevRecord?.receivedAt);
  if (!prevProviders || typeof prevProviders !== "object") return merged;
  if (!Number.isFinite(prevAt) || now - prevAt > MAX_RETAIN_AGE_MS) return merged;
  for (const [id, prov] of Object.entries(prevProviders)) {
    if (!merged[id] && prov && (prov.status === "ok" || prov.status === "partial")) {
      merged[id] = prov;
    }
  }
  return merged;
}
