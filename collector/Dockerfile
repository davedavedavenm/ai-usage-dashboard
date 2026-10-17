FROM node:22-slim

# Platform-aware: @anthropic-ai/claude-code ships native per-arch binaries as
# optional deps; npm installs the right one for the build platform.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*

# Claude CLI: the quota CLI's anthropic probe shells out to `claude auth status`
# for credential discovery — without the binary the Claude card reads
# quota_supported:false even with valid credentials (verified 2026-08-30).
RUN npm install -g @anthropic-ai/claude-code

# bailian-cli: token-plan usage API (Qwen percentages) on the main-account
# AccessKey stored at /data/bailian (BAILIAN_CONFIG_DIR). --ignore-scripts
# skips the skill installer — not needed here.
RUN npm install -g bailian-cli --ignore-scripts

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
  const fs = require("fs"); \
  const f = "node_modules/@slkiser/opencode-quota/dist/lib/quota-status.js"; \
  let s = fs.readFileSync(f, "utf8"); \
  const before = "const STATUS_LIVE_ENTRY_LIMIT = 2;"; \
  const after = "const STATUS_LIVE_ENTRY_LIMIT = 12;"; \
  if (!s.includes(before)) { console.error("PATCH GUARD FAILED: upstream cap constant not found in " + f + " — inspect new version before repatching"); process.exit(1); } \
  fs.writeFileSync(f, s.replace(before, after)); \
  console.log("patched STATUS_LIVE_ENTRY_LIMIT 2 -> 12 in " + f); \
  const tf = "node_modules/@slkiser/opencode-quota/dist/lib/types.js"; \
  let ts = fs.readFileSync(tf, "utf8"); \
  const flashBefore = "altKey: \"gemini-3-flash-medium|gemini-3-flash-high|gemini-3-flash-low|gemini-3-5-flash-medium|gemini-3-5-flash-high|gemini-3-5-flash-low|gemini-3.5-flash-medium|gemini-3.5-flash-high|gemini-3.5-flash-low\","; \
  const flashAfter = "altKey: \"gemini-3.8-flash-tiered|gemini-3.6-flash-high|gemini-3.6-flash-medium|gemini-3.6-flash-low|gemini-3-flash-medium|gemini-3-flash-high|gemini-3-flash-low|gemini-3-5-flash-medium|gemini-3-5-flash-high|gemini-3-5-flash-low|gemini-3.5-flash-medium|gemini-3.5-flash-high|gemini-3.5-flash-low\","; \
  const claudeBefore = "altKey: \"claude-opus-4-5-thinking|claude-opus-4-5|claude-sonnet-4-6|claude-sonnet-4-6-thinking|claude-opus-4-6|gemini-claude-sonnet-4-6|gemini-claude-opus-4-6-thinking\","; \
  const claudeAfter = "altKey: \"claude-opus-5-5-high|claude-opus-5-5-medium|claude-opus-5-5-low|claude-sonnet-5-5-high|claude-sonnet-5-5-medium|claude-sonnet-5-5-low|claude-opus-4-5-thinking|claude-opus-4-5|claude-sonnet-4-6|claude-sonnet-4-6-thinking|claude-opus-4-6|gemini-claude-sonnet-4-6|gemini-claude-opus-4-6-thinking\","; \
  const imgBefore = "G3IMAGE: { key: \"gemini-3-pro-image\", display: \"G3Image\" },"; \
  const imgAfter = "G3IMAGE: { key: \"gemini-3.1-flash-image\", altKey: \"gemini-3-pro-image|gemini-3.1-flash-image-preview\", display: \"G3Image\" },"; \
  if (!ts.includes(flashBefore) || !ts.includes(claudeBefore) || !ts.includes(imgBefore)) { console.error("PATCH GUARD FAILED: GOOGLE_MODEL_KEYS shape changed in " + tf); process.exit(1); } \
  ts = ts.replace(flashBefore, flashAfter).replace(claudeBefore, claudeAfter).replace(imgBefore, imgAfter); \
  fs.writeFileSync(tf, ts); \
  console.log("patched GOOGLE_MODEL_KEYS (Claude 5.5 + G3Image 3.1 + G3Flash 3.6/3.8) in " + tf); \
  const af = "node_modules/@slkiser/opencode-quota/dist/lib/anthropic.js"; \
  let as = fs.readFileSync(af, "utf8"); \
  const toBefore = "const CLAUDE_COMMAND_TIMEOUT_MS = 3_000;"; \
  const toAfter = "const CLAUDE_COMMAND_TIMEOUT_MS = 15_000;"; \
  if (!as.includes(toBefore)) { console.error("PATCH GUARD FAILED: CLAUDE_COMMAND_TIMEOUT_MS not found in " + af); process.exit(1); } \
  fs.writeFileSync(af, as.replace(toBefore, toAfter)); \
  console.log("patched CLAUDE_COMMAND_TIMEOUT_MS 3000 -> 15000 in " + af);'

COPY *.mjs ./

# Unprivileged runtime user; HOME is the mounted creds root so every
# credential lookup (~/.claude, ~/.config/opencode, ~/.cache/opencode,
# ~/.local/share/opencode) resolves exactly as on the host.
ENV HOME=/creds
ENV AIUD_DATA_DIR=/data
ENV AIUD_SETTINGS_PATH=/data/settings.json

CMD ["node", "runner.mjs"]
