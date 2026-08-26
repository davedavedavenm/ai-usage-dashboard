#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { refreshClaudeTokenIfNeeded } from "./claude-token.mjs";
import { refreshOpenAITokenIfNeeded } from "./chatgpt-token.mjs";
import { fetchQwenTokenPlan, resolveQwenApiKey } from "./qwen-token.mjs";
import { ALI_APIS, aliCall, resolveAliSecToken } from "./ali-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function readParentEnv() {
  try {
    return readFileSync(join(HERE, "..", ".env"), "utf8").split("\n");
  } catch {
    return [];
  }
}

function envValue(lines, name) {
  const m = lines.map(l => l.trim()).filter(Boolean).find(l => l.startsWith(name + "="));
  return m ? m.slice(name.length + 1).trim() : "";
}

const AUTH_FILE = process.env.AIUD_AUTH_FILE || join(homedir(), ".local", "share", "opencode", "auth.json");
const INGEST_URL = process.env.AIUD_INGEST_URL || "http://127.0.0.1:8099/api/ingest";
const ZAI_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const GO_URL = "https://opencode.ai/zen/go/v1/usage";
const CLI_BIN = process.env.AIUD_CLI_BIN || join(HERE, "node_modules", ".bin", "opencode-quota");
// Cron PATH (/usr/bin:/bin) lacks ~/.local/bin and /usr/local/bin, where the claude
// binary lives — without it opencode-quota reports auth_status=unknown, skips the
// live quota probe entirely, and the provider vanishes from the dashboard. The CLI
// is therefore ALWAYS spawned with an augmented PATH, whatever env invoked us.
const CLI_PATH = [
  join(homedir(), ".local", "bin"),
  "/usr/local/bin",
  process.env.PATH || "/usr/bin:/bin",
].join(":"); // ":" = PATH delimiter (not path.sep)
// cron does not source .env — fall back to the stack .env file for AIUD_* overrides
const DASHBOARD_URL = process.env.AIUD_DASHBOARD_URL || envValue(readParentEnv(), "AIUD_DASHBOARD_URL") || "http://localhost:8099";
const COLLECTOR_NAME = process.env.AIUD_COLLECTOR_NAME || envValue(readParentEnv(), "AIUD_COLLECTOR_NAME") || "collector";
const REQ_TIMEOUT_MS = 20000;

const ZAI_WINDOW_NAMES = { fiveHour: "Last 5 hours", weekly: "This week", mcp: "Tools (MCP)" };
const GO_WINDOW_NAMES = { rolling: "Last 5 hours", weekly: "This week", monthly: "This month" };
const STATUS_PROVIDERS = ["anthropic", "openai", "google-antigravity", "google-gemini-cli", "google-agy"];
const ALERT_THRESHOLD_DEFAULT = 15;
const TG_API = "https://api.telegram.org";

function readAuth() {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return {};
  }
}

function readIngestKey() {
  if (process.env.INGEST_KEY) return process.env.INGEST_KEY;
  try {
    const env = readFileSync(join(HERE, "..", ".env"), "utf8");
    const m = env.split("\n").map(l => l.trim()).filter(Boolean).find(l => l.startsWith("INGEST_KEY="));
    return m ? m.slice("INGEST_KEY=".length) : "";
  } catch {
    return "";
  }
}

function apiKey(auth, id) {
  const e = auth[id];
  if (!e) return null;
  if (e.type === "api" && typeof e.key === "string" && e.key) return e.key;
  if (e.type === "oauth" && typeof e.access === "string" && e.access) return { oauth: e.access };
  return null;
}

async function getJson(url, headers, okStatus) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    if (res.status !== (okStatus || 200)) {
      return { error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    }
    return { body };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 160) };
  } finally {
    clearTimeout(t);
  }
}

function pctEntry(name, percentRemaining, resetAtIso, window) {
  return { name, renderType: "percent", percentRemaining: Math.round(percentRemaining), resetAt: resetAtIso, window };
}

async function fetchZai(auth) {
  const key = apiKey(auth, "zai-coding-plan");
  if (!key || typeof key === "object") return { status: "unavailable" };
  const result = await getJson(ZAI_URL, {
    Authorization: key,
    "User-Agent": "OpenCode-Quota-Toast/1.0",
    "Content-Type": "application/json",
  });
  if (result.error) return { status: "error", error: "Z.ai API error " + result.error };
  const limits = result.body?.data?.limits ?? result.body?.limits;
  if (!Array.isArray(limits) || !limits.length) return { status: "error", error: "Z.ai API error: no limits in response" };
  const entries = [];
  for (const limit of limits) {
    if (typeof limit.percentage !== "number") continue;
    let win = null;
    if (limit.type === "TOKENS_LIMIT" && limit.unit === 3) win = "fiveHour";
    else if (limit.type === "TOKENS_LIMIT" && limit.unit === 6) win = "weekly";
    else if (limit.type === "TIME_LIMIT") win = "mcp";
    if (!win) continue;
    const resetIso = limit.nextResetTime ? new Date(Math.round(limit.nextResetTime)).toISOString() : undefined;
    entries.push(pctEntry(ZAI_WINDOW_NAMES[win], 100 - limit.percentage, resetIso, win));
  }
  if (!entries.length) return { status: "error", error: "Z.ai API error: no usable windows" };
  const planRow = typeof result.body?.data?.level === "string"
    ? [{ name: "Plan level", renderType: "value", value: result.body.data.level }]
    : [];
  return { status: entries.length >= 3 ? "ok" : "partial", label: "Z.ai", entries: [...planRow, ...entries] };
}

async function fetchOpenCodeGo(auth) {
  const key = apiKey(auth, "opencode-go");
  if (!key || typeof key === "object") return { status: "unavailable" };
  const result = await getJson(GO_URL, { Authorization: "Bearer " + key, Accept: "application/json" });
  if (result.error) return { status: "error", error: "OpenCode Go API error " + result.error };
  const usage = result.body?.usage;
  if (!usage) return { status: "error", error: "Invalid OpenCode Go API response: usage missing" };
  const entries = [];
  const errors = [];
  for (const win of ["rolling", "weekly", "monthly"]) {
    const w = usage[win];
    if (!w || typeof w.percent !== "number") {
      errors.push(`${win}: ${w?.status ?? "missing"}`);
      continue;
    }
    const resetIso = w.resetsAt ? new Date(Date.parse(w.resetsAt)).toISOString() : undefined;
    if (w.status !== "ok") {
      entries.push({ ...pctEntry(GO_WINDOW_NAMES[win], 100 - w.percent, resetIso, win), name: GO_WINDOW_NAMES[win] + " (limited)" });
      errors.push(`${win}: ${w.status}`);
      continue;
    }
    entries.push(pctEntry(GO_WINDOW_NAMES[win], 100 - w.percent, resetIso, win));
  }
  if (entries.length && errors.length) return { status: "partial", label: "OpenCode Go", entries, error: "OpenCode Go API error: " + errors.join("; ") };
  if (!entries.length && errors.length) return { status: "error", error: "OpenCode Go API error: " + errors.join("; ") };
  return { status: "ok", label: "OpenCode Go", entries };
}

function aliFindContaining(value, keys) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = aliFindContaining(item, keys);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    if (keys.some(k => value[k] !== undefined)) return value;
    for (const item of Object.values(value)) {
      const found = aliFindContaining(item, keys);
      if (found) return found;
    }
  }
  return null;
}

function aliPercent(raw) {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n >= 0 && n <= 1) return Math.round(n * 1000) / 10;
  return Math.round(n * 10) / 10;
}

// Real percentage windows from the Alibaba token-plan usage API. The cookie is
// maintained automatically (keepalive merge + browser-profile refresh/export);
// when it is dead or absent the key probe below takes over silently.
async function fetchQwen(cookie) {
  if (!cookie) return { status: "unavailable" };
  if (/[^\x20-\x7E]/.test(cookie)) {
    return { status: "error", error: "Cookie contains non-ASCII characters — re-copy via right-click → Copy as cURL and paste in Settings." };
  }
  const secToken = await resolveAliSecToken(cookie);
  const usage = await aliCall(ALI_APIS.usage, cookie, secToken);
  if (usage.error) {
    if (/NotLogined|NeedLogin/i.test(usage.error)) {
      return { status: "unavailable", error: "console session expired" };
    }
    return { status: "error", error: "Alibaba API error " + usage.error };
  }
  const usageObj = usage.json && aliFindContaining(usage.json, ["per5HourPercentage", "per1WeekPercentage"]);
  if (!usageObj) return { status: "error", error: "Alibaba API error: no usage windows in response" };
  const entries = [];
  const p5 = aliPercent(usageObj.per5HourPercentage);
  const pw = aliPercent(usageObj.per1WeekPercentage);
  if (p5 != null) {
    const reset = usageObj.per5HourResetTime ? new Date(usageObj.per5HourResetTime).toISOString() : undefined;
    entries.push(pctEntry("Last 5 hours", 100 - p5, reset, "5h"));
  }
  if (pw != null) {
    const reset = usageObj.per1WeekResetTime ? new Date(usageObj.per1WeekResetTime).toISOString() : undefined;
    entries.push(pctEntry("This week", 100 - pw, reset, "weekly"));
  }
  if (!entries.length) return { status: "error", error: "Alibaba API error: usage windows empty" };
  return { status: "ok", label: "Qwen", entries, note: "live percentages via console session" };
}

function runStatusCli(providerId) {
  if (!existsSync(CLI_BIN)) return { error: "opencode-quota CLI not found at " + CLI_BIN };
  const childEnv = { ...process.env, PATH: CLI_PATH };
  try {
    const args = ["status", "--provider", providerId];
    const out = execFileSync(CLI_BIN, args, {
      encoding: "utf8",
      timeout: 90000,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    if (process.env.AIUD_DEBUG_DUMP) {
      try {
        writeFileSync(`/tmp/aiud-cli-${providerId}.out`, out);
        const dbg = execFileSync("sh", ["-c", 'echo "PATH=$PATH"; command -v claude || echo NO_CLAUDE_ON_CHILD_PATH'], {
          encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"], env: childEnv,
        });
        writeFileSync(`/tmp/aiud-cli-${providerId}.envdbg`, dbg);
      } catch {}
    }
    return { text: out };
  } catch (e) {
    return { error: String(e.stderr || e.message || e).slice(0, 200) };
  }
}

function parseStatus(text) {
  const providers = {};
  let section = null;
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const secMatch = /^([a-z0-9_-]+):$/.exec(line);
    if (secMatch) {
      section = secMatch[1];
      if (!providers[section]) providers[section] = [];
      continue;
    }
    if (!section) continue;
    const m = /^\s*-\s*(.+?):\s*(.*)$/.exec(line);
    if (m) providers[section].push({ key: m[1].trim(), value: m[2].trim() });
  }
  return providers;
}

function entriesFromStatusSection(section) {
  const entries = [];
  const errors = [];
  let probe = null;
  for (const { key, value } of section) {
    if (key === "live_fetch_error" || key === "live_error_1") errors.push(value);
    if (key === "live_probe") probe = value;
    if (key === "message" && /error/i.test(value)) errors.push(value.slice(0, 200));
    const pe = /^(.*?)\s+percent_remaining=(\d+)(?:\.\d+)?(?:\s+reset_at=(\S+))?/.exec(value);
    if (pe) {
      let name = pe[1];
      name = name.replace(/^live_entry_\d+:\s*/, "").replace(/:$/, "").trim();
      const window = /weekly/i.test(name) ? "weekly" : /monthly/i.test(name) ? "monthly" : /hourly|5h/i.test(name) ? "5h" : "5h";
      const resetAt = pe[3] && pe[3] !== "(none)" ? pe[3] : undefined;
      entries.push(pctEntry(name, Number(pe[2]), resetAt, window));
    }
  }
  if (entries.length) return { entries, status: probe === "error" || errors.length ? "partial" : "ok", error: errors[0] };
  if (errors.length || probe === "error") return { status: "error", error: errors[0] || "quota probe failed" };
  return null;
}

function fetchFromStatus(providerId, section) {
  const parsed = entriesFromStatusSection(section);
  if (!parsed) return { status: "unavailable" };
  return { ...parsed, label: providerId };
}

const STATE_FILE = join(HERE, "state.json");
const ANTHROPIC_429_COOLDOWN_MS = 30 * 60 * 1000;

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

function readDashboardSettings() {
  try {
    return JSON.parse(readFileSync(join(HERE, "..", "data", "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

function readAlertConfig() {
  const lines = readParentEnv();
  const dash = readDashboardSettings().telegram || {};
  const threshold = Number(dash.threshold ?? envValue(lines, "AIUD_ALERT_THRESHOLD") ?? ALERT_THRESHOLD_DEFAULT);
  return {
    enabled: dash.enabled === false ? false : envValue(lines, "AIUD_ALERT_ENABLED") !== "false",
    threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : ALERT_THRESHOLD_DEFAULT,
    token: dash.token || envValue(lines, "AIUD_TG_BOT_TOKEN"),
    chatId: dash.chatId || envValue(lines, "AIUD_TG_CHAT_ID"),
  };
}

function tightestEntry(providers) {
  const out = [];
  for (const [id, r] of Object.entries(providers)) {
    if (!r || !Array.isArray(r.entries)) continue;
    let best = null;
    for (const e of r.entries) {
      if (!e || e.renderType !== "percent" || typeof e.percentRemaining !== "number") continue;
      if (!best || e.percentRemaining < best.percentRemaining) best = e;
    }
    if (best) out.push({ id, label: r.label || id, entry: best });
  }
  return out;
}

function buildStages(threshold) {
  const final = Math.max(5, Math.min(Number(threshold) || 15, 49));
  return [
    { pct: 50, emoji: "🟡", headline: "half gone", line: "Halfway through" },
    { pct: 30, emoji: "🟠", headline: "getting low", line: "Getting low" },
    { pct: final, emoji: "🔴", headline: "nearly out", line: "Nearly out" },
  ].sort((a, b) => b.pct - a.pct);
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildAlertText(stage, info) {
  const { label, entry, pct } = info;
  const out = pct <= 0;
  const emoji = out ? "🚨" : stage.emoji;
  const headline = out ? "is out of allowance" : stage.headline;
  const pctText = out ? "Nothing left" : `<b>${pct}%</b> left`;
  const resetText = entry.resetAt
    ? "\nResets " + new Date(entry.resetAt).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    : "";
  return `<b>${emoji} ${esc(label)} · ${esc(entry.name)} — ${headline}</b>\n${pctText}${resetText}\n${esc(DASHBOARD_URL)}`;
}

async function sendTelegram(cfg, text) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${TG_API}/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: "HTML" }),
      signal: ctrl.signal,
    });
    const body = await res.text();
    return `HTTP ${res.status} ${body.slice(0, 120)}`;
  } catch (e) {
    return "error " + String(e.message || e).slice(0, 120);
  } finally {
    clearTimeout(t);
  }
}

async function runAlerts(providers, state, cfg) {
  if (!cfg.enabled || !cfg.token || !cfg.chatId) {
    console.log(JSON.stringify({ at: new Date().toISOString(), alerts: "disabled" }));
    return;
  }
  const stages = buildStages(cfg.threshold);
  const norm = (s) => (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + "Z");
  const winKeyOf = (e) => `${e.window || ""}|${e.resetAt || ""}`;
  for (const { id, label, entry } of tightestEntry(providers)) {
    const pct = entry.percentRemaining;
    const stage = [...stages].reverse().find(s => pct <= s.pct);
    if (!stage) continue;
    const winKey = winKeyOf(entry);
    state.alerts = state.alerts || {};
    const prev = state.alerts[id];
    let sent = {};
    if (prev && prev.winKey) {
      const pk = prev.winKey.split("|");
      const ck = winKey.split("|");
      const sameReset = pk[1] && ck[1] &&
        Math.abs(new Date(norm(pk[1])).getTime() - new Date(norm(ck[1])).getTime()) < 2 * 3600 * 1000;
      if (pk[0] === ck[0] && sameReset) {
        sent = (prev.stages && typeof prev.stages === "object") ? prev.stages : {};
        if (!prev.stages && pct <= ALERT_THRESHOLD_DEFAULT) sent[stage.pct] = true;
      }
    }
    if (sent[stage.pct]) continue;
    const result = await sendTelegram(cfg, buildAlertText(stage, { label, entry, pct }));
    sent[stage.pct] = new Date().toISOString();
    state.alerts[id] = { winKey, sentAt: new Date().toISOString(), stages: sent, result };
    writeState(state);
  }
}

async function main() {
  const auth = readAuth();
  const state = readState();
  const providers = {};
  const skipped = {};
  const direct = { zai: await fetchZai(auth), "opencode-go": await fetchOpenCodeGo(auth) };
  const dashSettings = readDashboardSettings();
  const aliCookie = (typeof dashSettings.alibabaCookie === "string" && dashSettings.alibabaCookie) ||
    envValue(readParentEnv(), "AIUD_ALIBABA_COOKIE").replace(/^["']|["']$/g, "");
  const qwenKey = resolveQwenApiKey({
    auth,
    settings: dashSettings,
    env: envValue(readParentEnv(), "AIUD_QWEN_API_KEY"),
  });
  {
    // Qwen has two complementary sources: the console session (real percentage
    // windows, kept alive automatically by keepalive + profile refresh/export)
    // and the token-plan API key (always answers: available / exhausted+reset).
    // Cookie first for fidelity; key takes over silently when it is dead/absent.
    let qwenResult = aliCookie ? await fetchQwen(aliCookie) : { status: "unavailable" };
    if (qwenResult.status !== "ok" && qwenKey) {
      const keyResult = await fetchQwenTokenPlan(qwenKey);
      if (keyResult.status === "ok" || !aliCookie || keyResult.status !== "unavailable") {
        qwenResult = keyResult;
      }
    }
    direct["alibaba-coding-plan"] = qwenResult;
  }
  for (const [id, r] of Object.entries(direct)) {
    if (r.status !== "unavailable") providers[id] = r;
  }
  for (const id of STATUS_PROVIDERS) {
    if (providers[id]) continue;
    if (id === "anthropic") {
      await refreshClaudeTokenIfNeeded();
      if (state.anthropic429Until > Date.now()) {
        const mins = Math.ceil((state.anthropic429Until - Date.now()) / 60000);
        providers.anthropic = { status: "error", error: `Anthropic quota probe paused after HTTP 429; retry in ~${mins}m.` };
        continue;
      }
    }
    if (id === "openai") {
      // opencode-quota reads auth.json directly and never triggers a refresh;
      // renew the ChatGPT token ourselves before probing.
      await refreshOpenAITokenIfNeeded();
    }
    const cli = runStatusCli(id);
    if (cli.error) {
      skipped[id] = String(cli.error).slice(0, 160);
      continue;
    }
    const sections = parseStatus(cli.text);
    const sec = sections[id] || sections[id.replace(/-/g, "_")];
    if (!sec) {
      skipped[id] = "no status section in CLI output";
      continue;
    }
    const r = fetchFromStatus(id, sec);
    if (r.status === "unavailable") {
      skipped[id] = "no usable entries in CLI output";
      continue;
    }
    providers[id] = r;
    if (id === "anthropic" && r.status === "error" && /429/.test(r.error)) {
      state.anthropic429Until = Date.now() + ANTHROPIC_429_COOLDOWN_MS;
      writeState(state);
    } else if (id === "anthropic" && r.status === "ok" && state.anthropic429Until) {
      delete state.anthropic429Until;
      writeState(state);
    }
  }
  const envelope = {
    version: 2,
    exportedAt: Math.floor(Date.now() / 1000),
    collector: COLLECTOR_NAME,
    providers,
  };
  await runAlerts(providers, state, readAlertConfig());
  const key = readIngestKey();
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Key": key },
    body: JSON.stringify(envelope),
  });
  const line = {
    at: new Date().toISOString(),
    http: res.status,
    providers: Object.fromEntries(Object.entries(providers).map(([id, r]) => [id, r.status])),
  };
  if (Object.keys(skipped).length) line.skipped = skipped;
  console.log(JSON.stringify(line));
  process.exit(res.status === 204 ? 0 : 1);
}

main().catch(e => {
  console.log(JSON.stringify({ at: new Date().toISOString(), fatal: String(e.message || e) }));
  process.exit(1);
});