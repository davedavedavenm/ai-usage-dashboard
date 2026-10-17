// Pure parsing helpers for provider quota payloads. Kept out of collect.mjs so
// they can be unit-tested without the collector's network and state dependencies.

export const ZAI_WINDOW_NAMES = { fiveHour: "Last 5 hours", weekly: "This week", mcp: "Tools (MCP)" };

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
    if (activeRows.length) result.note = "weekly split: " + activeRows.join(" · ");
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
  {
    id: "GPTOSS",
    name: "GPT-OSS",
    window: "agy-gptoss",
    keys: [
      "gpt-oss-120b-medium",
      "gpt-oss-120b-high",
      "gpt-oss-120b-low",
      "gpt-oss-120b",
    ],
    prefixRe: /^gpt-oss-/i,
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
