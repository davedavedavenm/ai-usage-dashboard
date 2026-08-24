#!/usr/bin/env node
/**
 * ali-session.mjs — shared Alibaba Cloud (Bailian / ModelStudio) console helpers.
 *
 * The authoritative "is this console session alive?" test is verifyAliCookie():
 * resolve sec_token and call the token-plan usage API. Page loads and
 * loginInfo responses are NOT reliable signals — the console SPA shell loads
 * with HTTP 200 even when logged out.
 */
import { writeFileSync, renameSync } from "fs";

export const ALI_QUOTA_BASE = "https://bailian-singapore-cs.alibabacloud.com";
export const ALI_CONSOLE = "https://modelstudio.console.alibabacloud.com";
export const ALI_FE_URL = ALI_CONSOLE + "/ap-southeast-1/?tab=plan#/efm/subscription/token-plan/personal";
export const ALI_REGION = "ap-southeast-1";
export const ALI_ACTION = "IntlBroadScopeAspnGateway";
export const ALI_CONSOLE_SITE = "MODELSTUDIO_ALBABACLOUD";
export const ALI_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
export const ALI_APIS = {
  usage: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
  subscription: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription",
  quotaConfig: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config",
};

const REQ_TIMEOUT_MS = 20000;

export function aliCookieValue(cookieHeader, name) {
  const m = new RegExp("(?:^|;\\s*)" + name + "=([^;]+)").exec(cookieHeader || "");
  return m ? m[1] : null;
}

function aliTraceId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function resolveAliSecToken(cookie) {
  const fromCookie = aliCookieValue(cookie, "sec_token");
  if (fromCookie) return fromCookie;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(ALI_FE_URL, {
      headers: { Cookie: cookie, "User-Agent": ALI_UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const html = await res.text();
    const m = /sec_token["']?\s*[:=]\s*["']([A-Za-z0-9_:-]+)/.exec(html);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function aliCall(api, cookie, secToken, extraData) {
  const params = {
    Api: api,
    V: "1.0",
    Data: {
      ...(extraData || {}),
      cornerstoneParam: {
        feTraceId: aliTraceId(),
        feURL: ALI_FE_URL,
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        switchUserType: 3,
        domain: "modelstudio.console.alibabacloud.com",
        consoleSite: ALI_CONSOLE_SITE,
        userNickName: "",
        userPrincipalName: "",
        xsp_lang: "en-US",
      },
    },
  };
  const body = new URLSearchParams({
    product: "sfm_bailian",
    action: ALI_ACTION,
    region: ALI_REGION,
    language: "en-US",
    params: JSON.stringify(params),
    ...(secToken ? { sec_token: secToken } : {}),
  });
  const url = ALI_QUOTA_BASE + "/data/api.json?action=" + ALI_ACTION + "&product=sfm_bailian&api=" + encodeURIComponent(api) + "&_v=undefined";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": ALI_UA,
        "Origin": ALI_CONSOLE,
        "Referer": ALI_FE_URL,
        "Cookie": cookie,
      },
      body: body.toString(),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (json && typeof json === "object") {
      for (const v of Object.values(json)) {
        if (v && typeof v === "object" && v.errorCode) {
          return { error: String(v.errorCode) + (v.errorMsg && v.errorMsg !== v.errorCode ? " " + v.errorMsg : "") };
        }
      }
    }
    if (res.status !== 200) return { error: "HTTP " + res.status };
    return { json, raw: text };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 160) };
  } finally {
    clearTimeout(t);
  }
}

export async function verifyAliCookie(cookie) {
  if (!cookie) return { ok: false, reason: "no cookie" };
  if (/[^\x20-\x7E]/.test(cookie)) {
    return { ok: false, reason: "cookie contains non-ASCII characters (truncated copy)" };
  }
  const secToken = await resolveAliSecToken(cookie);
  let usage = await aliCall(ALI_APIS.usage, cookie, secToken);
  if (usage.error && !/NotLogined|NeedLogin/i.test(usage.error)) {
    await new Promise(r => setTimeout(r, 2000));
    usage = await aliCall(ALI_APIS.usage, cookie, secToken);
  }
  if (usage.error) {
    if (/NotLogined|NeedLogin/i.test(usage.error)) {
      return { ok: false, reason: "session expired (" + usage.error + ")" };
    }
    return { ok: false, reason: "usage API error: " + usage.error };
  }
  return { ok: true };
}

export function writeSettingsAtomic(settingsPath, settings) {
  const tmp = settingsPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, settingsPath);
}
