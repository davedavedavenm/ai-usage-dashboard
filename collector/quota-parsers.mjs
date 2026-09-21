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
