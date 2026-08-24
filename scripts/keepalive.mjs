#!/usr/bin/env node
/**
 * keepalive.mjs — Keep Alibaba session alive by hitting the console page.
 *
 * Reads the cookie from settings.json, makes a request to the console,
 * captures any refreshed cookies from Set-Cookie headers, merges them
 * back into the original cookie string, and saves to settings.json.
 *
 * Validity is checked with verifyAliCookie() (real token-plan usage API call),
 * NOT by inspecting the loginInfo response — the console SPA and loginInfo
 * endpoint both answer 200 even when the session is dead.
 *
 * No browser needed — just plain HTTP fetch.
 */
import { readFileSync } from "fs";
import { verifyAliCookie, writeSettingsAtomic, ALI_UA } from "./ali-session.mjs";

const SETTINGS_PATH = process.env.AIUD_SETTINGS_PATH ||
  "/home/dave/stacks/ai-usage-dashboard/data/settings.json";
const CONSOLE_URL = "https://modelstudio.console.alibabacloud.com/ap-southeast-1/";
const ALI_FE = "https://modelstudio.console.alibabacloud.com";
const ALI_API = "https://bailian-singapore-cs.alibabacloud.com/data/api.json";

function parseCookieStr(header) {
  return header.split(/;\s*/).map(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return null;
    return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
  }).filter(c => c && c.name);
}

function cookieHeaderFromPairs(pairs) {
  return pairs.map(p => `${p.name}=${p.value}`).join("; ");
}

function mergeCookies(original, setCookieHeaders) {
  const map = new Map();
  for (const c of parseCookieStr(original)) map.set(c.name, c.value);

  for (const hdr of setCookieHeaders) {
    // Parse "name=value; Path=/; ..." — take just name=value
    const firstPart = hdr.split(/;\s*/)[0];
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx === -1) continue;
    const name = firstPart.slice(0, eqIdx).trim();
    const value = firstPart.slice(eqIdx + 1).trim();
    if (name && value) map.set(name, value);
    // Also handle Max-Age=0 / Expires=... in the past → remove cookie
    if (/Max-Age\s*=\s*0|Expires\s*=\s*(?:Thu,)?\s*01\s*Jan/i.test(hdr)) {
      map.delete(name);
    }
  }

  return cookieHeaderFromPairs([...map.entries()].map(([name, value]) => ({ name, value })));
}

async function main() {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  const cookie = settings.alibabaCookie || "";
  if (!cookie) {
    console.error("No alibabaCookie in settings.json.");
    process.exit(1);
  }
  console.log(`Current cookie: ${cookie.length} chars`);

  // Authoritative check first: is the session actually alive?
  const pre = await verifyAliCookie(cookie);
  if (!pre.ok) {
    console.error(`SESSION_EXPIRED (${pre.reason})`);
    process.exit(2);
  }

  // Step 1: hit the console page to refresh session; capture Set-Cookie.
  const ctrl1 = new AbortController();
  const t1 = setTimeout(() => ctrl1.abort(), 15000);
  const pageRes = await fetch(CONSOLE_URL, {
    headers: {
      Cookie: cookie,
      "User-Agent": ALI_UA,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "manual",
    signal: ctrl1.signal,
  });
  clearTimeout(t1);

  const pageSetCookies = pageRes.headers.getSetCookie?.() || [];
  console.log(`Console page: ${pageRes.status}, Set-Cookie: ${pageSetCookies.length}`);

  // Hard redirect to the login page is an unambiguous expiry signal.
  const loc = pageRes.headers.get("location") || "";
  if (/login\.htm|passport/i.test(loc)) {
    console.error("SESSION_EXPIRED (login redirect)");
    process.exit(2);
  }

  // Step 2: hit the loginInfo API to collect any refreshed cookies.
  const ctrl2 = new AbortController();
  const t2 = setTimeout(() => ctrl2.abort(), 15000);
  const apiRes = await fetch(ALI_API + "?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.cornerstone-portal.cs-console.loginInfo&_v=undefined", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": ALI_UA,
      "X-Requested-With": "XMLHttpRequest",
      Referer: CONSOLE_URL,
      Origin: ALI_FE,
    },
    body: "params=%7B%22Api%22%3A%22zeldaEasy.cornerstone-portal.cs-console.loginInfo%22%7D&region=ap-southeast-1",
    signal: ctrl2.signal,
  });
  clearTimeout(t2);

  const apiSetCookies = apiRes.headers.getSetCookie?.() || [];
  console.log(`loginInfo API: ${apiRes.status}, Set-Cookie: ${apiSetCookies.length}`);

  // Step 3: merge refreshed cookies, verify the result, then save.
  const allSetCookies = [...pageSetCookies, ...apiSetCookies];
  let newCookie = cookie;
  if (allSetCookies.length > 0) {
    const merged = mergeCookies(cookie, allSetCookies);
    console.log(`Merged: ${allSetCookies.length} Set-Cookie headers → ${merged.length} chars`);
    if (merged.length > 300) newCookie = merged;
    else console.log("Merged cookie too short — keeping original");
  } else {
    console.log("No Set-Cookie headers — cookie unchanged");
  }

  const post = await verifyAliCookie(newCookie);
  if (!post.ok) {
    console.error(`SESSION_EXPIRED (post-refresh verify: ${post.reason})`);
    process.exit(2);
  }

  if (newCookie !== cookie) {
    settings.alibabaCookie = newCookie;
    writeSettingsAtomic(SETTINGS_PATH, settings);
    console.log("Saved updated cookie to settings.json");
  }

  console.log("OK");
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
