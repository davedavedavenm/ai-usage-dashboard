import { createHash } from "crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "fs";

/**
 * Compute lowercase hex SHA-256 digest for comparing keys without storing
 * plaintext secrets in collector state.
 */
export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function readAuthFresh(authPath) {
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Resolve the active OpenCode Go API key and mirror Web UI Settings keys
 * atomically into opencode's auth.json once per key hash so interactive CLI
 * logins still win if run later.
 */
export function resolveAndSyncOpenCodeGoKey({ auth, authPath, settings, env, state, writeState }) {
  const settingsKey = typeof settings?.opencodeGoApiKey === "string"
    ? settings.opencodeGoApiKey.trim()
    : "";
  const envKey = typeof env === "string"
    ? env.trim()
    : (typeof env?.AIUD_OPENCODE_GO_API_KEY === "string" ? env.AIUD_OPENCODE_GO_API_KEY.trim() : "");
  const authEntry = auth?.["opencode-go"];
  const authKey = authEntry?.type === "api" && typeof authEntry.key === "string"
    ? authEntry.key.trim()
    : "";

  if (settingsKey) {
    const hash = sha256Hex(settingsKey);
    if (state?.syncedOpenCodeGoKeyHash !== hash) {
      try {
        const freshAuth = readAuthFresh(authPath);
        freshAuth["opencode-go"] = { type: "api", key: settingsKey };
        const tmp = `${authPath}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(freshAuth, null, 2) + "\n", { mode: 0o600 });
        try {
          chmodSync(tmp, 0o600);
        } catch {}
        renameSync(tmp, authPath);
        if (state && typeof state === "object") {
          state.syncedOpenCodeGoKeyHash = hash;
          if (typeof writeState === "function") writeState(state);
        }
        return { key: settingsKey, source: "settings", synced: true };
      } catch (err) {
        const codeOrMsg = (err && (err.code || err.message)) ? String(err.code || err.message) : "write error";
        const safeErr = codeOrMsg.split(settingsKey).join("[redacted]").slice(0, 120);
        return { key: settingsKey, source: "settings", synced: false, syncError: safeErr };
      }
    }

    if (authKey) {
      return {
        key: authKey,
        source: authKey === settingsKey ? "settings+auth" : "auth",
        synced: false,
      };
    }
    return { key: settingsKey, source: "settings", synced: false };
  }

  if (state?.syncedOpenCodeGoKeyHash) {
    delete state.syncedOpenCodeGoKeyHash;
    if (typeof writeState === "function") writeState(state);
  }

  if (envKey) return { key: envKey, source: "env", synced: false };
  if (authKey) return { key: authKey, source: "auth", synced: false };
  return { key: "", source: "none", synced: false };
}
