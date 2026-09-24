#!/bin/bash
# qwen-openapi-setup.sh — one-time setup for the AccessKey-backed Qwen usage
# source. Stores the AccessKey + generated CLI access token in the stack data
# dir (data/bailian/config.json, gitignored, same handling as settings.json).
# Run interactively on khpi5:
#
#   ssh -t khpi5 'bash /home/dave/stacks/ai-usage-dashboard/collector/qwen-openapi-setup.sh'
#
# Why: the collector calls the personal token-plan usage API directly; this
# script stores the AK/SK that `bailian-cli` uses to mint and self-refresh the
# console Bearer token (GenerateCLIAccessToken) that authenticates those calls.
# AccessKeys don't expire — no browser session, no periodic manual login.
# (Since 2026-09-24 the API answers with a monthly window that bl 2.0.1 does
# not parse — `bl usage token-plan` printing `{}` is normal; bl's only
# remaining job is the token refresh. See DECISIONS.md 2026-09-24.)
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
    echo "--- Token Plan usage probe (direct gateway):"
    node -e "
      const fs = require(\"fs\");
      const cfg = JSON.parse(fs.readFileSync(\"/cfg/config.json\", \"utf8\"));
      const api = \"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage\";
      const url = \"https://bailian-singapore-cs.alibabacloud.com/cli/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=\" + encodeURIComponent(api);
      const body = new URLSearchParams({ params: JSON.stringify({ Api: api, V: \"1.0\", Data: { cornerstoneParam: { protocol: \"V2\", console: \"ONE_CONSOLE\", productCode: \"p_efm\", switchUserType: 3, consoleSite: \"BAILIAN_ALIYUN\" } } }), region: \"ap-southeast-1\" });
      fetch(url, { method: \"POST\", headers: { Accept: \"*/*\", \"Content-Type\": \"application/x-www-form-urlencoded\", Authorization: \"Bearer \" + cfg.access_token }, body })
        .then(r => r.json())
        .then(j => { const d = j && j.data && j.data.DataV2 && j.data.DataV2.data && j.data.DataV2.data.data; console.log(JSON.stringify(d || j, null, 2)); if (!d) process.exit(1); })
        .catch(e => { console.error(\"probe failed:\", e.message); process.exit(1); });
    "
  '

echo
echo "If the probe printed usage-window fields (per1MonthPercentage/per1MonthResetTime"
echo "today), the path works. Note: 'bl usage token-plan --output json' printing {} is"
echo "EXPECTED with bl 2.0.1 — it cannot parse the monthly-window shape; the collector"
echo "calls the gateway directly."