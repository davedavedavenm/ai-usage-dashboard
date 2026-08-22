#!/bin/bash
# /home/dave/stacks/ai-usage-dashboard/collector/keepalive-and-collect.sh
# Keep Alibaba session alive + run collector
set -euo pipefail
cd /home/dave/stacks/ai-usage-dashboard/collector

# Keep session alive
if ! node keepalive.mjs >> keepalive.log 2>&1; then
  echo "$(date -Iseconds) KEEPALIVE_FAILED" >> keepalive.log
fi

# Run collector
node collect.mjs >> collect.log 2>&1
