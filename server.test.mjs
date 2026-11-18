import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error("server exited early with " + child.exitCode);
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server failed to answer /api/health");
}

test("server manages OpenCode Go API key settings, masking, trigger file, and unset test error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiud-srv-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, INGEST_KEY: "test-ingest-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForHealth(baseUrl, child);

    // 1. Initially unset
    const r0 = await fetch(`${baseUrl}/api/settings`);
    assert.equal(r0.status, 200);
    const s0 = await r0.json();
    assert.deepEqual(s0.opencodeGo, { apiKeySet: false, apiKeyMask: "" });

    // 2. Test endpoint rejects when unset
    const t0 = await fetch(`${baseUrl}/api/opencode-go-test`, { method: "POST" });
    assert.equal(t0.status, 422);

    // 3. Reject short / whitespace / non-ASCII keys
    for (const bad of ["short", "ocgo_test key_12345", "ocgo_test_key_…_1234"]) {
      const rb = await fetch(`${baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opencodeGoApiKey: bad }),
      });
      assert.equal(rb.status, 422);
    }

    // 4. Save valid fake key -> masked response, raw key persisted, trigger created
    const fakeKey = "ocgo_test_fake_1234567890";
    const r1 = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opencodeGoApiKey: `  ${fakeKey}  ` }),
    });
    assert.equal(r1.status, 200);
    const rawText = await r1.text();
    assert.equal(rawText.includes(fakeKey), false);
    const s1 = JSON.parse(rawText);
    assert.equal(s1.opencodeGo.apiKeySet, true);
    assert.equal(s1.opencodeGo.apiKeyMask, "ocgo_t…7890");

    const settingsPath = join(dir, "settings.json");
    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(saved.opencodeGoApiKey, fakeKey);
    if (process.platform !== "win32") {
      assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
    }
    assert.equal(existsSync(join(dir, "collect.trigger")), true);

    // 5. GET /api/settings stays masked
    const r2 = await fetch(`${baseUrl}/api/settings`);
    const r2Text = await r2.text();
    assert.equal(r2Text.includes(fakeKey), false);
    assert.deepEqual(JSON.parse(r2Text).opencodeGo, { apiKeySet: true, apiKeyMask: "ocgo_t…7890" });

    // 6. Clear key
    const r3 = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opencodeGoApiKey: "" }),
    });
    assert.equal(r3.status, 200);
    const s3 = await r3.json();
    assert.deepEqual(s3.opencodeGo, { apiKeySet: false, apiKeyMask: "" });
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).opencodeGoApiKey, undefined);

    const t1 = await fetch(`${baseUrl}/api/opencode-go-test`, { method: "POST" });
    assert.equal(t1.status, 422);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => {
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 2000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
