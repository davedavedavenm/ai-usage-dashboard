#!/usr/bin/env node
/**
 * cdp-cookies.mjs — pull cookies out of the qwen-browser container's live
 * Chromium profile over the Chrome DevTools Protocol (Chrome 111+ hard-binds
 * CDP to its own loopback, hence the socat relay publishing it on the host).
 *
 * The logged-in browser profile is the single source of truth for the Alibaba
 * session: Dave logs in through the remote desktop, and this grabs whatever
 * Chrome holds — no manual cookie pastes anywhere.
 */
import { ALI_UA } from "./ali-session.mjs";

const CDP_BASE = process.env.AIUD_QWEN_CDP || "http://127.0.0.1:9333";
// Domains whose cookies make up a usable Bailian console session.
const DOMAIN_RE = /(?:^|\.)alibabacloud\.com$|(?:^|\.)aliyun\.com$/;
const CONNECT_TIMEOUT_MS = 5000;

function fetchWithTimeout(url, ms = CONNECT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: { "User-Agent": ALI_UA }, signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

function wsRequest(wsUrl, message, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("cdp websocket timeout"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      try { ws.send(JSON.stringify(message)); } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    ws.addEventListener("message", ev => {
      let data = null;
      try { data = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch {}
      if (data && data.id === message.id) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(data);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cdp websocket error"));
    });
  });
}

export async function grabAliCookieFromBrowser(cdpBase = CDP_BASE) {
  try {
    const metaRes = await fetchWithTimeout(cdpBase.replace(/\/$/, "") + "/json/version");
    if (!metaRes.ok) return { ok: false, error: "CDP HTTP " + metaRes.status };
    const meta = await metaRes.json();
    if (!meta.webSocketDebuggerUrl) return { ok: false, error: "no webSocketDebuggerUrl" };

    const reply = await wsRequest(meta.webSocketDebuggerUrl, { id: 1, method: "Storage.getCookies" });
    if (reply.error) return { ok: false, error: "CDP " + reply.error.message };
    const all = reply?.result?.cookies || [];
    const ali = all.filter(c => DOMAIN_RE.test(c.domain));
    if (!ali.length) return { ok: false, error: "no alibaba/aliyun cookies in browser profile" };

    // Same shape as a Cookie request header; keep jar order stable-ish.
    const header = ali.map(c => `${c.name}=${c.value}`).join("; ");
    if (/[^\x20-\x7E]/.test(header)) return { ok: false, error: "grabbed cookies contain non-ASCII characters" };
    return { ok: true, cookie: header, count: ali.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await grabAliCookieFromBrowser();
  console.log(JSON.stringify(res.ok ? { ok: true, count: res.count, chars: res.cookie.length } : res));
}
