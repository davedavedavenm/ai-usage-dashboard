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


## 8 September - approved midpoint notice removal (deployed 05:46 UTC)

Removed only the fixed 50% and 30% stages after Dave's approval. Configured
near-exhaustion (default 15%), exhaustion and all provider/window/destination
receipts remain. Old midpoint history remains without retrying those notices.
No retired cookie/session notices are reintroduced.

Ten production-function tests pass (`node --test collector/alerts.test.mjs`)
and syntax passes (`node --check collector/collect.mjs`). The new regression
checks silent midpoint samples, identical retained state and subsequent threshold
alerts. Existing partial-destination/restart and exhaustion tests remain green.

The deployment plan below was completed on 8 September; it is retained as the
rollback/redeployment contract. Verify expected installed source preimage
`f389a8b6ad59d5f126b411433ea619917470f7766e8ea5f8981071d9b932eca3` from
the receipt repair, plus current image. Privately back up source/image, install LF
source and tests, build only collector, run isolated tests with network disabled,
and switch only collector at an idle boundary. Preserve runtime settings/history,
receipts and credentials. Verify container source hash and next normal collection
and ingest without synthetic sends. Rollback restores source/image, never stale
receipt state.


Source `02fabb5` deployed at 2026-09-08T05:46:01Z. Private backup:
`/home/dave/.secrets/notification-review/ai-midpoint-20260908T054449Z`.
Collector image: `sha256:e32568d0b4d6f71066bf37904cd81cc59f43e60af2db6d183f27f0cf59738eca`.
Source SHA256: `776bfe3a41fb72928b87c3461b1e7dfe2cca7b2732b1b9c7c633a229a7fcd11e`.
All dependency layers were cached with the same Node base; ten network-isolated
tests passed. Only aiud-collector changed. Its first natural initialization run
at 05:46:09.414 UTC ingested HTTP204 with all six provider results OK;
quota receivedAt was `1788846369412`. No synthetic message was sent.

Qwen's existing console session is expired and collection uses its configured
key fallback. A successful provider collection does not claim that console login
is restored. The existing interactive renewal instructions still apply; no
retired session notices were reintroduced by this change.
