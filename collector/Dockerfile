FROM node:22-slim

# Platform-aware: @anthropic-ai/claude-code ships native per-arch binaries as
# optional deps; npm installs the right one for the build platform.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*

# Claude CLI: the quota CLI's anthropic probe shells out to `claude auth status`
# for credential discovery — without the binary the Claude card reads
# quota_supported:false even with valid credentials (verified 2026-08-30).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /collector

# Dependencies first (layer cache): opencode-quota CLI + the patched status cap.
COPY package.json package-lock.json ./
RUN npm ci

# Patch the CLI's status live-entry cap from 2 to 12. The google-antigravity
# probe reports one window per configured model (googleModels), and the
# stock cap of 2 silently drops the rest. Upstream cap: quota-status.js
# STATUS_LIVE_ENTRY_LIMIT. This sed fails the build if upstream renames the
# constant (loud, not silent — we'd rather break the build than lose windows).
RUN node -e '\
  const f = "node_modules/@slkiser/opencode-quota/dist/lib/quota-status.js"; \
  const fs = require("fs"); \
  let s = fs.readFileSync(f, "utf8"); \
  const before = "const STATUS_LIVE_ENTRY_LIMIT = 2;"; \
  const after = "const STATUS_LIVE_ENTRY_LIMIT = 12;"; \
  if (!s.includes(before)) { console.error("PATCH GUARD FAILED: upstream cap constant not found in " + f + " — inspect new version before repatching"); process.exit(1); } \
  fs.writeFileSync(f, s.replace(before, after)); \
  console.log("patched STATUS_LIVE_ENTRY_LIMIT 2 -> 12 in " + f);'

COPY *.mjs ./

# Unprivileged runtime user; HOME is the mounted creds root so every
# credential lookup (~/.claude, ~/.config/opencode, ~/.cache/opencode,
# ~/.local/share/opencode) resolves exactly as on the host.
ENV HOME=/creds
ENV AIUD_DATA_DIR=/data
ENV AIUD_SETTINGS_PATH=/data/settings.json

CMD ["node", "runner.mjs"]
