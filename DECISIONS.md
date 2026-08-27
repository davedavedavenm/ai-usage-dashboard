# Decisions — ai-usage-dashboard

Settled, closed questions for this repo. Not a changelog — this file holds the
current position on each question and why. **Check here before proposing to
change, redo, or re-open something.**

Status values: **Active** · **Superseded** · **Historical**.

Cross-repo rule: anything spanning repos (SSH aliases, MCP tooling, alert
routing policy) is decided once in `infra/DECISIONS.md`; this file holds a
pointer, not a restatement.

---

## khpi5 is the deployment target; repo is source of truth; deploy = scp — Active

The stack runs on **khpi5** at `/home/dave/stacks/ai-usage-dashboard`
(server: Docker container, port 8099; collector: plain node + cron). The target
is **not** a git checkout. The workflow is always:

edit in this repo → normalize line endings to LF → `scp` changed files →
`syntax-check remotely → trigger one collect → verify`.

Never patch the host copy live and leave the repo behind; that is how the
truncated-comment drift in `alijar.mjs` / `keepalive-and-collect.sh` (found
2026-08-25) happened.

Path mapping (verified byte-aligned 2026-08-25):

| This repo | khpi5 |
|---|---|
| `server.js`, `Dockerfile`, `docker-compose.yml`, `public/` | `/home/dave/stacks/ai-usage-dashboard/<same>` |
| `scripts/*.mjs`, `scripts/*.sh` | `/home/dave/stacks/ai-usage-dashboard/collector/<same>` |

Secrets (`data/settings.json`, `.env`) exist **only** on khpi5.

**Why:** the 2026-08-25 outage showed what happens otherwise — fixes were
promised repeatedly but never landed end-to-end, and nobody could tell which
copy was real.

## The quota CLI is always spawned with an augmented PATH — Active

Cron's default PATH is `/usr/bin:/bin`. The `claude` binary (needed by the
pinned `@slkiser/opencode-quota` CLI to authenticate Anthropic quota probing)
lives at `/home/dave/.local/bin/claude` — invisible under cron. Result: the
CLI reported `cli_installed: false`, returned no usage entries, and
`collect.mjs` silently skipped the provider, so the Claude card sat dead for
days while the UI hint said "refresh Anthropic login". `runStatusCli()` now
spawns every CLI call with
`PATH=<homedir>/.local/bin:/usr/local/bin:<inherited PATH>` regardless of who
invoked it (cron, SSH, manual).

Do not "fix" this by editing the crontab PATH instead — code-level env makes
the collector invocation-context-proof (cron, systemd timer, manual run all
behave identically).

**Why:** incident 2026-08-25; reproduced deterministically
(`env -i` probe → `auth_status: unknown` in <1 s vs success with augmented
PATH), fixed, verified via `/api/quota`.

## A provider that fails to probe must never disappear silently — Active

When a STATUS_PROVIDERS probe yields no CLI error, no section, or no usable
entries, it is now recorded in the collect.log line under `"skipped"` with the
reason (and `AIUD_DEBUG_DUMP=1` dumps raw CLI output to `/tmp/aiud-cli-<id>.out`
plus a child-env check `.envdbg`). Before this, a failing provider just vanished
from the ingest and from every log line — unfixable blind.

The envelope/dashboard deliberately still omit skipped providers (cards keep
last-known state rather than flapping red); the truth lives in `collect.log`.
If a card is stale, the first reflex is `grep skipped collect.log`.

**Why:** the same 2026-08-25 incident was invisible for ~44 h because three
different code paths did `continue` without a trace.

## `reset_at` is optional when parsing CLI status output — Active

`opencode-quota` emits windows like
`live_entry_1: 5h: percent_remaining=100` with no `reset_at=` (or literal
`(none)`). The parser previously required a reset timestamp, dropping the
entire 5-hour window even on successful probes. Parser now treats reset_at as
optional and ignores `(none)`.

## Qwen runs on a dedicated remote-desktop browser profile; collector auto-grabs via CDP — Active

The Bailian console session (real percentage windows) lives in a persistent
Chromium profile inside the **`qwen-browser`** container (see
`docker-compose.yml`): headful Chromium + web desktop, password-protected
(`QWEN_UI_USER`/`QWEN_UI_PASSWORD` in khpi5 stack `.env`, never in the repo)
and published on the LAN (`https://192.168.1.143:3099`) plus tailnet
(`https://100.65.57.85:3099`). The mapping targets the image's HTTPS listener
(container :3001; self-signed cert lives in `data/qwen-browser/ssl/`, so
accept the browser warning) because Selkies' UI refuses plain-HTTP origins.
Login/re-login flow (~1 min):

```
# from any LAN device:  https://192.168.1.143:3099   (or via tailnet https://100.65.57.85:3099)
# accept self-signed cert, then sign into modelstudio.console.alibabacloud.com
```

CDP stays **loopback-only** on khpi5 (host :9333 → relay → Chromium's own
loopback :9222) — DevTools is a remote-control channel for the whole logged-in
profile and must never face a network.

From then on everything is automatic, per collect:

1. `cdp-cookies.mjs` pulls the alibaba/aliyun cookie jar out of the live
   browser over CDP (`Storage.getCookies`). Chromium 111+ hard-binds DevTools
   to its own loopback (`--remote-debugging-address` is ignored), so a socat
   sidecar sharing the container's network namespace relays host :9333 →
   container loopback :9222.
2. The grab is verified against the real usage API (`verifyAliCookie`) before
   use — an unverified grab is discarded silently.
3. Verified grabs are written back into `data/settings.json`, so the 2-hourly
   `keepalive.mjs` always works on the same jar as the browser. The live
   profile is the single source of truth; no split-brain.

If the session dies server-side, the card degrades to key mode ("quota
available") until the next remote login; percentages reappear within one
collect cycle (≤10 min). No alerts about it (see Telegram decision below).

**Resilience layers (both live on khpi5):**
- *Inside* the container, `/config/.config/labwc/autostart`
  (repo copy: `scripts/qwen-labwc-autostart.sh`) is a supervising loop that
  relaunches Chromium whenever no chromium process is running and cleans stale
  profile singleton locks first. This exists because the stock image autostart
  called `wrapped-chromium` once with all output discarded (`> /dev/null`),
  so one flaky launch left a dead desktop — no processes, no logs
  (observed twice on 2026-08-26). Recreate-proof (volume persists) and it
  never touches a running instance mid-login.
- *Outside*, the */2 cron `qwen-watchdog.sh` backstop force-recreates both
  containers when CDP on :9333 fails twice, 75 s apart. With the supervisor
  this rarely fires; keep it for kasmvnc-level death.

Ops note: after manual intervention prefer recreate over restart
(`docker compose up -d qwen-browser cdp-relay`); plain `docker restart` can
wedge headful autostart. Chromium launch diagnostics land in
`data/qwen-browser/chrome-launch.log`.

**Superseded history:** before this, cookies were hand-pasted into Settings
when they expired. Before *that*, `alijar.mjs` tried unattended browser
login/refresh/export and was retired 2026-08-26 — unattended login hit the QR
wall, refresh failed its own verification seconds after export passed it on
the same cookies, and the profile/settings split-brain killed sessions
silently. Today's design deliberately keeps a real browser but makes the human
step remote-desktop-simple instead of unattended, and kills split-brain by
reading only from that single live profile. `alijar.mjs`,
`refresh-ali-cookie.mjs`, `refresh-and-export.sh`, `keepalive-and-collect.sh`
and `tg-notify.mjs` remain deleted; git history retains them.

## Per-provider auth model — Active

| Card | Probe | Credential | Renewal |
|---|---|---|---|
| Claude (anthropic) | opencode-quota CLI live probe | `~/.claude/.credentials.json` on khpi5 | **automatic**: `claude-token.mjs` refreshes via OAuth refresh_token ≥30 min before expiry (rate-limit/backoff state in `~/.claude/.oauth-refresh.json`); manual re-login only if refresh_token itself expires — SSH tunnel flow in README |
| ChatGPT (openai) | opencode-quota CLI | opencode `auth.json` OAuth entry | **automatic**: `chatgpt-token.mjs` refreshes via OAuth refresh_token ≥30 min before expiry (rotation written back, backoff state in `~/.local/share/opencode/.openai-oauth-refresh.json`); manual re-login only if the refresh token itself is revoked — `opencode auth login -p openai` |
| Gemini/Antigravity | opencode-quota CLI | opencode `auth.json` Google OAuth | same pattern |
| Z.ai | direct quota API | `auth.json` API key | n/a (long-lived key) |
| OpenCode Go | direct usage API | `auth.json` API key | n/a |
| Qwen (Alibaba Token Plan) | usage API via live browser profile (CDP grab, verified); token-plan key probe fallback | logged-in session in `qwen-browser` container (mirrored to `data/settings.json`) + `auth.json` key | automatic except periodic remote login — see the Qwen decision above |

A manual `claude login` / `opencode auth login` is a **fallback**, not part of
normal operation. If the dashboard suggests logging in again, first check
`grep skipped collect.log` and the auth matrix above — the 2026-08-25 incident
showed a healthy credential being reported as a login problem.

**ChatGPT does not self-refresh on a headless box — Historical gotcha.**
opencode refreshes its openai OAuth token lazily, only while being used
interactively. The collector probes via the external `opencode-quota` CLI,
which reads `auth.json` directly and never triggers a refresh, so the token
aged out (2026-08-26: issued Aug 16 18:23 UTC, expired Aug 26 18:23 UTC, card
died) despite DECISIONS.md previously claiming "auto via opencode". Fixed by
mirroring the Claude pattern in `chatgpt-token.mjs`, called from `collect.mjs`
before every openai probe. Refresh params verified against opencode source
(`packages/opencode/src/plugin/codex.ts`: token endpoint
`https://auth.openai.com/oauth/token`, public client_id, form-urlencoded
refresh grant; refresh tokens rotate on every grant and are written back to
`auth.json`). Do not probe ChatGPT quota through opencode itself as a
"fix" for expiry — it needs interactive usage we don't have here.

## Telegram bot ("AI Usage Manager") — Active

Alerting runs through the existing @BotFather bot configured on khpi5. Wiring,
by design:

- Bot token + chat id live **only** in khpi5 `data/settings.json` (`telegram`
  object); settable/masked via the Settings tab; never in this repo, never in
  docs. Env fallbacks `AIUD_TG_BOT_TOKEN`/`AIUD_TG_CHAT_ID` exist for testing.
- Alerts are **staged** per provider-window: 🟡 50% → 🟠 30% → 🔴 threshold
  (default 15%) → 🚨 0%, deduped in `collector/state.json` keyed by window +
  reset time, so each stage fires once per reset period. Allowance thresholds
  are the ONLY alert source — there are deliberately no cookie/session
  "action needed" notifications (retired 2026-08-26).
- Test channel: Settings tab → *Send test message* (POST `/api/telegram-test`).

Do not create a second bot or hardcode chat ids anywhere.

## Windows workstation needs nothing installed — Active

Every operational task (deploy, diagnose, verify) works over
`ssh -o BatchMode=yes khpi5 "<command>"` from Windows. Multi-command remote
work goes through a local script file pushed with `scp` and run with
`bash /tmp/script.sh` — never inline compound quotes through PowerShell
(PowerShell mangles nested quoting; see infra DECISIONS.md "Multi-command
remote work always goes through `bash -s`"). No WSL, no node, no clone
required locally beyond this checkout.

## Cron inventory (khpi5, Europe/London) — Active

```
*/10 * * * *  cd stacks/ai-usage-dashboard/collector && flock -n /tmp/aiud-collect.lock node collect.mjs >> collect.log 2>&1
0 */2 * * *   cd stacks/ai-usage-dashboard/collector && flock -n /tmp/aiud-keepalive.lock node keepalive.mjs >> keepalive.log 2>&1
*/2 * * * *   cd stacks/ai-usage-dashboard && flock -n /tmp/aiud-qwen-watch.lock bash collector/qwen-watchdog.sh >> data/qwen-watchdog.log 2>&1
```

Gotchas: cron fires in **local** time (BST = UTC+1) while collect.log
timestamps are UTC — an apparent mismatch of one hour between "when cron ran"
and log lines is expected. `flock -n` means overlapping runs are skipped, not
queued; don't add other collectors that take different locks.

## keepalive-and-collect.sh no longer exists — Historical

It once started a second collector every 2 h, racing the */10 entry and
double-sending Telegram alerts; later it was reduced to only running
`keepalive.mjs`. With the browser-retirement decision the wrapper and its
cron line were replaced by a direct `keepalive.mjs` entry (2026-08-26).

---

Related: `README.md` (architecture, API, login flows) · infra repo
`docs/protocols/ai-agent-reference.md` (SSH aliases) · infra
`DECISIONS.md` (cross-repo rules: bash -s rule, alert tiers, repo ownership).
