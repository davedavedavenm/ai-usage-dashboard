import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndSyncOpenCodeGoKey, sha256Hex } from "./opencode-go-key.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "aiud-ocgo-"));
}

test("new settings.opencodeGoApiKey syncs to auth.json with 0600, preserves siblings, stores only sha256 hash", () => {
  const dir = makeTempDir();
  try {
    const authPath = join(dir, "auth.json");
    const initialAuth = {
      openai: { type: "oauth", access: "oa-access", refresh: "oa-refresh", expires: 1234567890 },
      "opencode-go": { type: "api", key: "ocgo_old_key_000" },
    };
    writeFileSync(authPath, JSON.stringify(initialAuth), { mode: 0o600 });

    const fakeNewKey = "ocgo_test_fake_new_1234567890";
    const state = {};
    const stateWrites = [];
    const res = resolveAndSyncOpenCodeGoKey({
      auth: initialAuth,
      authPath,
      settings: { opencodeGoApiKey: `  ${fakeNewKey}  ` },
      env: "",
      state,
      writeState: (s) => stateWrites.push(JSON.parse(JSON.stringify(s))),
    });

    assert.deepEqual(res, { key: fakeNewKey, source: "settings", synced: true });
    const writtenAuth = JSON.parse(readFileSync(authPath, "utf8"));
    assert.deepEqual(writtenAuth.openai, initialAuth.openai);
    assert.deepEqual(writtenAuth["opencode-go"], { type: "api", key: fakeNewKey });
    if (process.platform !== "win32") {
      assert.equal(statSync(authPath).mode & 0o777, 0o600);
    }
    assert.equal(state.syncedOpenCodeGoKeyHash, sha256Hex(fakeNewKey));
    assert.equal(JSON.stringify(state).includes(fakeNewKey), false);
    assert.equal(stateWrites.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subsequent runs with unchanged hash allow CLI auth.json updates to win without overwriting", () => {
  const dir = makeTempDir();
  try {
    const authPath = join(dir, "auth.json");
    const settingsKey = "ocgo_settings_fake_123456";
    const cliNewKey = "ocgo_cli_newer_fake_999999";
    writeFileSync(authPath, JSON.stringify({ "opencode-go": { type: "api", key: cliNewKey } }), { mode: 0o600 });

    const state = { syncedOpenCodeGoKeyHash: sha256Hex(settingsKey) };
    let writes = 0;
    const authSnapshot = JSON.parse(readFileSync(authPath, "utf8"));

    const res = resolveAndSyncOpenCodeGoKey({
      auth: authSnapshot,
      authPath,
      settings: { opencodeGoApiKey: settingsKey },
      env: "",
      state,
      writeState: () => { writes++; },
    });

    assert.deepEqual(res, { key: cliNewKey, source: "auth", synced: false });
    assert.equal(writes, 0);
    assert.equal(JSON.parse(readFileSync(authPath, "utf8"))["opencode-go"].key, cliNewKey);

    // When auth.json matches settings key, source reports settings+auth without rewriting
    const matchAuth = { "opencode-go": { type: "api", key: settingsKey } };
    const resMatch = resolveAndSyncOpenCodeGoKey({
      auth: matchAuth,
      authPath,
      settings: { opencodeGoApiKey: settingsKey },
      env: "",
      state,
      writeState: () => { writes++; },
    });
    assert.deepEqual(resMatch, { key: settingsKey, source: "settings+auth", synced: false });
    assert.equal(writes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing settings.opencodeGoApiKey clears synced hash and falls back to env then auth.json", () => {
  const dir = makeTempDir();
  try {
    const authPath = join(dir, "auth.json");
    const state = { syncedOpenCodeGoKeyHash: sha256Hex("old-key"), unrelated: 42 };
    let writes = 0;

    const fromEnv = resolveAndSyncOpenCodeGoKey({
      auth: { "opencode-go": { type: "api", key: "ocgo_auth_fallback" } },
      authPath,
      settings: {},
      env: "ocgo_env_fallback",
      state,
      writeState: () => { writes++; },
    });
    assert.deepEqual(fromEnv, { key: "ocgo_env_fallback", source: "env", synced: false });
    assert.equal(state.syncedOpenCodeGoKeyHash, undefined);
    assert.equal(state.unrelated, 42);
    assert.equal(writes, 1);

    const fromAuth = resolveAndSyncOpenCodeGoKey({
      auth: { "opencode-go": { type: "api", key: "ocgo_auth_fallback" } },
      authPath,
      settings: {},
      env: "",
      state,
      writeState: () => { writes++; },
    });
    assert.deepEqual(fromAuth, { key: "ocgo_auth_fallback", source: "auth", synced: false });
    assert.equal(writes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unwritable authPath returns settingsKey with synced: false instead of throwing", () => {
  const dir = makeTempDir();
  try {
    // Non-existent nested directory causes writeFileSync to fail with ENOENT on all OSes
    const unwritableAuthPath = join(dir, "missing-subdir", "auth.json");
    const fakeKey = "ocgo_test_fake_readonly_1234";
    const state = {};
    let writes = 0;

    const res = resolveAndSyncOpenCodeGoKey({
      auth: {},
      authPath: unwritableAuthPath,
      settings: { opencodeGoApiKey: fakeKey },
      env: "",
      state,
      writeState: () => { writes++; },
    });

    assert.equal(res.key, fakeKey);
    assert.equal(res.source, "settings");
    assert.equal(res.synced, false);
    assert.equal(typeof res.syncError, "string");
    assert.ok(res.syncError.length > 0);
    assert.equal(res.syncError.includes(fakeKey), false);
    assert.equal(writes, 0);
    assert.equal(state.syncedOpenCodeGoKeyHash, undefined);

    if (process.platform !== "win32") {
      const roDir = join(dir, "ro");
      chmodSync(dir, 0o555);
      try {
        const resRo = resolveAndSyncOpenCodeGoKey({
          auth: {},
          authPath: join(roDir, "auth.json"),
          settings: { opencodeGoApiKey: fakeKey },
          env: "",
          state,
          writeState: () => { writes++; },
        });
        assert.equal(resRo.key, fakeKey);
        assert.equal(resRo.synced, false);
      } finally {
        chmodSync(dir, 0o755);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
