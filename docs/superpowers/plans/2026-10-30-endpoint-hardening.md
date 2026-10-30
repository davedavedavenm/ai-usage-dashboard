# Endpoint Hardening (Collector UID + Alert Copy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the collector from writing root-owned credential and state files on khpi5, correct user-facing alert copy that still promises removed 50%/30% stages, and reconcile the docs with the live host.

**Architecture:** The collector container runs as uid 0 because `collector/Dockerfile` lacks the `USER` its own comment promises. Run both services as the stack owner (PUID/PGID, default 1000), migrate existing root-owned files once on khpi5, then verify token refreshes stay user-owned. The copy and doc fixes ride in the same deploy.

**Tech Stack:** Docker Compose, Node 22, Bash over `ssh -o BatchMode=yes khpi5`.

**Spec:** The 2026-10-30 endpoint review in this session; governed by `DECISIONS.md` and the deploy protocol in `AGENTS.md` §4.

## Global Constraints

- Repo is source of truth; khpi5 is `/home/dave/stacks/ai-usage-dashboard` and is not a git checkout.
- Normalize LF, `scp` changed files, rebuild changed images, `up -d`, then verify via the collector JSON log and `GET /api/quota`.
- No secrets in the repo, docs, logs, or command output.
- The collector must keep read/write access to the mounted credentials and `/data` after the UID change.
- Commit subjects are lowercase conventional (`fix:`, `docs:`); stage specific files only.

## Review Focus

- **Mounted credential ownership:** uid 1000 must read rotated `~/.claude/.credentials.json`, `~/.cache/opencode/opencode-quota/google-access-tokens.json`, and `~/.local/share/opencode/.openai-oauth-refresh.json`; chown root-owned leftovers first.
- **Writer compatibility:** `bl` and the quota CLI must still update `data/bailian/*` and the opencode cache/token files after the UID change.
- **Alert copy:** no user-facing text may promise the removed 50%/30% stages; only the configured threshold and 0% fire.
- **Docs contradiction:** no claim may disagree with `crontab -l` (the `*/2 qwen-watchdog` line is gone).
- **Rollback:** if the unprivileged collector cannot write a required path, revert the compose `user:` line and recreate before changing application code.

---

### Task 1: Run both services as the stack owner

**Files:**
- Modify: `docker-compose.yml` (services `ai-usage-dashboard` and `collector`)
- Modify: `collector/Dockerfile` (final stage, before `CMD`)
- Modify: `.env.example` (collector section)

**Interfaces:**
- Consumes: nothing.
- Produces: `user: "${PUID:-1000}:${PGID:-1000}"` on both services; `USER node` in the collector image; documented `PUID`/`PGID`.

- [ ] **Step 1: Add the compose user mapping**

In `docker-compose.yml`, add under both `container_name:` lines:

```yaml
    # Run as the stack owner so token refreshes and state files stay owned by
    # the same user as the mounted host credentials (2026-10-30).
    user: "${PUID:-1000}:${PGID:-1000}"
```

- [ ] **Step 2: Add the image-level fallback**

In `collector/Dockerfile`, immediately before `CMD ["node", "runner.mjs"]`:

```dockerfile
# Unprivileged fallback for plain `docker run`; compose can override with PUID/PGID.
USER node
```

- [ ] **Step 3: Document the variables**

In `.env.example` under `CREDENTIALS_ROOT`:

```
#PUID=1000                       # collector/dashboard uid (your host user)
#PGID=1000                       # collector/dashboard gid
```

- [ ] **Step 4: Validate the compose rendering**

Run on khpi5 after the file is pushed: `docker compose config | grep -A2 'user:'`
Expected: both services show `user: 1000:1000` (or the `.env` values).

- [ ] **Step 5: Commit the repo change**

```bash
git add docker-compose.yml collector/Dockerfile .env.example
git commit -m "fix: run stack services as the host user"
```

---

### Task 2: Migrate khpi5 ownership and redeploy the collector

**Files:** none in the repo (host state only).

**Interfaces:**
- Consumes: Task 1's compose user mapping.
- Produces: dave-owned credential and data files; a collector running as uid 1000.

- [ ] **Step 1: Push the changed files with LF normalization**

```powershell
$t = [IO.File]::ReadAllText("docker-compose.yml") -replace "`r`n","`n"
[IO.File]::WriteAllText("$PWD\docker-compose.yml", $t, (New-Object System.Text.UTF8Encoding($false)))
scp docker-compose.yml khpi5:/home/dave/stacks/ai-usage-dashboard/docker-compose.yml
scp .env.example khpi5:/home/dave/stacks/ai-usage-dashboard/.env.example
scp collector/Dockerfile khpi5:/home/dave/stacks/ai-usage-dashboard/collector/Dockerfile
```

- [ ] **Step 2: Chown existing root-owned files to the stack owner**

```bash
sudo find /home/dave/.claude /home/dave/.config/opencode /home/dave/.cache/opencode /home/dave/.local/share/opencode -user root -exec chown dave:dave {} +
sudo find /home/dave/stacks/ai-usage-dashboard/data -user root -exec chown dave:dave {} +
```

Expected: no `root`-owned entries remain under those paths (`find ... -user root` returns nothing).

- [ ] **Step 3: Rebuild and recreate the collector**

```bash
cd /home/dave/stacks/ai-usage-dashboard
docker compose build collector
docker compose up -d --force-recreate collector
```

Expected: `docker inspect aiud-collector --format '{{.Config.User}}'` → `1000:1000`; `docker compose exec -T collector id` → `uid=1000`.

- [ ] **Step 4: Prove a collect still works**

```bash
docker compose restart collector
sleep 8
docker compose logs collector --tail 4
curl -s http://127.0.0.1:8099/api/quota | head -c 300
```

Expected: `http: 204`, all seven providers `ok`, fresh `receivedAt`.

- [ ] **Step 5: Prove the host CLIs can read their credentials again**

```bash
timeout 15 /home/dave/.local/bin/claude auth status --json | head -3
find /home/dave/.claude /home/dave/.cache/opencode /home/dave/.local/share/opencode /home/dave/stacks/ai-usage-dashboard/data -user root
```

Expected: `"loggedIn": true` and no root-owned files.

---

### Task 3: Correct the stale alert copy

**Files:**
- Modify: `server.js:227`
- Modify: `public/index.html:322`
- Modify: `public/index.html:734`

**Interfaces:**
- Consumes: nothing.
- Produces: user-facing copy that matches the collector's actual alert stages.

- [ ] **Step 1: Replace the Telegram test message**

Change the test text in `POST /api/telegram-test` to:

```js
text: "✅ <b>AI Allowance alerts are live</b>\nYou'll get a warning when a window falls below your threshold (default 15%) and another at 0% — once per reset period.",
```

- [ ] **Step 2: Replace the Settings subtitle**

Change the Qwen/Telegram block subtitle to:

```html
<div class="ssub">warnings per window: 🔴 below your threshold (default 15%), then 🚨 at 0%, once per reset</div>
```

- [ ] **Step 3: Fix the legacy cookie label**

In `loadSettings()`, change the set-cookie label to `legacy cookie stored (N chars)` so a dead fallback cookie no longer reads as healthy.

- [ ] **Step 4: Verify the strings**

Run: `grep -R "50% →\|50% ->" server.js public/index.html SUPPORT.md`
Expected: no matches in those three files.

- [ ] **Step 5: Rebuild the dashboard image and recreate**

```bash
docker compose build ai-usage-dashboard
docker compose up -d --force-recreate ai-usage-dashboard
curl -s http://127.0.0.1:8099/ | grep -o "below your threshold"
```

Expected: the new phrase is served.

- [ ] **Step 6: Commit**

```bash
git add server.js public/index.html
git commit -m "fix: correct alert stage description"
```

---

### Task 4: Reconcile the docs with the live host

**Files:**
- Modify: `SUPPORT.md` (alert stages, env table, health check container count)
- Modify: `DECISIONS.md` (cron inventory, keepalive note, OpenCode Go chown note, new unprivileged-collector decision)

**Interfaces:**
- Consumes: Task 1's UID decision and Task 2's verified host state.
- Produces: docs that match `crontab -l` and the running stack.

- [ ] **Step 1: Fix the SUPPORT alert section**

Replace the 50%/30% staging sentence with the threshold + 0% behaviour, and add `PUID`/`PGID` to the env table.

- [ ] **Step 2: Fix the SUPPORT health check**

Replace "all four containers Up" with "the two default services (`ai-usage-dashboard`, `aiud-collector`) Up; the `qwen` profile adds two more".

- [ ] **Step 3: Fix the DECISIONS cron inventory**

Replace the `*/2 qwen-watchdog` block with: no host cron entries for this stack; scheduling is in the collector container; the watchdog line was removed 2026-09-14.

- [ ] **Step 4: Fix the keepalive note**

In the Qwen AccessKey decision, replace the "still logs SESSION_EXPIRED" sentence with the current behaviour: the 2-hourly keepalive verifies the legacy cookie once and exits 0 with "skipping cookie keepalive" when the AccessKey config is present.

- [ ] **Step 5: Add the unprivileged-collector decision**

Add an Active entry naming the 2026-10-30 change: services run as PUID/PGID (default 1000), the collector image keeps `USER node`, and existing root-owned files were chowned once. Note that this removes the old `sudo chown auth.json` trap for OpenCode Go renewals.

- [ ] **Step 6: Commit**

```bash
git add SUPPORT.md DECISIONS.md
git commit -m "docs: reconcile collector uid, cron, and alert notes"
```

---

### Task 5: Full verification and push

**Files:** none.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a clean, pushed `main` that matches khpi5.

- [ ] **Step 1: Run the test suites**

Run: `node --test collector/quota-parsers.test.mjs collector/alerts.test.mjs`
Expected: 33 passing, 0 failing.

- [ ] **Step 2: Re-verify repo ↔ host hashes**

Compute LF-normalized SHA-256 for every changed tracked file locally and `sha256sum` on khpi5; every pair must match.

- [ ] **Step 3: Re-verify the live stack**

```bash
curl -s http://127.0.0.1:8099/api/quota
docker compose logs collector --tail 6
docker compose ps
```

Expected: fresh `receivedAt`, all providers `ok`, both services `Up`, collector `user` 1000.

- [ ] **Step 4: Push**

```bash
git push origin main
git ls-remote origin refs/heads/main
git rev-parse HEAD
```

Expected: the remote SHA equals `HEAD`, working tree clean.