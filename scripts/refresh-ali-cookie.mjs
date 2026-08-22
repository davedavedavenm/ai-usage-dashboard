#!/usr/bin/env node
/**
 * refresh-ali-cookie.mjs
 *
 * Uses Playwright Chromium to visit the Alibaba ModelStudio console,
 * which refreshes the session cookies (especially `isg`).
 * Reads the current cookie from settings.json, injects it into a
 * headless browser, navigates to the console, extracts refreshed
 * cookies, and writes them back.
 *
 * Run via cron every 2-3 hours to keep the session alive.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SETTINGS_PATH = process.env.AIUD_SETTINGS_PATH ||
  "/home/dave/stacks/ai-usage-dashboard/data/settings.json";
const CONSOLE_URL = "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan";
const TIMEOUT_MS = 30_000;

function parseCookieStr(header) {
  return header.split(/;\s*/).map(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return null;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) return null;
    return { name, value };
  }).filter(Boolean);
}

function cookieHeaderFromPairs(pairs) {
  return pairs.map(p => `${p.name}=${p.value}`).join("; ");
}

async function main() {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  const cookieStr = settings.alibabaCookie || "";
  if (!cookieStr) {
    console.error("No alibabaCookie in settings.json — nothing to refresh.");
    process.exit(1);
  }

  const cookies = parseCookieStr(cookieStr);
  if (!cookies.length) {
    console.error("Cookie parsed to zero entries.");
    process.exit(1);
  }

  console.log(`Injecting ${cookies.length} cookies, launching Chromium…`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  });

  // Inject cookies for both Alibaba domains
  const pwCookies = [];
  for (const c of cookies) {
    for (const domain of [".alibabacloud.com", ".alibaba.com", "modelstudio.console.alibabacloud.com", "bailian-singapore-cs.console.alibabacloud.com"]) {
      pwCookies.push({
        name: c.name,
        value: c.value,
        domain,
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "None",
      });
    }
  }
  await context.addCookies(pwCookies);

  const page = await context.newPage();
  try {
    console.log(`Navigating to ${CONSOLE_URL}…`);
    await page.goto(CONSOLE_URL, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS,
    });
    // Give the page time to make XHR calls that refresh cookies
    await page.waitForTimeout(5000);

    // Extract refreshed cookies
    const freshCookies = await context.cookies([
      "https://modelstudio.console.alibabacloud.com",
      "https://bailian-singapore-cs.console.alibabacloud.com",
      "https://bailian-singapore-cs.alibabacloud.com",
      "https://account.alibabacloud.com",
    ]);

    if (!freshCookies.length) {
      console.error("Browser returned zero cookies after navigation.");
      await browser.close();
      process.exit(1);
    }

    // Build new cookie header — prefer fresh values, fall back to original
    const cookieMap = new Map();
    for (const c of cookies) cookieMap.set(c.name, c.value);
    for (const c of freshCookies) {
      if (c.value && c.value.length > 2) {
        cookieMap.set(c.name, c.value);
      }
    }

    const newHeader = cookieHeaderFromPairs(
      [...cookieMap.entries()].map(([name, value]) => ({ name, value }))
    );

    // Sanity checks
    if (newHeader.length < 300) {
      console.error(`New cookie too short (${newHeader.length} chars) — aborting.`);
      await browser.close();
      process.exit(1);
    }

    // Check that key cookies are present
    const hasIsg = /isg=/.test(newHeader);
    const hasTicket = /login_aliyunid_ticket=/.test(newHeader);
    console.log(`Cookie refreshed: ${newHeader.length} chars, isg=${hasIsg}, ticket=${hasTicket}`);

    // Write back
    settings.alibabaCookie = newHeader;
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
    console.log(`Saved to ${SETTINGS_PATH}`);
  } catch (e) {
    console.error("Navigation error:", e.message);
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  console.log("Done.");
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
