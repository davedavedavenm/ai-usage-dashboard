# AI Usage Allowance Dashboard

A tiny, zero-dependency (server) LAN dashboard showing how much allowance is
left on each AI subscription — Claude, ChatGPT, Z.ai, OpenCode Go,
Gemini/Antigravity, Qwen — with Telegram alerts when any window runs low.

Everything runs on one small host (e.g. a Raspberry Pi): the server is a single
Node file with no npm dependencies, and the collector probes the providers'
quota APIs every 10 minutes and pushes results via a key-protected ingest
endpoint. Nothing needs to run on your workstation.

## Architecture

```
provider quota APIs (Z.ai, opencode.ai, Anthropic/OpenAI OAuth, Qwen token-plan, ...)
        │
cron (every 10 min) ── collector/collect.mjs ──> POST /api/ingest (X-Ingest-Key)
        │
server (Docker, port 8099) ── GET /  dashboard page
```

The collector reads credentials from `~/.local/share/opencode/auth.json`
(API keys for Z.ai / OpenCode Go; OAuth entries for Anthropic / OpenAI / Google
once you log in on the server). Z.ai and OpenCode Go are probed directly;
Anthropic / OpenAI / Antigravity go through the pinned
[`@slkiser/opencode-quota`](https://www.npmjs.com/package/@slkiser/opencode-quota)
CLI, whose structured status output is parsed into the same envelope.
Anthropic 429s trigger a 30-minute probe cooldown so the API is not hammered.

## Quick start

```bash
# 1. server
cp .env.example .env        # set INGEST_KEY to a random string
docker compose up -d --build

# 2. collector (on the same host)
cd collector && npm install
# add a cron entry, e.g. every 10 minutes:
*/10 * * * * cd /path/to/collector && node collect.mjs >> collect.log 2>&1
```

The ingest key must match the `INGEST_KEY` in the server `.env`.

> **Repo vs deployment layout:** in this repository the collector lives in
> `scripts/`; on the deployment host (`khpi5`, `/home/dave/stacks/ai-usage-dashboard`)
> the same files sit in `collector/`. See `AGENTS.md` for the deploy/verify
> protocol and `DECISIONS.md` for settled decisions.

## Connecting accounts

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

The collector picks the new credential up on its next 10-minute run.

## Settings tab

Open `http://<server>:8099/` → **Settings** (LAN only; secrets are stored in
`data/settings.json` on the server, never committed, and never returned raw by
the API — always masked):

- **Qwen (Alibaba Token Plan)**: percentages come from a logged-in console
  session held in the dedicated `qwen-browser` container on khpi5 (headful
  Chromium with a password-protected remote desktop). The collector auto-grabs
  cookies from that live profile over CDP every cycle — **no cookie pasting**.
  To log in or re-login: open `http://192.168.1.143:3099` (or via tailnet
  `http://100.65.57.85:3099`; creds in khpi5 stack `.env` as `QWEN_UI_USER` /
  `QWEN_UI_PASSWORD`) and sign into
  `modelstudio.console.alibabacloud.com`. Verified grabs are mirrored into
  `data/settings.json` for the 2-hourly keepalive. If the session dies
  server-side, the card silently falls back to availability mode from the
  token-plan API key until you log in again; percentages reappear within 10
  minutes of login. Self-healing: a supervisor loop inside the container
  relaunches Chromium if it dies, and a */2 watchdog cron recreates the whole
  thing if CDP stops answering (see DECISIONS.md).
- **Telegram alerts**: create a bot with @BotFather, send it `/start`, then
  either find your chat ID via
  `https://api.telegram.org/bot<TOKEN>/getUpdates` or use the Settings tab's
  *Send test message* button. Alerts are **staged**: 🟡 50% → 🟠 30% → 🔴
  final threshold (default 15%) → 🚨 at 0%, one message per stage per provider
  window per reset period, deduped in `collector/state.json` — so you're warned
  early, never bombarded. Allowance thresholds are the only alert source; there
  are no session/cookie maintenance notifications.

## Provider coverage

| Card | Source | Auth |
|---|---|---|
| Claude | `anthropic` (via opencode-quota CLI) | opencode anthropic OAuth on the server |
| ChatGPT | `openai` (via opencode-quota CLI) | `opencode auth login -p openai` on the server |
| Z.ai | `api.z.ai/api/monitor/usage/quota/limit` (direct) | auth.json `zai-coding-plan` API key |
| OpenCode Go | `opencode.ai/zen/go/v1/usage` (direct) | auth.json `opencode-go` key |
| Gemini · Antigravity | `google-antigravity` (via opencode-quota CLI) | Google OAuth on the server |
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

- Secrets live only on the server (`data/`, `.env` — both gitignored).
- The dashboard page and API are intended for trusted LAN use only (no auth on
  the page itself; the ingest endpoint is key-protected).
- Nothing in this repo contains credentials; the Settings API always masks
  stored values.

## License

MIT