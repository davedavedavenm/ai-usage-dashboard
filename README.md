# AI Usage Allowance Dashboard

A self-contained Docker Compose stack showing how much allowance is left on
each AI subscription — Claude, ChatGPT, Z.ai, OpenCode Go, Gemini/Antigravity,
Qwen — with Telegram alerts when any window runs low and rollover warnings
24h and 12h before billing reset.

Everything runs in containers: the server is a single zero-dependency Node
file, the collector probes the providers' quota APIs every 10 minutes and
pushes results via a key-protected ingest endpoint. Qwen percentages come
from the official `bailian-cli` with an Alibaba Cloud AccessKey (see *Qwen*
below); the legacy `qwen-browser` remote-desktop profile remains in the repo
as an optional fallback. No host cron, no workstation dependencies.

```
provider quota APIs (Z.ai, opencode.ai, Anthropic/OpenAI OAuth, Google AI, Alibaba ...)
        │
collector container ── runner.mjs (every 10 min) ──> POST /api/ingest (X-Ingest-Key)
        │                 └── bailian-cli → Alibaba token-plan usage API
        ▼
server container ── GET / dashboard
```

## Quick start

```bash
git clone <this-repo> && cd ai-usage-dashboard
cp .env.example .env        # set INGEST_KEY (random string) — see SUPPORT.md
docker compose up -d --build
```

Open `http://<host>:8099/` — the dashboard shows "Awaiting first sync" until
the collector has credentials to report (see *Connecting accounts* below).

Optional profiles:

```bash
docker compose --profile qwen up -d        # legacy Qwen browser fallback (normally off)
docker compose logs -f collector           # JSON collector log lines
```

The collector service starts with the default profile and needs host
credentials mounted (`CREDENTIALS_ROOT` in `.env`) — see SUPPORT.md if you
are starting from a fresh machine.

## Connecting accounts

The collector reads the same credential files the interactive CLIs use on
the host (`~/.claude/.credentials.json`, `~/.local/share/opencode/auth.json`,
`~/.config/opencode/antigravity-accounts.json`), mounted into the container
at the same paths under `/creds`. One-time setup per provider, then the
collector auto-refreshes OAuth tokens before every probe.

OAuth logins run on the server and the provider's redirect lands on a
`localhost` port there, so your browser needs an SSH tunnel:

```bash
# Terminal 1 — start the login on the server:
ssh your-server
opencode auth login -p openai          # ChatGPT
# opencode auth login                  # any provider menu (Google → Antigravity, ...)
# claude login                         # Anthropic / Claude Code

# it prints a URL like http://localhost:1450/... and waits.

# Terminal 2 (local) — forward that port back to the server:
ssh -L 1450:localhost:1450 your-server -N   # use the port from the printed URL

# Open the printed URL in your browser → callback tunnels back → login completes.
```

The collector picks new credentials up on its next 10-minute run.

### Qwen (Alibaba Token Plan)

Percentages come from the official `bailian-cli` (`bl usage token-plan`),
authenticated with an Alibaba Cloud AccessKey stored in
`data/bailian/config.json` (gitignored, same handling as `settings.json`).
The CLI self-refreshes its console token from the AccessKey, so this source
survives console-session expiry — **no browser, no periodic login**.

One-time setup (on the stack host):

```bash
bash collector/qwen-openapi-setup.sh   # prompts for the AccessKey ID/secret
```

The key must belong to the account that owns the token-plan: the plan is
personal and a RAM sub-user is refused with
`BailianGateway.Team.NotAuthorised` (verified 2026-09-14) — hence the
main-account AccessKey, an accepted risk recorded in DECISIONS.md. Rotate it
in the RAM console if it may have been exposed; re-run the setup script to
store the new key.

If the CLI source fails, the collector degrades through the legacy
`qwen-browser` CDP grab / settings cookie and finally the token-plan API key
(amber **key mode** chip: available / exhausted + reset, no percentages).

## Provider coverage

| Card | Source | Auth |
|---|---|---|
| Claude | `anthropic` (via opencode-quota CLI) | Claude Code OAuth (`claude login`) |
| ChatGPT | `openai` (via opencode-quota CLI) | `opencode auth login -p openai` |
| Z.ai | direct quota API | auth.json `zai-coding-plan` API key |
| OpenCode Go | direct usage API | auth.json `opencode-go` key |
| Gemini · Antigravity | `google-antigravity` (via opencode-quota CLI) — one card per Google AI plan, one window per model (G3Pro, G3Flash, …) | `opencode auth login` → Google (Antigravity) |
| Qwen | Alibaba Token Plan usage API (via `bailian-cli`) / token-plan probe | main-account AccessKey in `data/bailian` (self-refreshing console token); legacy browser + cookie + key fallbacks |

Exhausted windows are shown as 0% left, not hidden. Each card's big number
always uses the provider's own color; critical windows pulse and get a red
glow.

## Alerts

Configured via the Settings tab (Telegram bot token/chat ID and optional webhook URL):

- **Low-allowance warnings**: Staged notifications when the tightest window hits the configured threshold (default 15%) and when it hits 0% (exhausted).
- **Rollover / reset warnings**: Sent **24 hours** and **12 hours** before each agent's longest allowance window (monthly for OpenCode Go, weekly for Claude, OpenAI, Qwen, Z.ai) resets. Fires only when allowance remains (`> 0%`) so you can make maximum use of quota before rollover. Short 5-hour rolling limits are excluded to prevent spam.

## API

- `GET /api/quota` — latest ingest snapshot
- `GET /api/history` — last 500 ingest records (for the per-card sparklines)
- `GET /api/health` — health check
- `GET /api/settings`, `POST /api/settings` — masked settings view / update
- `POST /api/collect` — triggers an immediate on-demand quota probe
- `POST /api/telegram-test` — sends a test Telegram message
- `POST /api/webhook-test` — sends a test webhook alert
- `POST /api/ingest` — collector push endpoint (requires `X-Ingest-Key`)

History is appended to `data/history.jsonl` and rotated at 2 MB.

## Security notes

- Secrets live only in `data/` and `.env` (both gitignored) and in the host
  credential files mounted into the collector (never copied into images).
- The dashboard page and API are intended for trusted LAN use only (no auth
  on the page itself; the ingest endpoint is key-protected).
- The legacy Qwen remote desktop (optional `qwen` profile, normally off) is
  password-protected; its CDP (DevTools) port is bound to host loopback only
  — never expose it to a network.
- The Settings API always masks stored values.

## New user?

See **SUPPORT.md** — step-by-step onboarding (credentials, Telegram alerts,
Qwen login, troubleshooting incl. "card says X" lookup table).

## License

MIT
