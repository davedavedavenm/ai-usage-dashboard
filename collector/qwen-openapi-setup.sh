#!/bin/bash
# qwen-openapi-setup.sh — one-time setup for the AccessKey-backed Qwen usage
# source. Stores the AccessKey + generated CLI access token in the stack data
# dir (data/bailian/config.json, gitignored, same handling as settings.json).
# Run interactively on khpi5:
#
#   ssh -t khpi5 'bash /home/dave/stacks/ai-usage-dashboard/collector/qwen-openapi-setup.sh'
#
# Why: bailian-cli's `usage token-plan` calls the same usage API the dashboard
# uses, but authenticates via a Bearer token it can self-refresh from the
# AK/SK (GenerateCLIAccessToken). AccessKeys don't expire — no browser
# session, no periodic manual login.
#
# The token-plan is a PERSONAL plan: only the MAIN ACCOUNT identity can read
# it (a RAM user authenticates fine but is refused with
# BailianGateway.Team.NotAuthorised — verified 2026-09-14). Hence the main
# (root) AccessKey, accepted risk, recorded in DECISIONS.md.
#
# `bl config set` does not accept console_site/console_region, so the config
# file is patched directly after login: console_site=international,
# console_region=ap-southeast-1 (same gateway the cookie source used),
# base_url=intl (drives the OpenAPI host for token refreshes), telemetry off.
set -euo pipefail
cd /home/dave/stacks/ai-usage-dashboard
mkdir -p data/bailian

read -r -p "AccessKey ID (LTAI...): " BL_AK_ID
read -r -s -p "AccessKey Secret: " BL_AK_SECRET; echo

if [[ -z "${BL_AK_ID}" || -z "${BL_AK_SECRET}" ]]; then
  echo "Aborted: both values are required." >&2
  exit 1
fi

# docker run -e VAR only forwards exported variables.
export BL_AK_ID BL_AK_SECRET

docker run --rm -it \
  -e HOME=/tmp/blhome \
  -e BAILIAN_CONFIG_DIR=/cfg \
  -e DO_NOT_TRACK=1 \
  -e BL_AK_ID -e BL_AK_SECRET \
  -v "$PWD/data/bailian:/cfg" \
  node:22-slim sh -c '
    set -e
    mkdir -p "$HOME"
    npm i -g bailian-cli >/dev/null 2>&1
    bl auth login --open-api --access-key-id "$BL_AK_ID" --access-key-secret "$BL_AK_SECRET"
    node -e "
      const fs = require(\"fs\");
      const f = \"/cfg/config.json\";
      const c = JSON.parse(fs.readFileSync(f, \"utf8\"));
      c.console_site = \"international\";
      c.console_region = \"ap-southeast-1\";
      c.base_url = \"https://dashscope-intl.aliyuncs.com\";
      c.telemetry = false;
      fs.writeFileSync(f, JSON.stringify(c, null, 2) + \"\n\");
      console.log(\"config patched for the international console\");
    "
    echo "--- Token Plan usage probe:"
    bl usage token-plan --output json
  '

echo
echo "If the probe printed per5Hour/per1Week fields, the path works."