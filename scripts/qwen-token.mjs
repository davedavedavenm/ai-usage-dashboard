import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, renameSync, chmodSync } from "fs";

const STATE_PATH = process.env.QWEN_PROBE_STATE_PATH ||
  join(homedir(), ".claude", ".qwen-probe.json");

const PROBE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions";
const PROBE_MODEL = process.env.QWEN_PROBE_MODEL || "qwen3.6-flash";
const AVAILABLE_RECHECK_MS = 2 * 60 * 60 * 1000;
const EXHAUSTED_RECHECK_MS = 15 * 60 * 1000;

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

function parseResetAt(message) {
  const m = /reset at (\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC/i.exec(message || "");
  if (!m) return null;
  const now = new Date();
  const year = now.getUTCFullYear();
  let reset = new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])));
  if (reset.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
    reset = new Date(Date.UTC(year + 1, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])));
  }
  return reset.toISOString();
}

async function probeQuota(apiKey) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(PROBE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model: PROBE_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    const headers = {};
    for (const [k, v] of res.headers.entries()) {
      if (/quota|limit|remaining|usage|plan|retry/i.test(k)) headers[k] = v;
    }
    return { status: res.status, body, headers };
  } catch (e) {
    return { status: 0, error: String(e.message || e).slice(0, 160) };
  } finally {
    clearTimeout(t);
  }
}

function entryFromState(state, now) {
  if (state.lastStatus === "exhausted" && state.resetAt) {
    const reset = Date.parse(state.resetAt);
    if (reset > now) {
      return { status: "ok", label: "Qwen", entries: [{ name: "This week", renderType: "percent", percentRemaining: 0, resetAt: state.resetAt, window: "weekly" }] };
    }
  }
  if (state.lastStatus === "available") {
    const ageMin = Math.round((now - state.lastAvailableCheckAt) / 60000);
    return { status: "ok", label: "Qwen", entries: [{ name: "This week", renderType: "value", value: "quota available", window: "weekly" }], note: `checked ${ageMin}m ago via token-plan probe` };
  }
  return null;
}

export async function fetchQwenTokenPlan(apiKey) {
  if (!apiKey) return { status: "unavailable" };
  const now = Date.now();
  const state = readJson(STATE_PATH) || {};
  if (/[^\x20-\x7E]/.test(apiKey)) {
    return { status: "error", error: "Qwen API key contains non-ASCII characters — re-copy it." };
  }

  if (state.lastStatus === "exhausted" && state.resetAt && Date.parse(state.resetAt) > now &&
      (!state.lastProbeAt || now - state.lastProbeAt < EXHAUSTED_RECHECK_MS)) {
    const cached = entryFromState(state, now);
    if (cached) return cached;
  }
  if (state.lastStatus === "available" && state.lastAvailableCheckAt &&
      now - state.lastAvailableCheckAt < AVAILABLE_RECHECK_MS) {
    const cached = entryFromState(state, now);
    if (cached) return cached;
  }

  const r = await probeQuota(apiKey);
  const next = { ...state, lastProbeAt: now, lastProbeStatus: r.status, lastProbeHeaders: r.headers || {} };

  if (r.status === 200) {
    next.lastStatus = "available";
    next.lastAvailableCheckAt = now;
    delete next.resetAt;
    writeJsonAtomic(STATE_PATH, next);
    return { status: "ok", label: "Qwen", entries: [{ name: "This week", renderType: "value", value: "quota available", window: "weekly" }], note: "token-plan probe succeeded" };
  }

  const msg = r.body?.error?.message || r.body?.message || "";
  if (r.status === 429 && /quota/i.test(msg)) {
    let resetAt = parseResetAt(msg);
    if (!resetAt && r.headers && r.headers["retry-after"]) {
      resetAt = new Date(now + Number(r.headers["retry-after"]) * 1000).toISOString();
    }
    next.lastStatus = "exhausted";
    next.resetAt = resetAt || new Date(now + 24 * 60 * 60 * 1000).toISOString();
    writeJsonAtomic(STATE_PATH, next);
    return { status: "ok", label: "Qwen", entries: [{ name: "This week", renderType: "percent", percentRemaining: 0, resetAt: next.resetAt, window: "weekly" }], note: "token-plan probe: quota exhausted" };
  }

  writeJsonAtomic(STATE_PATH, next);
  if (r.status === 401 || r.status === 403) {
    return { status: "error", error: "Qwen token-plan key rejected (HTTP " + r.status + ") — check the API key" };
  }
  return { status: "error", error: "Qwen token-plan probe error: HTTP " + r.status + (msg ? " — " + String(msg).slice(0, 120) : "") };
}

export function resolveQwenApiKey({ auth, settings, env }) {
  if (typeof settings?.qwenApiKey === "string" && settings.qwenApiKey.trim()) {
    return settings.qwenApiKey.trim();
  }
  // env may be the raw key string (collect.mjs) or an env-like object.
  if (typeof env === "string" && env.trim()) return env.trim();
  if (env && typeof env.AIUD_QWEN_API_KEY === "string" && env.AIUD_QWEN_API_KEY.trim()) {
    return env.AIUD_QWEN_API_KEY.trim();
  }
  for (const k of ["bailian-token-plan-personal", "alibaba-token-plan"]) {
    const e = auth?.[k];
    if (e && e.type === "api" && typeof e.key === "string" && e.key.trim()) return e.key.trim();
  }
  return "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const auth = readJson(join(homedir(), ".local", "share", "opencode", "auth.json")) || {};
  const key = resolveQwenApiKey({ auth });
  if (!key) {
    console.log(JSON.stringify({ status: "error", error: "no Qwen API key found" }));
    process.exit(1);
  }
  const res = await fetchQwenTokenPlan(key);
  console.log(JSON.stringify(res, null, 1));
  process.exit(res.status === "error" ? 1 : 0);
}