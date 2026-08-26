#!/bin/bash
# qwen-browser labwc autostart — supervising launcher.
#
# The stock image autostart calls wrapped-chromium once with all output
# discarded; a single failed launch leaves a desktop with no browser and
# nothing in the logs (observed twice, 2026-08-26). This version keeps a
# supervisor loop: whenever NO chromium process is running, clear stale
# profile singleton locks and start one. A running-but-sick instance is
# left alone so an active remote-desktop login is never interrupted.
(
  sleep 5
  while true; do
    if ! pgrep -f '/usr/lib/chromium/chromium' >/dev/null 2>&1; then
      rm -f /config/chrome-profile/Singleton* /config/chrome-profile/DevToolsActivePort 2>/dev/null
      export XDG_RUNTIME_DIR=/config/.XDG WAYLAND_DISPLAY=wayland-1
      wrapped-chromium \
        --enable-features=UseOzonePlatform \
        --ozone-platform=wayland \
        --remote-debugging-port=9222 \
        --user-data-dir=/config/chrome-profile \
        >>/config/chrome-launch.log 2>&1
      echo "$(date '+%F %T%z') chromium exited ($?) — will relaunch" >>/config/chrome-launch.log
    fi
    sleep 15
  done
) >/dev/null 2>&1 &
