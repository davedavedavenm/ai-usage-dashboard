#!/bin/bash
# qwen-browser labwc autostart — supervising launcher.
#
# Two self-healing layers, both inside this container (the */2 host watchdog
# cron remains only as a backstop for kasmvnc-level death):
#   1. relaunch loop: whenever NO chromium process is running, clear stale
#      profile singleton locks and start one (the stock image autostart
#      discards all output; one flaky launch used to leave a dead desktop
#      with nothing in any log — observed twice 2026-08-26).
#   2. wedge-kill loop (parallel, 15 s cadence): chromium running but CDP not
#      answering 4 checks in a row (60 s), past the ~90 s cold-start grace,
#      means a zombie browser — kill it; the relaunch layer starts a fresh
#      one. Never fires during healthy cold start (~20 s to open :9222) or
#      transient CDP blips. A healthy instance is never touched mid-login.
#
# Chromium launches directly onto the Bailian console URL: the open SPA tab
# keeps the Alibaba session alive server-side (root cause of the 2026-08-28
# silent expiry: after a relaunch the browser sat on a blank tab for ~34 h
# with nothing touching alibabacloud.com).
CONSOLE_URL="https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan/personal"

launch_chromium() {
  rm -f /config/chrome-profile/Singleton* /config/chrome-profile/DevToolsActivePort 2>/dev/null
  export XDG_RUNTIME_DIR=/config/.XDG WAYLAND_DISPLAY=wayland-1
  wrapped-chromium \
    --enable-features=UseOzonePlatform \
    --ozone-platform=wayland \
    --remote-debugging-port=9222 \
    --user-data-dir=/config/chrome-profile \
    "$CONSOLE_URL" \
    >>/config/chrome-launch.log 2>&1
  echo "$(date '+%F %T%z') chromium exited ($?) — will relaunch" >>/config/chrome-launch.log
}

(
  sleep 5
  while true; do
    if ! pgrep -f '/usr/lib/chromium/chromium' >/dev/null 2>&1; then
      launch_chromium
    fi
    sleep 15
  done
) >/dev/null 2>&1 &

(
  sleep 20
  fail=0
  while true; do
    if pgrep -f '/usr/lib/chromium/chromium' >/dev/null 2>&1; then
      if ! timeout 6 curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
        fail=$((fail + 1))
        if [ "${fail:-0}" -ge 4 ]; then
          echo "$(date '+%F %T%z') CDP dead ${fail} checks — killing wedged chromium" >>/config/chrome-launch.log
          pkill -f '/usr/lib/chromium/chromium' 2>/dev/null
          fail=0
          sleep 5
        fi
      else
        fail=0
      fi
    else
      fail=0
    fi
    sleep 15
  done
) >/dev/null 2>&1 &
