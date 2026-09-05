#!/usr/bin/env node
/**
 * runner.mjs — in-container scheduler for the collector (replaces host cron).
 *
 * One process owns all spawning, so runs can never overlap (the flock rule
 * from the host-cron era is preserved by construction) and env is always the
 * container env — the 2026-08-25 "cron strips PATH" class of bug cannot recur.
 * Logs are JSON lines on stdout → `docker logs aiud-collector`.
 */
import { spawn } from "child_process";
import { existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AIUD_DATA_DIR || join(HERE, "..", "data");
const TRIGGER_FILE = join(DATA_DIR, "collect.trigger");

const COLLECT_INTERVAL_MS = 10 * 60 * 1000;
const KEEPALIVE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 9 * 60 * 1000; // < interval: a wedged run can't stall the next

let collectRunning = false;

function delayToNextBoundary(intervalMs) {
  const now = Date.now();
  return Math.ceil(now / intervalMs) * intervalMs - now + 5_000;
}

function runScript(script) {
  return new Promise((resolve) => {
    const child = spawn("node", [script], { stdio: ["ignore", "inherit", "inherit"] });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, RUN_TIMEOUT_MS);
    child.on("exit", (code, sig) => {
      clearTimeout(timer);
      resolve({ code, sig });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, sig: String(e.message || e) });
    });
  });
}

async function doCollect(label = "collect") {
  if (collectRunning) return;
  collectRunning = true;
  try {
    const res = await runScript("collect.mjs");
    console.log(JSON.stringify({ at: new Date().toISOString(), scheduler: label, exit: res.code ?? res.sig }));
  } finally {
    collectRunning = false;
  }
}

async function collectLoop() {
  await doCollect("collect-init");
  for (;;) {
    await new Promise((r) => setTimeout(r, delayToNextBoundary(COLLECT_INTERVAL_MS)));
    await doCollect("collect");
  }
}

async function keepaliveLoop() {
  await runScript("keepalive.mjs");
  for (;;) {
    await new Promise((r) => setTimeout(r, delayToNextBoundary(KEEPALIVE_INTERVAL_MS)));
    const res = await runScript("keepalive.mjs");
    console.log(JSON.stringify({ at: new Date().toISOString(), scheduler: "keepalive", exit: res.code ?? res.sig }));
  }
}

// Watch for on-demand collect trigger file from server or user
setInterval(async () => {
  if (existsSync(TRIGGER_FILE)) {
    try { unlinkSync(TRIGGER_FILE); } catch {}
    console.log(JSON.stringify({ at: new Date().toISOString(), scheduler: "trigger", event: "collect_requested" }));
    await doCollect("on-demand");
  }
}, 1000);

collectLoop();
keepaliveLoop();
