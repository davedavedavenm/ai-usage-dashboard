#!/bin/bash
# /home/dave/stacks/ai-usage-dashboard/collector/refresh-and-export.sh
# Called by cron to refresh the Alibaba session and export cookies to settings.json
set -euo pipefail
cd "$(dirname "$0")"
export DISPLAY=:99

NOTIFY_MARKER=/tmp/aiud-alijar-fail-notified

notify_once_per_day() {
  local now last
  now=$(date +%s)
  last=$(cat "$NOTIFY_MARKER" 2>/dev/null || echo 0)
  if [ $((now - last)) -gt 86400 ]; then
    node tg-notify.mjs "$1" >> alijar.log 2>&1 || true
    echo "$now" > "$NOTIFY_MARKER"
  fi
}

# Refresh the session (verifies against the real usage API; exits 2 if dead)
if ! node alijar.mjs refresh >> alijar.log 2>&1; then
  echo "$(date -Iseconds) REFRESH_FAILED" >> alijar.log
  notify_once_per_day "⚠️ Alibaba session expired — re-login needed:
ssh khpi5 \"cd /home/dave/stacks/ai-usage-dashboard/collector && DISPLAY=:99 node alijar.mjs login\""
  exit 1
fi

# Export refreshed cookies to settings.json (verified before saving)
if ! node alijar.mjs export >> alijar.log 2>&1; then
  echo "$(date -Iseconds) EXPORT_FAILED" >> alijar.log
  notify_once_per_day "⚠️ Alibaba session expired — re-login needed:
ssh khpi5 \"cd /home/dave/stacks/ai-usage-dashboard/collector && DISPLAY=:99 node alijar.mjs login\""
  exit 1
fi

rm -f "$NOTIFY_MARKER"
echo "$(date -Iseconds) REFRESH_OK" >> alijar.log
