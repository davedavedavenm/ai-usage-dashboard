const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "8099", 10);
const INGEST_KEY = process.env.INGEST_KEY || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const LATEST = path.join(DATA_DIR, "latest.json");
const HISTORY = path.join(DATA_DIR, "history.jsonl");
const SETTINGS = path.join(DATA_DIR, "settings.json");
const TRIGGER_FILE = path.join(DATA_DIR, "collect.trigger");
const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const MAX_BODY = 512 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(s) {
  const tmp = SETTINGS + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, SETTINGS);
}

function maskSecret(v) {
  if (!v) return "";
  if (v.length <= 10) return v.slice(0, 2) + "…";
  return v.slice(0, 6) + "…" + v.slice(-4);
}

function cookieNames(header) {
  return String(header || "").split(";").map(c => c.split("=")[0].trim()).filter(Boolean);
}

function settingsView() {
  const s = readSettings();
  const cookie = typeof s.alibabaCookie === "string" ? s.alibabaCookie : "";
  const nonAscii = /[^\x20-\x7E]/.test(cookie);
  return {
    telegram: {
      enabled: s.telegram ? s.telegram.enabled !== false : true,
      threshold: (s.telegram && Number.isFinite(Number(s.telegram.threshold))) ? Number(s.telegram.threshold) : 15,
      chatId: (s.telegram && typeof s.telegram.chatId === "string") ? s.telegram.chatId : "",
      tokenSet: !!(s.telegram && s.telegram.token),
      tokenMask: maskSecret(s.telegram && s.telegram.token),
    },
    webhook: {
      urlSet: !!(s.webhook && typeof s.webhook.url === "string" && s.webhook.url),
      urlMask: maskSecret((s.webhook && typeof s.webhook.url === "string") ? s.webhook.url : ""),
    },
    alibaba: {
      cookieSet: cookie.length > 200,
      cookieLen: cookie.length,
      cookieTruncated: nonAscii || /…|\.\.\./.test(cookie),
      cookieNames: cookieNames(cookie).slice(0, 40),
    },
    qwen: {
      apiKeySet: typeof s.qwenApiKey === "string" && s.qwenApiKey.length > 20,
      apiKeyMask: maskSecret(typeof s.qwenApiKey === "string" ? s.qwenApiKey : ""),
    },
  };
}

function keyMatches(provided) {
  if (!INGEST_KEY || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(INGEST_KEY);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function rotateHistory() {
  try {
    const st = fs.statSync(HISTORY);
    if (st.size < HISTORY_MAX_BYTES) return;
    const lines = fs.readFileSync(HISTORY, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(HISTORY, lines.slice(-500).join("\n") + "\n");
  } catch {}
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (code, body, type) => {
    res.writeHead(code, {
      "Content-Type": type || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(body);
  };

  if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = fs.readFileSync(path.join(__dirname, "public", "index.html"));
      return send(200, html, "text/html; charset=utf-8");
    } catch {
      return send(500, "index missing");
    }
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/health") {
    return send(200, JSON.stringify({ ok: true, uptime: process.uptime() }));
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/quota") {
    try {
      const raw = fs.readFileSync(LATEST);
      return send(200, raw);
    } catch {
      return send(200, JSON.stringify({ receivedAt: null, envelope: null }));
    }
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/history") {
    try {
      const lines = fs.readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).slice(-500);
      const out = [];
      for (const line of lines) {
        try { out.push(JSON.parse(line)); } catch {}
      }
      return send(200, JSON.stringify(out));
    } catch {
      return send(200, "[]");
    }
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/settings") {
    return send(200, JSON.stringify(settingsView()));
  }

  if (req.method === "POST" && url.pathname === "/api/collect") {
    try {
      fs.writeFileSync(TRIGGER_FILE, JSON.stringify({ at: Date.now() }));
      return send(200, JSON.stringify({ ok: true, triggeredAt: Date.now() }));
    } catch (e) {
      return send(500, JSON.stringify({ error: "failed to trigger collect: " + e.message }));
    }
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    let body = Buffer.alloc(0);
    req.on("data", (chunk) => {
      body = Buffer.concat([body, chunk]);
      if (body.length > MAX_BODY) {
        res.writeHead(413);
        res.end();
        req.destroy();
      }
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return send(400, '{"error":"invalid json"}');
      }
      if (!parsed || typeof parsed !== "object") return send(422, '{"error":"expected object"}');
      const s = readSettings();
      if (parsed.telegram && typeof parsed.telegram === "object") {
        s.telegram = s.telegram || {};
        if (typeof parsed.telegram.token === "string") {
          const t = parsed.telegram.token.trim();
          if (t === "") delete s.telegram.token;
          else if (t.length < 20) return send(422, '{"error":"telegram token looks too short"}');
          else s.telegram.token = t;
        }
        if (typeof parsed.telegram.chatId === "string") s.telegram.chatId = parsed.telegram.chatId.trim();
        if (parsed.telegram.threshold != null) {
          const th = Number(parsed.telegram.threshold);
          if (!Number.isFinite(th) || th <= 0 || th > 100) return send(422, '{"error":"threshold must be 1-100"}');
          s.telegram.threshold = th;
        }
        if (typeof parsed.telegram.enabled === "boolean") s.telegram.enabled = parsed.telegram.enabled;
      }
      if (parsed.webhook && typeof parsed.webhook === "object") {
        s.webhook = s.webhook || {};
        if (typeof parsed.webhook.url === "string") {
          const u = parsed.webhook.url.trim();
          if (u === "") delete s.webhook.url;
          else if (!/^https?:\/\//i.test(u)) return send(422, '{"error":"webhook URL must start with http:// or https://"}');
          else s.webhook.url = u;
        }
      }
      if (typeof parsed.alibabaCookie === "string") {
        const c = parsed.alibabaCookie.trim();
        if (c === "") delete s.alibabaCookie;
        else if (/[^\x20-\x7E]/.test(c)) return send(422, JSON.stringify({ error: "cookie contains non-ASCII characters — it was copied truncated (DevTools shows an ellipsis). Copy via right-click the request → Copy → Copy as cURL (bash), then take the cookie: value." }));
        else if (c.length < 300) return send(422, '{"error":"cookie looks too short — a full Alibaba console cookie is usually 1500+ characters"}');
        else s.alibabaCookie = c;
      }
      if (typeof parsed.qwenApiKey === "string") {
        const k = parsed.qwenApiKey.trim();
        if (k === "") delete s.qwenApiKey;
        else if (/[^\x20-\x7E]/.test(k)) return send(422, '{"error":"API key contains non-ASCII characters"}');
        else s.qwenApiKey = k;
      }
      try {
        writeSettings(s);
        return send(200, JSON.stringify(settingsView()));
      } catch (e) {
        return send(500, '{"error":"storage failure"}');
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/telegram-test") {
    const s = readSettings();
    const token = s.telegram && s.telegram.token;
    const chatId = s.telegram && s.telegram.chatId;
    if (!token || !chatId) return send(422, '{"error":"set telegram bot token and chat id first"}');
    const payload = JSON.stringify({
      chat_id: chatId,
      parse_mode: "HTML",
      text: "✅ <b>AI Allowance alerts are live</b>\nYou'll get staged warnings per window — 🟡 50% → 🟠 30% → 🔴 final threshold — once per reset, plus 🚨 when a window hits 0%.",
    });
    const reqOpts = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };
    const tg = https.request("https://api.telegram.org/bot" + token + "/sendMessage", reqOpts, (tr) => {
      let tb = "";
      tr.on("data", (c) => (tb += c));
      tr.on("end", () => {
        let ok = tr.statusCode === 200;
        let detail = "";
        try {
          const tj = JSON.parse(tb);
          ok = ok && tj.ok === true;
          if (!ok && tj.description) detail = String(tj.description).slice(0, 120);
        } catch {}
        send(ok ? 200 : 502, JSON.stringify({ ok, detail }));
      });
    });
    tg.on("error", (e) => send(502, JSON.stringify({ ok: false, detail: String(e.message).slice(0, 120) })));
    tg.write(payload);
    tg.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/webhook-test") {
    const s = readSettings();
    const webhookUrl = s.webhook && s.webhook.url;
    if (!webhookUrl) return send(422, '{"error":"set webhook URL first in Settings"}');
    const payload = JSON.stringify({
      event: "test",
      message: "Test alert from AI Allowance Dashboard",
      timestamp: new Date().toISOString(),
    });
    try {
      const u = new URL(webhookUrl);
      const client = u.protocol === "https:" ? https : http;
      const reqOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: 5000,
      };
      const wr = client.request(u, reqOpts, (r) => {
        let wb = "";
        r.on("data", c => wb += c);
        r.on("end", () => {
          const ok = r.statusCode >= 200 && r.statusCode < 300;
          send(ok ? 200 : 502, JSON.stringify({ ok, status: r.statusCode, detail: wb.slice(0, 120) }));
        });
      });
      wr.on("error", (e) => send(502, JSON.stringify({ ok: false, detail: String(e.message).slice(0, 120) })));
      wr.on("timeout", () => { wr.destroy(); send(504, '{"ok":false,"detail":"timeout"}'); });
      wr.write(payload);
      wr.end();
    } catch (e) {
      return send(422, JSON.stringify({ error: "invalid webhook URL: " + e.message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest") {
    if (!keyMatches(req.headers["x-ingest-key"])) return send(401, '{"error":"unauthorized"}');
    let body = Buffer.alloc(0);
    req.on("data", (chunk) => {
      body = Buffer.concat([body, chunk]);
      if (body.length > MAX_BODY) {
        res.writeHead(413);
        res.end();
        req.destroy();
      }
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return send(400, '{"error":"invalid json"}');
      }
      if (!parsed || parsed.version !== 2 || typeof parsed.providers !== "object") {
        return send(422, '{"error":"expected opencode-quota export v2"}');
      }
      try {
        const receivedAt = Date.now();
        const record = { receivedAt, envelope: parsed };
        const tmp = LATEST + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(record));
        fs.renameSync(tmp, LATEST);
        const p = {};
        const w = {};
        for (const [id, r] of Object.entries(parsed.providers || {})) {
          if (!r || !Array.isArray(r.entries)) continue;
          let tight = null;
          let geminiPreferred = null;
          for (const e of r.entries) {
            if (!e || e.renderType !== "percent" || typeof e.percentRemaining !== "number") continue;
            const winKey = e.window || e.name || "default";
            w[`${id}:${winKey}`] = e.percentRemaining;
            if (id === "google-antigravity") {
              const isClaudeOrGpt = /claude|gpt/i.test(`${e.name} ${e.window}`);
              const isG3Flash = /flash/i.test(`${e.name} ${e.window}`);
              if (isG3Flash) {
                geminiPreferred = e.percentRemaining;
              } else if (!isClaudeOrGpt && (geminiPreferred === null || e.percentRemaining < geminiPreferred)) {
                geminiPreferred = e.percentRemaining;
              }
            }
            if (tight === null || e.percentRemaining < tight) tight = e.percentRemaining;
          }
          if (id === "google-antigravity" && geminiPreferred !== null) {
            p[id] = geminiPreferred;
          } else if (tight !== null) {
            p[id] = tight;
          }
        }
        fs.appendFileSync(HISTORY, JSON.stringify({ receivedAt, exportedAt: parsed.exportedAt || null, p, w }) + "\n");
        rotateHistory();
        return send(204, "");
      } catch (e) {
        console.error("ingest storage failure:", e.message);
        return send(500, '{"error":"storage failure"}');
      }
    });
    return;
  }

  send(404, '{"error":"not found"}');
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ai-usage-dashboard listening on 0.0.0.0:${PORT}`);
});
