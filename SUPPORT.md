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
| `QWEN_UI_BIND2` / `QWEN_UI_PORT2` | `127.0.0.1` / `3098` | optional second bind (e.g. tailnet IP + port) |
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

### Qwen live percentages

Percentages come from the Alibaba token-plan usage API, called directly by
the collector with a console token that `bailian-cli` self-refreshes from an
Alibaba Cloud AccessKey:

1. In the Alibaba Cloud RAM console, create an AccessKey (the token-plan is
   personal — the key must be the **main account's**, a RAM user is refused
   with `Team.NotAuthorised`; accepted risk, see DECISIONS.md).
2. On the stack host: `bash collector/qwen-openapi-setup.sh` — it prompts for
   the AccessKey ID/secret, stores them in `data/bailian/config.json`, and
   probes the usage API. Since 2026-09-24 Alibaba answers with a **monthly**
   window (`per1MonthPercentage`/`per1MonthResetTime`); `bl` 2.0.1's own
   `usage token-plan` prints `{}` for that shape, so the setup script probes
   the raw gateway instead.
3. Done — the collector reads percentages every cycle; `bailian-cli`
   self-refreshes its console token from the key. Never expiring, never a
   login.

If the AccessKey source fails, the card falls back to the legacy `qwen-browser`
CDP grab / cookie, then the token-plan API key (availability only, amber
"key mode" chip). The `qwen` profile exists as an off-by-default fallback:
`docker compose --profile qwen up -d` revives the remote desktop at
`https://<host>:3099`.

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
| Qwen card amber `key mode` chip | AccessKey gateway source failed (rejected/expired AccessKey, network) | `docker compose logs collector`, then re-run `collector/qwen-openapi-setup.sh` |
| Qwen percentages still missing 10 min after setup | direct gateway probe failed | check `data/bailian/config.json` exists and look for `bailian gateway:` errors in `docker compose logs collector`. Note: `bl usage token-plan --output json` printing `{}` is **expected** since 2026-09-24 (bl 2.0.1 cannot parse the monthly-window shape; the collector calls the gateway directly) |
| Qwen legacy desktop URL not loading | `QWEN_UI_BIND` loopback-only or stack stopped | legacy fallback only: set LAN IP in `.env`, `docker compose --profile qwen up -d` |
| Collector log shows `CDP HTTP 500` / `Host heade...` | Host-header regression in `cdp-cookies.mjs` (Chromium DevTools validates it; must use `node:http`+`ws`, not fetch) | don't refactor those calls back to fetch |
| `docker compose up` errors about `CREDENTIALS_ROOT` | env var unset | set it in `.env` |
| Collector log shows `HTTP 401` on ingest | `INGEST_KEY` mismatch between server `.env` and collector | same value both sides |
| Gemini card shows only some models | the quota CLI reports one window per model configured in `~/.config/opencode/opencode-quota/quota-toast.json` (`googleModels`) | add/remove model ids there (valid: G3PRO, G3FLASH, CLAUDE, G3IMAGE, GPTOSS) |
| Gemini card errors with "Google meters no allowance for this Antigravity account" | Google answers `free-tier` for the account and publishes no windows — the old card showed a fake 100% on every model instead. If this account *does* hold the AI plan (check the Google subscriptions page), it is a Google entitlement desync, not a bad login | re-adding the account does not help (verified 2026-09-22): escalate via Antigravity Help → Send Feedback / discuss.ai.google.dev; the card heals itself when Google restores the plan. See DECISIONS.md 2026-09-22 |
| Z.ai card `no usable windows` | Z.ai renamed its limit rows (credit plans answer `CREDIT_LIMIT`); the parser maps on `unit` (3 = 5 h, 6 = weekly) so this means a *new* shape | `docker compose exec collector node -e '…'` against `api.z.ai/api/monitor/usage/quota/limit` and extend `zaiLimitWindow()` in `collector/quota-parsers.mjs` (tests: `node --test collector/quota-parsers.test.mjs`) |

### Health checks (host-side)

```bash
curl -s http://127.0.0.1:8099/api/health        # {"ok":true,...}
curl -s http://127.0.0.1:8099/api/quota | head -c 300
docker ps --format '{{.Names}} {{.Status}}'     # all four containers Up
```

### The Qwen browser stack (legacy fallback deep dive)

Retired 2026-09-14 (percentages now come from `bailian-cli` + AccessKey).
Kept for revival only — the watchdog cron is gone, so if you re-enable the
`qwen` profile you also need its self-healing back:

- Inside `qwen-browser`, a supervisor (`data/qwen-browser/.config/labwc/
  autostart`, repo copy `collector/qwen-labwc-autostart.sh`) relaunches
  Chromium whenever it dies and kills wedged instances (CDP dead 60 s).
  Chromium always opens directly on the ModelStudio console — **that tab is
  the session's keepalive**; don't close it.
- The host-side watchdog cron (`*/2` running `collector/qwen-watchdog.sh`)
  was removed 2026-09-14; re-add it if the browser path becomes primary
  again. Prefer `docker compose up -d --force-recreate qwen-browser
  cdp-relay` after manual intervention; plain `docker restart` can wedge
  headful autostart.
- CDP (DevTools) is a remote-control channel for the whole logged-in
  profile — it is published **loopback-only** on the host by design. Never
  rebind it to a LAN interface.

## 6. Data & backups

Everything persistent lives in `./data/` (settings, history, qwen browser
profile). Back up the directory and you can recreate the stack anywhere
(except the host credential files, which are intentionally not part of it).
