# AGENTS.md — ai-usage-dashboard Agent Protocol

## 1. Role & Mission

You are maintaining a small LAN dashboard that shows AI subscription allowance
(Clauude/ChatGPT/Z.ai/OpenCode Go/Gemini/Qwen) with Telegram low-allowance
alerts. Server + collector run on **khpi5**; this Windows checkout is the
source of truth. Your job: keep the three copies (repo ↔ khpi5 ↔ GitHub)
aligned and the usage data actually flowing — with evidence, not assumptions.

## 2. Operating Principles

1. **Repo is source of truth.** Never patch host files on khpi5 without making
   the same change here in the same session. Deploy immediately after editing.
2. **Evidence over absence.** A missing error is not success. Verify via
   `collect.log` lines and `GET /api/quota` payloads (see §4).
3. **Read `DECISIONS.md` first** before changing auth flows, cron, deploy
   method, or alerting. It records why things are the way they are.
4. **Secrets stay on khpi5** (`data/settings.json`, `.env`). Never print,
   copy into docs, or commit them. Settings API always masks.
5. **Windows-simple**: everything runs through `ssh -o BatchMode=yes khpi5`.
   Nothing needs installing locally.

## 3. Paths

| What | Here | On khpi5 |
|---|---|---|
| Repo | `C:\Users\Dave\repos\ai-usage-dashboard` | — |
| Stack root | — | `/home/dave/stacks/ai-usage-dashboard` |
| Collector scripts | `scripts/*.mjs`, `scripts/*.sh` | `<stack>/collector/*` |
| Server | `server.js` (Docker, port 8099) | same, container `ai-usage-dashboard` |
| Runtime data/secrets | gitignored | `<stack>/data/` (`settings.json`, `latest.json`, `history.jsonl`) |
| Collector runtime state | gitignored | `<stack>/collector/state.json`, logs |

## 4. Deploy & Verify Protocol

Deploy (after every code change):

```powershell
# normalize LF before scp (git may leave CRLF in working tree)
$t = [IO.File]::ReadAllText("<file>") -replace "`r`n","`n"
[IO.File]::WriteAllText("<abs path>", $t, (New-Object System.Text.UTF8Encoding($false)))
scp <file> khpi5:/home/dave/stacks/ai-usage-dashboard/collector/<name>
```

Verify (all four, every time):

```bash
ssh -o BatchMode=yes khpi5 "node --check /home/dave/stacks/ai-usage-dashboard/collector/<changed>.mjs"
ssh -o BatchMode=yes khpi5 "cd .../collector && flock -n /tmp/aiud-collect.lock node collect.mjs"   # EXIT=0
ssh -o BatchMode=yes khpi5 "tail -2 .../collector/collect.log"        # providers all ok, no unexpected "skipped"
ssh -o BatchMode=yes khpi5 "curl -s http://127.0.0.1:8099/api/quota" # shape: {receivedAt, envelope:{providers:{...}}}
```

Multi-command remote work: write a script file locally, `scp` it, `bash /tmp/x.sh`.
Do NOT pass compound quoted one-liners from PowerShell (quoting mangling;
see infra DECISIONS.md bash -s rule).

## 5. Cron (khpi5 local time; logs are UTC)

See DECISIONS.md "Cron inventory". Two entries: */10 collect (flocked) and
2-hourly `keepalive.mjs` (Alibaba session keepalive, plain HTTP). BST is
UTC+1 — don't misread log timestamps as cron misses. There is deliberately NO
browser automation in this stack anymore.

## 6. Common Mistakes To Avoid

- **Assume a login problem when a card is dead.** Check `grep skipped
  collect.log` first. The CLI needs PATH augmentation to find `claude`; that
  lives in `runStatusCli()` now — don't remove it.
- **Trust HTTP 200 from Alibaba pages** as session-alive proof. Only the real
  usage-API call (`verifyAliCookie`) counts.
- **Reintroduce cookie pastes or unattended login automation for Qwen.** Settled
  (2026-08-26): percentages auto-grab from the `qwen-browser` container's live
  profile over CDP. When the Qwen card loses percentages: the session died —
  remote in (`ssh -L 3099:localhost:3099 khpi5` → `http://localhost:3099`) and
  log in again; if the browser isn't up, cold-recreate with
  `docker compose up -d qwen-browser cdp-relay`, don't `docker restart`.
- **Start a second collector** for testing without `flock -n` on the same lock.
- **Compare file copies by eye.** Use LF-normalized md5 both sides
  (`sed 's/\r$//' f | md5sum` remote; normalize CRLF→LF locally).
- **Edit crontab PATH instead of code env** — invocation-context-proof env in
  `collect.mjs` is the settled fix (DECISIONS.md).
- **Commit blanket `git add .`** — stage specific files; CRLF/LF divergence.

## 7. Provider/Auth Quick Matrix

Full table with renewal paths in DECISIONS.md. One-liners:
Claude/ChatGPT = OAuth auto-refresh (`claude-token.mjs` / `chatgpt-token.mjs`);
Antigravity =
opencode OAuth; Z.ai/OpenCode Go/Qwen-key = API keys; Qwen = live login held
in the `qwen-browser` container, auto-grabbed over CDP, with token-plan key
fallback. Telegram
bot "AI Usage Manager": staged allowance alerts only, dedupe in `state.json`,
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
