# Alert receipt repair — 7 September 2026

Goal: repair proven delivery/state defects without changing Dave's pending threshold preference. Existing 50/30/configured-final thresholds remain; the documented exhausted stage must remain distinct from the final warning.

1. Read owner decisions and current collector; consult official Node fetch/fs and Telegram positive receipt docs.
2. Require positive transport receipts and retain independent progress per configured destination. Retry failed deliveries on the next fresh collection; do not replay less severe stages after a more severe stage. Preserve legacy sent records rather than flood historical messages.
3. Persist state atomically with fsync; report unreadable/write-failed state instead of silently resetting dedupe. Test production functions with stubbed network and persistence, including HTTP errors and restart reconstruction.
4. Back up the exact deployed source and current image privately, require matching source preimage, rebuild only the collector from unchanged image tags, and recreate only that service at a serial deployment slot. Never copy or expose credentials. Verify in-container source hash, logs and fresh quota ingestion. No synthetic chat test.
5. Commit/push owner source and evidence; sync the existing infra task. Rollback restores backed-up source/image and recreates only collector, preserving runtime state and credentials.

Risks: duplicate delivery after an uncertain send/commit (at-least-once limit), suppressing independent webhook retries, source drift, interruption during collection. Gates: actual receipt/error tests and no in-flight collection during switch where possible. Threshold changes remain pending Dave's answer.

Source validation: nine production-function tests pass (`node --test collector/alerts.test.mjs`) plus syntax check. Independent review identified alternating-tightest-window dedupe, legacy-window migration and malformed nested history; all now have regressions. Actual installed Node v22.23.2 supports flushed synchronous writes; current six-provider state passes the new validator without modification. Webhook is currently disabled, so its generic 2xx contract is not confused with n8n's `accepted:true` receipt.

Official references: [Node fetch](https://nodejs.org/api/globals.html#fetch) and [filesystem APIs](https://nodejs.org/api/fs.html), consulted through Context7; [Telegram Bot API](https://core.telegram.org/bots/api) positive `ok` response.

## Live verification

Source b506f1d deployed after a private exact-preimage backup and nine tests inside the built image with network disabled. Only the collector was recreated; dashboard/browser/relay and credentials stayed intact. Initial backup-directory permission gate stopped before changes. A later `docker top -eo args` gate required PID in its format; corrected to `pid,args` and resumed against the already verified source/image, without rebuilding or replacing source again.

- Backup: `/home/dave/.secrets/notification-review/ai-receipts-20260907T201027Z` (original source, image ID, pre-switch state and build log; private).
- Source SHA-256: `f389a8b6ad59d5f126b411433ea619917470f7766e8ea5f8981071d9b932eca3` in `/collector/collect.mjs`.
- New image: `sha256:26e5a1f35dc2dc0bda5a6187004c511c54b1953a1b734fb5f087a51375f30dee`.
- Previous image retained: `sha256:7ff605b1bb603e69b1c2d86ef1dc97df1b6770bc06c54d83d0c3498fd19302e8`, also tagged `ai-usage-collector:rollback-20260907t201027z`.
- First normal startup collection: `2026-09-07T20:12:11.848Z`, ingest HTTP204, all six providers OK; quota `receivedAt=1788811931847`. No synthetic chat message.

Rollback: restore backed-up `collect.mjs`, remove only the newly introduced test file from the deploy context if reverting the source fully, retag the retained old image to `ai-usage-collector:latest`, and `docker compose up -d --no-deps collector`. Preserve live receipt history and credentials rather than restoring stale state. Threshold preference remains pending; transport repair does not imply midpoint notices were requested.
