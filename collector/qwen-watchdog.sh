#!/bin/bash
# qwen-watchdog.sh — auto-heal for the qwen-browser stack.
#
# Chromium's headful autostart intermittently wedges when its container is
# recreated (desktop comes up, zero chromium processes, nothing in logs;
# observed twice on 2026-08-26). When that happens the Qwen card loses its
# live-session source until something recreates the container. This watchdog
# polls the CDP relay endpoint (which only answers when chromium is actually
# listening) and force-recreates both containers after two consecutive
# failures spaced 75s apart — sparing any login window Dave currently has
# open unless it is really dead.
cd /home/dave/stacks/ai-usage-dashboard || exit 0

if timeout 6 curl -sf http://127.0.0.1:9333/json/version >/dev/null 2>&1; then
  exit 0
fi
sleep 75
if timeout 6 curl -sf http://127.0.0.1:9333/json/version >/dev/null 2>&1; then
  exit 0
fi
echo "$(date '+%F %T%z') CDP dead on :9333 — force-recreating qwen-browser"
docker compose up -d --force-recreate qwen-browser cdp-relay >/dev/null 2>&1
