# AGENTS.md — ai-usage-dashboard Agent Protocol

## 1. Role & Mission

You are maintaining a small LAN dashboard that shows AI subscription allowance
(Claude/ChatGPT/Z.ai/OpenCode Go/Gemini/Qwen) with Telegram low-allowance
alerts. The whole stack (server, collector, optional qwen-browser) runs as a
Docker Compose stack on **khpi5**; this Windows checkout is the source of
truth. Your job: keep the three copies (repo ↔ khpi5 ↔ GitHub) aligned and
the usage data actually flowing — with evidence, not assumptions.

## 2. Operating Principles

1. **Repo is source of truth.** Never patch host files on khpi5 without making
   the same change here in the same session. Deploy immediately after editing.
2. **Evidence over absence.** A missing error is not success. Verify via the
   collector's JSON log lines and `GET /api/quota` payloads (see §4).
3. **Read `DECISIONS.md` first** before changing auth flows, scheduling,
   deploy method, or alerting. It records why things are the way they are.
4. **Secrets stay on khpi5** (`data/settings.json`, `.env`). Never print,
   copy into docs, or commit them. Settings API always masks. The collector
   mounts host credential files (never copies) — they stay the single
   source of truth for the interactive CLIs too.
5. **Windows-simple**: everything runs through `ssh -o BatchMode=yes khpi5`.
   Nothing needs installing locally.

## 3. Paths

| What | Here | On khpi5 |
|---|---|---|
| Repo | `C:\Users\Dave\repos\ai-usage-dashboard` | — |
| Stack root | — | `/home/dave/stacks/ai-usage-dashboard` |
| Collector (code + own Dockerfile) | `collector/*` | built into image `aiud-collector` |
| Server | `server.js`, `Dockerfile`, `public/` | image `ai-usage-dashboard`, port 8099 |
| Runtime data/secrets | gitignored | `<stack>/data/` (`settings.json`, `latest.json`, `history.jsonl`, `collector-state.json`, qwen-browser profile) |
| Host credentials (mounted, not copied) | — | `~/.claude`, `~/.config/opencode`, `~/.cache/opencode`, `~/.local/share/opencode` |

## 4. Deploy & Verify Protocol

Deploy (after every code change) — the stack builds from the repo files, so
the flow is rsync-of-truth → rebuild → verify. Until khpi5 becomes a git
checkout, push changed files with LF normalization then rebuild:

```powershell
# normalize LF before scp (git may leave CRLF in working tree)
$t = [IO.File]::ReadAllText("<file>") -replace "`r`n","`n"
[IO.File]::WriteAllText("<abs path>", $t, (New-Object System.Text.UTF8Encoding($false)))
scp <file> khpi5:/home/dave/stacks/ai-usage-dashboard/<relative path>
```

Then on khpi5 (via script file, not inline quoting):

```bash
docker compose build collector ai-usage-dashboard   # rebuild changed images
docker compose up -d                                # recreate changed services
docker compose logs collector | tail -5             # one JSON line per run:
                                                     # providers all "ok", no unexpected "skipped"
curl -s http://127.0.0.1:8099/api/quota              # shape: {receivedAt, envelope:{providers:{...}}}
```

To force an immediate collect (still can't race itself — the in-container
runner is single-flight by construction): `docker compose restart collector`
starts a fresh run at once.

Multi-command remote work: write a script file locally, `scp` it, `bash /tmp/x.sh`.
Do NOT pass compound quoted one-liners from PowerShell (quoting mangling;
see infra DECISIONS.md bash -s rule).

## 5. Scheduling (khpi5)

The collector container runs its own scheduler (`collector/runner.mjs`):
collect every 10 min, Alibaba keepalive every 2 h, aligned to wall-clock
boundaries with a +5 s guard, single-flight (one process owns all spawning —
the old flock rule by construction). Container tz via `TZ` env. There is
deliberately **no agent-driven browser automation from this repo** — no MCP
browser routes feed the collectors; the only browser in the stack is the
dedicated `qwen-browser` container holding the Qwen login (§6). The
qwen-watchdog */2 host cron remains as a backstop only.

## 6. Common Mistakes To Avoid

- **Assume a login problem when a card is dead.** Check the collector log's
  `skipped` object first (`docker compose logs collector`). The quota CLI
  needs the `claude` binary to authenticate the Anthropic probe — the
  collector image installs it; plain-node runs need PATH augmentation (that
  lives in `runStatusCli()`, don't remove it).
- **Trust HTTP 200 from Alibaba pages** as session-alive proof. Only the real
  usage-API call (`verifyAliCookie`) counts.
- **Reintroduce cookie pastes or unattended login automation for Qwen.** Settled
  (2026-08-26): percentages auto-grab from the `qwen-browser` container's live
  profile over CDP. When the Qwen card shows the amber "key mode" chip: the
  console session died — open `https://192.168.1.143:3099` (LAN; creds in stack `.env`; self-signed
  cert warning is expected) or `https://100.65.57.85:3099` (tailnet) and log
  in again. The browser
  self-heals (in-container supervisor + */2 watchdog cron recreate); only dig
  into khpi5 if the desktop itself never loads. The supervisor launches
  Chromium directly onto the Bailian console URL — that open tab is the
  session's keepalive (2026-08-28 expiry: browser sat on a blank tab for
  ~34 h after a relaunch).
- **Start a second collector** for testing without `flock -n` on the same lock
  (host-cron era rule; with the containerized runner, simply never run a
  second collector container against the same ingest).
- **Compare file copies by eye.** Use LF-normalized md5 both sides
  (`sed 's/\r$//' f | md5sum` remote; normalize CRLF→LF locally).
- **Edit crontab PATH instead of code env** — invocation-context-proof env in
  `collect.mjs` is the settled fix (DECISIONS.md); with the containerized
  collector the env is always the container env, but the code-level
  augmentation stays for plain-node runs.
- **Commit blanket `git add .`** — stage specific files; CRLF/LF divergence.

## 7. Provider/Auth Quick Matrix

Full table with renewal paths in DECISIONS.md. One-liners:
Claude/ChatGPT = OAuth auto-refresh (`claude-token.mjs` / `chatgpt-token.mjs`);
Antigravity =
opencode OAuth; Z.ai/OpenCode Go/Qwen-key = API keys; Qwen = live login held
in the `qwen-browser` container, auto-grabbed over CDP, with token-plan key
fallback. Telegram
bot "AI Usage Manager": staged allowance alerts only, dedupe in the collector
state file (`data/collector-state.json`),
config only in khpi5 `data/settings.json`.

## 8. Commit Discipline

Conventional lowercase subjects matching repo history (`fix:`, `feat:`,
`docs:`). Commit and push at the end of each task — this repo's GitHub origin
must always match what khpi5 runs plus these two docs. Never commit `.env`,
`data/`, logs, or state.

## 9. Related Docs

`README.md` (architecture, API, OAuth login flows) · `DECISIONS.md` (settled
decisions — read second) · infra repo `docs/protocols/ai-agent-reference.md`
(SSH alias table) · infra `AGENTS.md` (fleet-wide agent protocol).

## 10. MCP Tools

**Tool discovery is mandatory, not optional.** Do not assume a tool exists or doesn't exist — call `retrieve_tools` on the local MCPProxy (Windows: `http://127.0.0.1:8080/mcp`; khpi5: `http://127.0.0.1:9092`) at the moment you need a capability, and verify the exact `server:tool` name before every call, especially before any write. This repo's collectors deliberately use no MCP surfaces — deployment and verification run over `ssh -o BatchMode=yes khpi5` per §4.

### Signed-in Edge Browser (Windows MCPProxy only)
For authenticated-browser tasks (e.g. observing whether the `qwen-browser` desktop at `https://192.168.1.143:3099` has loaded, signed-in sites), use the MCPProxy upstream `playwright-edge` — Microsoft's official Playwright Extension attached to the live Edge `Default` profile (`David M` / `davidm@live.co.uk`). **This route exists only on the Windows MCPProxy (`http://127.0.0.1:8080/mcp`) — khpi5 has no signed-in browser route.** This does not change the settled Qwen rule: agents must never paste cookies or automate logins — the Edge route is for observation only. Never use Edge debugging mode, port 9222, or profile clones. Canonical runbook: `C:\Users\Dave\repos\windows\mcpproxy\signed-in-edge-automation.md`; prove health with `Test-SignedInEdgeAutomation.ps1 -RequireLiveProof` before first use (operational, full gate + authenticated identity readback verified 2026-08-30).
