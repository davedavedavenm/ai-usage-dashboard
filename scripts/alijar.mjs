#!/usr/bin/env node
/**
 * alijar.mjs — Alibaba session keeper
 *
 * Uses a persistent Chromium profile to keep the Alibaba console session alive.
 *
 * Modes:
 *   node alijar.mjs login      — open a visible browser for interactive login (runs on Xvfb)
 *   node alijar.mjs refresh    — visit the console to refresh session cookies (headless)
 *   node alijar.mjs export     — export cookies from the profile to settings.json
 *   node alijar.mjs check      — check if session is still valid
 *
 * The persistent profile lives at PROFILE_DIR (default: ~/.ali-session-profile).
 * Once you log in once via `login`, the profile remembers the session.
 * `refresh` keeps it alive; `export` pushes cookies to the dashboard settings.
 */
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { verifyAliCookie, writeSettingsAtomic } from "./ali-session.mjs";

const PROFILE_DIR = process.env.ALI_PROFILE_DIR || join(homedir(), ".ali-session-profile");
const SETTINGS_PATH = process.env.AIUD_SETTINGS_PATH ||
  "/home/dave/stacks/ai-usage-dashboard/data/settings.json";
const CONSOLE_URL = "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan/personal";
const LOGIN_URL = "https://account.alibabacloud.com/login/login.htm";
const TIMEOUT_MS = 45_000;

const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-web-security",
  "--lang=en-US",
];

async function launchPersistent(headed = false) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`Using profile: ${PROFILE_DIR}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !headed,
    args: CHROME_ARGS,
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    locale: "en-GB",
    ignoreHTTPSErrors: true,
  });
  return context;
}

async function launchHeadless() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: CHROME_ARGS,
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    locale: "en-GB",
    ignoreHTTPSErrors: true,
  });
  return context;
}

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

const EXPORT_ORIGINS = [
  "https://modelstudio.console.alibabacloud.com",
  "https://bailian-singapore-cs.console.alibabacloud.com",
  "https://bailian-singapore-cs.alibabacloud.com",
  "https://account.alibabacloud.com",
  "https://www.alibabacloud.com",
  "https://account.aliyun.com",
];

async function profileCookieHeader(context) {
  const cookies = await context.cookies(EXPORT_ORIGINS);
  return cookies.filter(c => c.value).map(c => `${c.name}=${c.value}`).join("; ");
}

async function doLogin() {
  console.log("Opening Alibaba console for interactive login…");
  console.log("Log in with your Alibaba Cloud account in the browser window.");
  console.log("The script will detect login and save the session automatically.");

  const context = await launchPersistent(true);
  const page = context.pages()[0] || await context.newPage();

  await page.goto(CONSOLE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });

  // Wait for the user to log in — detect by checking for a console page element
  // or by waiting for a redirect away from the login page
  console.log("Waiting for login… (checking every 5s)");
  let loggedIn = false;
  for (let i = 0; i < 120; i++) { // 10 minutes max
    await page.waitForTimeout(5000);
    const url = page.url();
    const hasLogin = await page.$('input[type="password"], input[name="password"], #fm-login-id');
    if (!hasLogin && !/login\.htm|login\.aliyun|passport/i.test(url)) {
      loggedIn = true;
      break;
    }
    if (i % 6 === 0) console.log(`  still waiting… (${Math.round((120 - i) * 5 / 60)}m left)`);
  }

  if (loggedIn) {
    console.log("Login detected! Saving session…");
    // Navigate to the console to ensure all cookies are set
    await page.goto(CONSOLE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForTimeout(3000);
    console.log("Session saved to profile. You can close this script.");
  } else {
    console.error("Login timed out after 10 minutes.");
  }

  await context.close();
}

async function doRefresh() {
  console.log("Refreshing Alibaba session…");
  const context = await launchHeadless();
  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(CONSOLE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForTimeout(5000);

    const url = page.url();
    const hasLogin = await page.$('input[type="password"], input[name="password"], #fm-login-id');
    if (hasLogin || /login\.htm|login\.aliyun|passport/i.test(url)) {
      console.error("Session expired — re-login required. Run: node alijar.mjs login");
      await context.close();
      process.exit(2);
    }

    // The SPA shell loads with HTTP 200 even when logged out, so the URL/form
    // check alone is not enough — verify against the real usage API.
    let check = await verifyAliCookie(await profileCookieHeader(context));
    if (!check.ok) {
      // Session cookies may still be settling; give the SPA one more chance.
      await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(8000);
      check = await verifyAliCookie(await profileCookieHeader(context));
    }
    if (!check.ok) {
      console.error(`Session expired (usage API: ${check.reason}) — re-login required. Run: node alijar.mjs login`);
      await context.close();
      process.exit(2);
    }

    console.log("Session refreshed OK.");
    await context.close();
  } catch (e) {
    console.error("Refresh error:", e.message);
    await context.close();
    process.exit(1);
  }
}

async function doExport() {
  console.log("Exporting cookies from profile…");
  const context = await launchHeadless();
  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(CONSOLE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForTimeout(3000);

    const url = page.url();
    const hasLogin = await page.$('input[type="password"], input[name="password"], #fm-login-id');
    if (hasLogin || /login\.htm|login\.aliyun|passport/i.test(url)) {
      console.error("Session expired — re-login required. Run: node alijar.mjs login");
      await context.close();
      process.exit(2);
    }

    // Extract all cookies from the browser
    const freshCookies = await context.cookies(EXPORT_ORIGINS);

    // Merge fresh cookies with existing cookie — fresh override, existing kept as fallback
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    const existingCookies = parseCookieStr(settings.alibabaCookie || "");
    const cookieMap = new Map();
    for (const c of existingCookies) cookieMap.set(c.name, c.value);
    for (const c of freshCookies) {
      if (c.value && c.value.length > 2) cookieMap.set(c.name, c.value);
    }

    const newHeader = cookieHeaderFromPairs(
      [...cookieMap.entries()].map(([name, value]) => ({ name, value }))
    );

    if (newHeader.length < 300) {
      console.error(`Exported cookie too short (${newHeader.length} chars) — aborting.`);
      await context.close();
      process.exit(1);
    }

    // Verify the merged cookie actually works before persisting it, so a dead
    // session never overwrites settings.json with a stale/useless cookie.
    const check = await verifyAliCookie(newHeader);
    if (!check.ok) {
      console.error(`Exported cookie failed verification (${check.reason}) — not saving. Re-login required: node alijar.mjs login`);
      await context.close();
      process.exit(2);
    }

    settings.alibabaCookie = newHeader;
    writeSettingsAtomic(SETTINGS_PATH, settings);
    console.log(`Exported ${cookieMap.size} cookies (${newHeader.length} chars) to ${SETTINGS_PATH}`);
  } catch (e) {
    console.error("Export error:", e.message);
    await context.close();
    process.exit(1);
  }

  await context.close();
}

async function doCheck() {
  const context = await launchHeadless();
  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(CONSOLE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    await page.waitForTimeout(3000);

    const url = page.url();
    const hasLogin = await page.$('input[type="password"], input[name="password"], #fm-login-id');
    if (hasLogin || /login\.htm|login\.aliyun|passport/i.test(url)) {
      console.log("EXPIRED");
      await context.close();
      process.exit(1);
    }

    const check = await verifyAliCookie(await profileCookieHeader(context));
    if (!check.ok) {
      console.log(`EXPIRED (${check.reason})`);
      await context.close();
      process.exit(1);
    }
    console.log("VALID");
    await context.close();
  } catch (e) {
    console.error("CHECK_ERROR:", e.message);
    await context.close();
    process.exit(1);
  }
}

async function doImport() {
  console.log("Importing cookies from settings.json into Playwright profile…");
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  const cookieStr = settings.alibabaCookie || "";
  if (!cookieStr) {
    console.error("No alibabaCookie in settings.json.");
    process.exit(1);
  }

  const cookies = parseCookieStr(cookieStr);
  if (!cookies.length) {
    console.error("Cookie parsed to zero entries.");
    process.exit(1);
  }

  const context = await launchPersistent();
  const page = context.pages()[0] || await context.newPage();

  // Inject cookies for Alibaba domains
  const pwCookies = [];
  const domains = [
    ".alibabacloud.com", ".alibaba.com",
    "modelstudio.console.alibabacloud.com",
    "bailian-singapore-cs.console.alibabacloud.com",
    "bailian-singapore-cs.alibabacloud.com",
    "account.alibabacloud.com",
  ];
  for (const c of cookies) {
    for (const domain of domains) {
      pwCookies.push({
        name: c.name, value: c.value, domain, path: "/",
        httpOnly: false, secure: true, sameSite: "None",
      });
    }
  }
  await context.addCookies(pwCookies);
  console.log(`Injected ${pwCookies.length} cookie entries.`);

  // Navigate to verify the session works
  await page.goto(CONSOLE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForTimeout(3000);

  const url = page.url();
  const hasLogin = await page.$('input[type="password"], input[name="password"], #fm-login-id');
  if (hasLogin || /login\.htm|login\.aliyun|passport/i.test(url)) {
    console.log("Session appears expired — login may be needed.");
  } else {
    console.log("Import verified — session is valid.");
  }

  await context.close();
}

const mode = process.argv[2];
switch (mode) {
  case "login":   await doLogin(); break;
  case "import":  await doImport(); break;
  case "refresh": await doRefresh(); break;
  case "export":  await doExport(); break;
  case "check":   await doCheck(); break;
  default:
    console.log("Usage: node alijar.mjs <login|import|refresh|export|check>");
    console.log("  login   — open browser for interactive Alibaba login");
    console.log("  import  — seed profile from settings.json cookie");
    console.log("  refresh — visit console to refresh session cookies (headless)");
    console.log("  export  — push profile cookies to dashboard settings.json");
    console.log("  check   — verify session is still valid");
    process.exit(1);
}
