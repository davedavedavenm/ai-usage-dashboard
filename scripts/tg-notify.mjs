#!/usr/bin/env node
/**
 * tg-notify.mjs — send a Telegram message using the dashboard's own Telegram
 * settings (data/settings.json). No hardcoded tokens in shell scripts.
 *
 * Usage: node tg-notify.mjs "message text"
 */
import { readFileSync } from "fs";

const SETTINGS_PATH = process.env.AIUD_SETTINGS_PATH ||
  "/home/dave/stacks/ai-usage-dashboard/data/settings.json";

const text = process.argv.slice(2).join(" ");
if (!text) {
  console.error("usage: node tg-notify.mjs \"message\"");
  process.exit(1);
}

let settings = {};
try {
  settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
} catch {}
const tg = settings.telegram || {};
if (!tg.token || !tg.chatId) {
  console.error("no telegram token/chatId in settings.json");
  process.exit(1);
}

const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), 20000);
try {
  const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tg.chatId, text }),
    signal: ctrl.signal,
  });
  const body = await res.text();
  if (res.status !== 200) {
    console.error("HTTP " + res.status + " " + body.slice(0, 200));
    process.exit(1);
  }
  console.log("sent");
} catch (e) {
  console.error("send failed: " + String(e.message || e));
  process.exit(1);
} finally {
  clearTimeout(t);
}
