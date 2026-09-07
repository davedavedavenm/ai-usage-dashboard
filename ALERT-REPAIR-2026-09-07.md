# Alert receipt repair — 7 September 2026

Goal: repair proven delivery/state defects without changing Dave's pending threshold preference. Existing 50/30/configured-final thresholds remain; the documented exhausted stage must remain distinct from the final warning.

1. Read owner decisions and current collector; consult official Node fetch/fs and Telegram positive receipt docs.
2. Require positive transport receipts and retain independent progress per configured destination. Retry failed deliveries on the next fresh collection; do not replay less severe stages after a more severe stage. Preserve legacy sent records rather than flood historical messages.
3. Persist state atomically with fsync; report unreadable/write-failed state instead of silently resetting dedupe. Test production functions with stubbed network and persistence, including HTTP errors and restart reconstruction.
4. Back up the exact deployed source and current image privately, require matching source preimage, rebuild only the collector from unchanged image tags, and recreate only that service at a serial deployment slot. Never copy or expose credentials. Verify in-container source hash, logs and fresh quota ingestion. No synthetic chat test.
5. Commit/push owner source and evidence; sync the existing infra task. Rollback restores backed-up source/image and recreates only collector, preserving runtime state and credentials.

Risks: duplicate delivery after an uncertain send/commit (at-least-once limit), suppressing independent webhook retries, source drift, interruption during collection. Gates: actual receipt/error tests and no in-flight collection during switch where possible. Threshold changes remain pending Dave's answer.

Source validation: eight production-function tests pass (`node --test collector/alerts.test.mjs`) plus syntax check. Independent review identified alternating-tightest-window dedupe and malformed nested history; both now have regressions. Actual installed Node v22.23.2 supports flushed synchronous writes; current six-provider state passes the new validator without modification. Webhook is currently disabled, so its generic 2xx contract is not confused with n8n's `accepted:true` receipt.

Official references: [Node fetch](https://nodejs.org/api/globals.html#fetch) and [filesystem APIs](https://nodejs.org/api/fs.html), consulted through Context7; [Telegram Bot API](https://core.telegram.org/bots/api) positive `ok` response. Live deployment and quota ingestion proof pending the serial slot.
