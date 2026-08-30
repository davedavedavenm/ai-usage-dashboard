# AI Usage Allowance Dashboard

A self-contained Docker Compose stack showing how much allowance is left on
each AI subscription — Claude, ChatGPT, Z.ai, OpenCode Go, Gemini/Antigravity,
Qwen — with Telegram alerts when any window runs low.

Everything runs in containers: the server is a single zero-dependency Node
file, the collector probes the providers' quota APIs every 10 minutes and
pushes results via a key-protected ingest endpoint, and (optionally) a
dedicated browser container holds the Qwen console login. No host cron, no
workstation dependencies.

```
provider quota APIs (Z.ai, opencode.ai, Anthropic/OpenAI OAuth, Google AI, Alibaba ...)
        │
collector container ── runner.mjs (every 10 min) ──> POST /api/ingest (X-Ingest-Key)
        │                                                   │
        └── qwen-browser container ──CDP cookie grab──┘       ▼
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
docker compose --profile qwen up -d        # Qwen live-percentage browser
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

Percentages come from a logged-in console session held in the dedicated
`qwen-browser` container (headful Chromium with a password-protected remote
desktop). The collector auto-grabs cookies from that live profile over CDP
every cycle — **no cookie pasting**. To log in or re-login: open
`https://<host>:3099` (bind it to your LAN/tailnet IP via `QWEN_UI_BIND` /
`QWEN_UI_BIND2` in `.env`; accept the self-signed cert warning; creds from
`QWEN_UI_USER`/`QWEN_UI_PASSWORD`) and sign into
`modelstudio.console.alibabacloud.com`. Percentages reappear within 10
minutes. If the session dies server-side, the card shows an amber **key
mode** chip and falls back to token-plan-key availability until you log in
again.

## Provider coverage

| Card | Source | Auth |
|---|---|---|
| Claude | `anthropic` (via opencode-quota CLI) | Claude Code OAuth (`claude login`) |
| ChatGPT | `openai` (via opencode-quota CLI) | `opencode auth login -p openai` |
| Z.ai | direct quota API | auth.json `zai-coding-plan` API key |
| OpenCode Go | direct usage API | auth.json `opencode-go` key |
| Gemini · Antigravity | `google-antigravity` (via opencode-quota CLI) — one card per Google AI plan, one window per model (G3Pro, G3Flash, …) | `opencode auth login` → Google (Antigravity) |
| Qwen | Alibaba Token Plan usage API / token-plan probe | live Chromium profile in `qwen-browser` (CDP grab, self-healing) + token-plan key fallback |

Exhausted windows are shown as 0% left, not hidden. Each card's big number
always uses the provider's own color; critical windows pulse and get a red
glow.

## API

- `GET /api/quota` — latest ingest snapshot
- `GET /api/history` — last 500 ingest records (for the per-card sparklines)
- `GET /api/health` — health check
- `GET /api/settings`, `POST /api/settings` — masked settings view / update
- `POST /api/telegram-test` — sends a test Telegram message
- `POST /api/ingest` — collector push endpoint (requires `X-Ingest-Key`)

History is appended to `data/history.jsonl` and rotated at 2 MB.

## Security notes

- Secrets live only in `data/` and `.env` (both gitignored) and in the host
  credential files mounted into the collector (never copied into images).
- The dashboard page and API are intended for trusted LAN use only (no auth
  on the page itself; the ingest endpoint is key-protected).
- The Qwen remote desktop is password-protected; its CDP (DevTools) port is
  bound to host loopback only — never expose it to a network.
- The Settings API always masks stored values.

## New user?

See **SUPPORT.md** — step-by-step onboarding (credentials, Telegram alerts,
Qwen login, troubleshooting incl. "card says X" lookup table).

## License

MIT
