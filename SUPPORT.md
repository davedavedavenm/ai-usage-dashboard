# SUPPORT.md — onboarding & troubleshooting

Everything a new user needs to go from `git clone` to a working dashboard,
plus the "my card says X" lookup table for when something degrades.

> **Layout note for maintainers:** in this repository the collector lives in
> `collector/`; on hosts deployed before 2026-08-30 the same files may sit
> under `scripts/` with a host-cron schedule. The compose stack is the
> canonical deployment now. See DECISIONS.md for history.

## 1. What you need

- Docker + Docker Compose v2 on a small always-on host (a Pi is plenty).
- Existing AI-subscription credentials on that host (Claude Code / opencode
  OAuth logins, or API keys in opencode's auth.json). The dashboard *reads*
  them; it never creates accounts.
- (Optional) A Telegram bot for low-allowance alerts.

## 2. First run

```bash
cp .env.example .env
# edit .env:
#   INGEST_KEY       — required; e.g. `openssl rand -hex 32`
#   CREDENTIALS_ROOT  — required for the collector; your home dir on the host,
#                        e.g. /home/dave (the collector mounts ~/.claude,
#                        ~/.config/opencode, ~/.cache/opencode, ~/.local/share/
#                        opencode from there)
docker compose up -d --build
```

- Dashboard: `http://<host>:8099/`
- Collector log (JSON lines): `docker compose logs -f collector`
- A fresh stack shows **"Awaiting first sync"** until the collector has at
  least one usable credential — that is expected, not a crash.

### What each env var does

| Var | Default | Purpose |
|---|---|---|
| `INGEST_KEY` | — | shared secret between collector and server |
| `CREDENTIALS_ROOT` | — | host home dir whose credential subtrees get mounted |
| `DASHBOARD_PORT` | `8099` | published dashboard port |
| `QWEN_UI_BIND` / `QWEN_UI_PORT` | `127.0.0.1` / `3099` | Qwen desktop bind/port (set the bind to your LAN IP to use it remotely) |
| `TZ` | `Europe/London` | container timezone |
| `AIUD_ALERT_*`, Telegram | — | see §4 |

## 3. Connecting accounts (one-time)

Run logins on the host itself (the credentials must live in the host files
the collector mounts):

```bash
ssh your-server
claude login                    # Claude card
opencode auth login -p openai    # ChatGPT card
opencode auth login             # menu → Google (Antigravity) — Gemini card
```

Each login prints a localhost URL; forward that port from your workstation
(`ssh -L <port>:localhost:<port> your-server -N`) and open it in your local
browser. API-key providers (Z.ai, OpenCode Go) are configured by running
`opencode` and logging in with the API-key flow, or by editing
`~/.local/share/opencode/auth.json` (same file opencode itself uses).

Cards appear on the next 10-minute collector cycle. **OAuth tokens are
auto-refreshed by the collector before every probe** — re-login is only
needed if a refresh token itself is revoked (rare; the card's hint text
will say so).

### Qwen live percentages (optional)

1. `docker compose --profile qwen up -d`
2. Open `https://<host>:3099` (accept the self-signed cert), log in with
   `QWEN_UI_USER`/`QWEN_UI_PASSWORD`.
3. In the desktop's Chromium (already open on the ModelStudio console),
   log into `modelstudio.console.alibabacloud.com` once.
4. Done — the collector grabs the session cookies over CDP every cycle and
   the open console tab keeps the session alive. If you skip this, the Qwen
   card still works via the token-plan API key (availability only, amber
   "key mode" chip).

## 4. Telegram alerts

Create a bot with @BotFather, send it `/start`, then use the dashboard →
**Settings** tab → *Send test message* (it discovers your chat id), or set
`AIUD_TG_BOT_TOKEN`/`AIUD_TG_CHAT_ID` in `.env`.

Alerts are **staged**: 🟡 50% → 🟠 30% → 🔴 threshold (default 15%) → 🚨 0%,
one message per stage per provider window per reset period — you're warned
early, never bombarded. Allowance thresholds are the only alert source.

## 5. Troubleshooting

**First reflex, always:** `docker compose logs collector | tail -20` — every
run logs a JSON line with per-provider status and a `skipped` object naming
anything that did not report. A missing card means it was skipped, not lost.

| Symptom | Meaning | Fix |
|---|---|---|
| "Awaiting first sync" | no usable credential at all | §3 logins |
| Card says `not connected` + hint text | provider skipped: no credential | do that provider's login |
| Claude card dead, hint says re-login | **check the log first** — the classic false alarm is the quota CLI not finding `claude`; the collector image ships it, so if you run the collector outside Docker make sure `claude` is on PATH | log line `skipped.anthropic` tells the truth |
| Qwen card amber `key mode` chip | console session in `qwen-browser` expired | re-login at `https://<host>:3099` (§3) |
| Qwen percentages still missing 10 min after login | grab failed to verify | `curl http://127.0.0.1:9333/json/version` on the host (CDP up?) then check `data/qwen-browser/chrome-launch.log` |
| `docker compose up` errors about `CREDENTIALS_ROOT` | env var unset | set it in `.env` |
| Collector log shows `HTTP 401` on ingest | `INGEST_KEY` mismatch between server `.env` and collector | same value both sides |
| Gemini card shows only some models | the quota CLI reports one window per model configured in `~/.config/opencode/opencode-quota/quota-toast.json` (`googleModels`) | add/remove model ids there (valid: G3PRO, G3FLASH, CLAUDE, G3IMAGE, GPTOSS) |

### Health checks (host-side)

```bash
curl -s http://127.0.0.1:8099/api/health        # {"ok":true,...}
curl -s http://127.0.0.1:8099/api/quota | head -c 300
docker ps --format '{{.Names}} {{.Status}}'     # all four containers Up
```

### The Qwen browser stack (deep dive)

- Inside `qwen-browser`, a supervisor (`data/qwen-browser/.config/labwc/
  autostart`, repo copy `collector/qwen-labwc-autostart.sh`) relaunches
  Chromium whenever it dies and kills wedged instances (CDP dead 60 s).
  Chromium always opens directly on the ModelStudio console — **that tab is
  the session's keepalive**; don't close it.
- A host-side watchdog (`*/2` cron running `collector/qwen-watchdog.sh`)
  force-recreates the containers if CDP on :9333 stays dead. Prefer
  `docker compose up -d --force-recreate qwen-browser cdp-relay` after manual
  intervention; plain `docker restart` can wedge headful autostart.
- CDP (DevTools) is a remote-control channel for the whole logged-in
  profile — it is published **loopback-only** on the host by design. Never
  rebind it to a LAN interface.

## 6. Data & backups

Everything persistent lives in `./data/` (settings, history, qwen browser
profile). Back up the directory and you can recreate the stack anywhere
(except the host credential files, which are intentionally not part of it).
