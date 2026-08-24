#!/bin/bash
# /home/dave/stacks/ai-usage-dashboard/collector/keepalive-and-collect.sh
# Keep the Alibaba session alive (plain-HTTP keepalive, every 2h).
# NOTE: collection itself runs from the */10 cron entry — this script no longer
# starts a second collector, which used to race it and double-send Telegram alerts.
set -euo pipefail
cd "$(dirname "$0")"

if ! node keepalive.mjs >> keepalive.log 2>&1; then
  echo "$(date -Iseconds) KEEPALIVE_FAILED" >> keepalive.log
fi
