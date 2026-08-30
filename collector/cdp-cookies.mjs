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
import http from "node:http";
import { URL as Url } from "node:url";
import WebSocketImpl from "ws";

const CDP_BASE = process.env.AIUD_CDP_BASE || "http://127.0.0.1:9333";
// Domains whose cookies make up a usable Bailian console session.
const DOMAIN_RE = /(?:^|\.)alibabacloud\.com$|(?:^|\.)aliyun\.com$/;
const CONNECT_TIMEOUT_MS = 5000;

// Chromium's DevTools HTTP endpoint validates the Host header (rejects
// anything but localhost/127.0.0.1 since ~M66). node's fetch (undici) silently
// drops a custom Host header (forbidden per fetch spec), so this MUST go
// through node:http where Host is settable — the compose-network route
// (http://qwen-browser:9333) only answers with the explicit override.
function fetchWithTimeout(url, ms = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new Url(url);
    const req = http.get({
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { "User-Agent": ALI_UA, Host: "localhost" },
      timeout: ms,
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(body) }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("cdp http timeout")); });
    req.on("error", reject);
  });
}

function wsRequest(wsUrl, message, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    // DevTools reports the browser-loopback ws://localhost/devtools/... URL
    // (no port, unreachable from here). Rewrite host:port to the relay
    // while keeping Host: localhost — the endpoint validates it. The ws
    // package allows the Host header; undici/WebSocket would silently drop
    // it (forbidden header), so node's built-in WebSocket cannot be used.
    const relay = new Url(CDP_BASE);
    const target = new Url(wsUrl);
    const ws = new WebSocketImpl(
      `ws://${relay.hostname}:${relay.port || 80}${target.pathname}${target.search}`,
      { headers: { Host: "localhost" }, handshakeTimeout: timeoutMs },
    );
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("cdp websocket timeout"));
    }, timeoutMs);
    ws.on("open", () => {
      try { ws.send(JSON.stringify(message)); } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    ws.on("message", (buf) => {
      let data = null;
      try { data = JSON.parse(buf.toString()); } catch {}
      if (data && data.id === message.id) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(data);
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error("cdp websocket error: " + String(e.message || e).slice(0, 80)));
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
