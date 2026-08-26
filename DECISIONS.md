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

## Qwen runs on console session + token-plan key fallback; browser automation retired — Active

Two complementary sources, checked in this order by `collect.mjs`:

1. **Console session** (`alibabaCookie` in khpi5 `data/settings.json`) → real
   percentage windows (5h + weekly) from the token-plan usage API. Kept alive
   automatically by the 2-hourly `keepalive.mjs` cron (plain HTTP: hits the
   console page + loginInfo endpoint, merges Set-Cookie, verifies against the
   real usage API before saving). No browser, no Xvfb, no profile.
2. **Token-plan API key** (auth.json `bailian-token-plan-personal` /
   `alibaba-token-plan`, or Settings tab) → always answers even with no live
   session: "quota available" or 0% + reset time parsed from the 429 body.

If the session eventually dies server-side, the card degrades silently to key
mode — no Telegram message, nothing to restart. Restoring percentages is one
cookie paste in the Settings tab (Copy as cURL from an api.json request),
whenever convenient.

**Retired (2026-08-26):** `alijar.mjs` headless-browser login/refresh/export
cycle and its crons, `refresh-and-export.sh`, `keepalive-and-collect.sh`,
`tg-notify.mjs`, and the daily "Qwen cookie expired" Telegram alert. Reasons,
measured on khpi5: the browser profile's session died 2026-08-25 while the
settings cookie stayed valid (split-brain), `refresh` failed its own
verification seconds before `export` passed it on the same cookies, the CLI
has no alibaba-coding-plan probe, and Alibaba exposes **no key-authenticated
percentage endpoint** (usage/billing/quota candidates all 404). The browser
added only a re-login ability that never worked without human QR entry.
Rollback if ever needed: git history retains the deleted scripts.

## Per-provider auth model — Active

| Card | Probe | Credential | Renewal |
|---|---|---|---|
| Claude (anthropic) | opencode-quota CLI live probe | `~/.claude/.credentials.json` on khpi5 | **automatic**: `claude-token.mjs` refreshes via OAuth refresh_token ≥30 min before expiry (rate-limit/backoff state in `~/.claude/.oauth-refresh.json`); manual re-login only if refresh_token itself expires — SSH tunnel flow in README |
| ChatGPT (openai) | opencode-quota CLI | opencode `auth.json` OAuth entry | auto via opencode; `opencode auth login -p openai` if expired |
| Gemini/Antigravity | opencode-quota CLI | opencode `auth.json` Google OAuth | same pattern |
| Z.ai | direct quota API | `auth.json` API key | n/a (long-lived key) |
| OpenCode Go | direct usage API | `auth.json` API key | n/a |
| Qwen (Alibaba Token Plan) | usage API via console session; token-plan key probe fallback | cookie in `data/settings.json` + `auth.json` key | fully automatic — see the Qwen decision above |

A manual `claude login` / `opencode auth login` is a **fallback**, not part of
normal operation. If the dashboard suggests logging in again, first check
`grep skipped collect.log` and the auth matrix above — the 2026-08-25 incident
showed a healthy credential being reported as a login problem.

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
