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

const COLLECT_INTERVAL_MS = 10 * 60 * 1000;
const KEEPALIVE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 9 * 60 * 1000; // < interval: a wedged run can't stall the next

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

async function loop(script, intervalMs, label) {
  await runScript(script); // immediate first run: a fresh stack shows data at once
  for (;;) {
    await new Promise((r) => setTimeout(r, delayToNextBoundary(intervalMs)));
    const res = await runScript(script);
    console.log(JSON.stringify({ at: new Date().toISOString(), scheduler: label, exit: res.code ?? res.sig }));
  }
}

loop("collect.mjs", COLLECT_INTERVAL_MS, "collect");
loop("keepalive.mjs", KEEPALIVE_INTERVAL_MS, "keepalive");
