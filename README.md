# AI Usage Allowance Dashboard

A self-contained Docker Compose stack showing how much allowance is left on
each AI subscription - Claude, ChatGPT, Z.ai, OpenCode Go, Gemini/Antigravity,
Qwen - with Telegram alerts when any window runs low and reset warnings
24h and 12h before billing reset.

Everything runs in containers: the server is a single zero-dependency Node
file, the collector probes the providers' quota APIs every 10 minutes and
pushes results via a key-protected ingest endpoint. Qwen percentages come
from the Alibaba token-plan usage API, called directly with a console token
that `bailian-cli` self-refreshes from an Alibaba Cloud AccessKey (see *Qwen*
below); the legacy `qwen-browser` remote-desktop profile remains in the repo
as an optional fallback. No host cron, no workstation dependencies.

```
provider quota APIs (Z.ai, opencode.ai, Anthropic/OpenAI OAuth, Google AI, Alibaba ...)
        │
collector container ── runner.mjs (every 10 min) ──> POST /api/ingest (X-Ingest-Key)
        │                 └── Alibaba token-plan usage API (direct; bl-maintained token)
        ▼
server container ── GET / dashboard
```

## Quick start

```bash
git clone <this-repo> && cd ai-usage-dashboard
cp .env.example .env        # set INGEST_KEY (random string) — see SUPPORT.md
# The containers run as your uid:gid (PUID/PGID, default 1000). Create the
# mount points before the first `up`: Docker creates missing bind sources as
# root, and the services could not write them afterwards.
mkdir -p data ~/.claude ~/.config/opencode ~/.cache/opencode ~/.local/share/opencode
docker compose up -d --build
```

Upgrading a stack created before 2026-10-30? The collector used to run as
root and may have left credential/state files root-owned. Fix them once from
the stack host, then recreate:

```bash
sudo find ~/.claude ~/.config/opencode ~/.cache/opencode ~/.local/share/opencode \
  ./data -user root -exec chown "$(id -u):$(id -g)" {} +
docker compose up -d --force-recreate
```

Open `http://<host>:8099/` — the dashboard shows "Awaiting first sync" until
the collector has credentials to report (see *Connecting accounts* below).
The header toggle switches between **Instrument** (card grid) and **Signal**
(full-width bands); the choice is stored in `localStorage`.

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

Percentages come from the Alibaba token-plan usage API, called directly by
the collector with the console token that `bailian-cli` maintains from an
Alibaba Cloud AccessKey stored in `data/bailian/config.json` (gitignored,
same handling as `settings.json`). bl self-refreshes that token from the
AccessKey, so this source survives console-session expiry - **no browser, no
periodic login**. Since 2026-09-24 Alibaba reports a **monthly** usage window
which bl 2.0.1's own `usage token-plan` cannot parse (it prints `{}`), hence
the direct gateway call - see DECISIONS.md. The card shows percent remaining
plus a **Used this month** row; a full 100% bar means the API reported 0% used,
not a placeholder.

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

If the AccessKey source fails, the collector degrades through the legacy
`qwen-browser` CDP grab / settings cookie and finally the token-plan API key
(amber **key mode** chip: available / exhausted + reset, no percentages).

## Provider coverage

| Card | Source | Auth |
|---|---|---|
| Claude | `anthropic` (via opencode-quota CLI) | Claude Code OAuth (`claude login`) |
| ChatGPT | `openai` (via opencode-quota CLI) | `opencode auth login -p openai` |
| Z.ai | direct quota API + console subscription API (`biz/subscription/list`, for the plan renewal date) | auth.json `zai-coding-plan` API key |
| OpenCode Go | direct usage API | auth.json `opencode-go` key |
| Gemini · Antigravity | `google-antigravity` (via opencode-quota CLI) — one card per Google AI plan, one window per model (G3Flash, Claude, G3Image from the CLI; G4Argon from the Antigravity quota-summary endpoint, with an explicit `not reported` row if that call fails). GPT-OSS is not shown. | `opencode auth login` → Google (Antigravity) |
| Qwen | Alibaba Token Plan usage API (direct gateway call, `bailian-cli`-maintained token) / token-plan probe | main-account AccessKey in `data/bailian` (self-refreshing console token); legacy browser + cookie + key fallbacks |
| Radeon Cloud | AMD Token Factory fleet-load API (`/radeon/api/tokenfactory/load`) — live per-model capacity/availability of the public free model APIs | none (public feed) |

Exhausted windows are shown as 0% left, not hidden. Each card's big number
always uses the provider's own color; critical windows pulse and get a red
glow.

## Alerts

Configured via the Settings tab (Telegram bot token/chat ID and optional webhook URL):

- **Low-allowance warnings**: Staged notifications when the tightest window hits the configured threshold (default 15%) and when it hits 0% (exhausted).
- **Reset warnings**: Sent **24 hours** and **12 hours** before a durable allowance window resets. The collector picks the longest window that still has allowance (monthly for OpenCode Go and Qwen, weekly for Claude, OpenAI, Z.ai; Antigravity's Claude bucket resets on a multi-day/weekly cadence, while its Gemini flash/image buckets are 5-hour and excluded; GPT-OSS is not an Antigravity card or alert window). Fires only when allowance remains (`> 0%`) so you can use it before it expires. If the longest window is exhausted, a shorter durable window with remaining quota can still trigger a warning.

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
