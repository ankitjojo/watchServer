# Plan: fixes from the pre-production review (`docs/review_opus.md`)

> Approved by the user on 2026-11-18: fix all High (H1–H3) and Medium (M1–M10) items; Low items stay pending.
> Rule: one item at a time, each with a test that fails before the fix and passes after. Targeted tests while working; all gates once at the end.

## Decisions from the user (review §5)

1. **H2**: a failure limited to one collection (missing collection, query timeout, query error) is that monitor's **own** `MONITOR_ERROR`. It goes to the monitor's normal recipients under its alert mode and is not grouped. Only that monitor's next successful check recovers it. The grouped, masters-only outage email is kept only for a real source DB outage (connection-level failure). → TD-29, requirements FR-A4/FR-A4a.
2. **H1**: maximum check interval = 24 hours, enforced in validation (form + API) and config (`MAX_CHECK_INTERVAL_MIN`, default 1440, at most 1440). The scheduler also refuses any delay above Node's timer limit (2^31−1 ms). → TD-30.
3. **M4**: payMonitor's own indexes are created at startup in every environment (idempotent). A failure is logged clearly and startup stops. Never touch Source DB indexes. → TD-31.
4. **M5**: `MAIL_TRANSPORT=outbox` with `NODE_ENV=production` stops startup.

## Design per item

| Item | Change |
|------|--------|
| H1 | `MAX_CHECK_INTERVAL_MIN` config; `addIntervalIssues` rejects longer intervals; `scheduler.arm` refuses delays > `MAX_TIMER_DELAY_MS` (logs `check.scheduleRefused`, monitor not armed). Stored monitors above 24 h still load and run (backward compatible) unless above the Node limit. |
| H2 | `SourceDataError` kinds: `UNAVAILABLE` (connection-level: server selection, network, closed client, auth) vs `TIMEOUT`, `COLLECTION_NOT_FOUND`, `QUERY_FAILED` (per collection). Runner: outage → `handleSourceError` (grouped, unchanged); per-collection → `processCheckOutcome` with result `ERROR`; policy treats `ERROR` as a failing result (`MONITOR_ERROR`, recipients `ALL`, alert mode applies, same incident as STALE/NO_DATA like D4); monitor `eCurrentStatus` becomes `ERROR`. Only non-error checks call `handleSourceHealthy`. New per-monitor MONITOR_ERROR email template. |
| H3 | `scheduler.start()` becomes active only after loading succeeds. Lease: if `onAcquired` rejects, log `lease.startFailed`, run `onLost`, release the lock doc; the next tick retries. |
| M1 | Lease records the request start time; `isHeld()` is false once `requestStart + ttl − renew` has passed; a watchdog timer fires at that deadline and steps down even while a renewal hangs. Lease operations get `timeoutMS`. Lease takes injectable `timers`. |
| M2 | Joining a grouped outage alert: atomic `$push` guarded by `aAffectedMonitors.iMonitorId $ne` (repo `addAffectedToPending`), then re-render and write the body only if the stored array still has the rendered size. |
| M3 | Blocklist via `net.BlockList` with IPv4-mapped normalisation. Connection pinning: the probe uses `node:http`/`node:https` with a `lookup` hook that vets the exact addresses the socket connects to (no second resolution). |
| M4 | Startup runs `ensureMonitorDbIndexes` always; failure → `app.indexesFailed` fatal log + exit 1 (in the new runtime module). |
| M5 | `env.schema` superRefine issue. |
| M6 | Claim token `sClaimId` set by `claimNext`; `markSent/markRetry/markFailed` conditional on it (lost claim → `alert.claimLost` log, no write). Overall send deadline = 2 × `SMTP_TIMEOUT_MS`; config requires `DISPATCHER_LOCK_MS > 2 × SMTP_TIMEOUT_MS`. |
| M7 | Concurrency cap applies to webhook checks only (Source DB); endpoint probes are not queued behind it. |
| M8 | `getLatestTimestamp` runs the `find` first and checks existence (`listCollections({ name })`, `maxTimeMS`) only when the result is empty. |
| M9 | Shutdown starts lease release in parallel with `server.close()`; hard-exit timer = `SHUTDOWN_TIMEOUT_MS + send deadline + grace`. |
| M10 | `src/runtime.ts`: startup sequence + leader hooks + shutdown, injectable; `server.ts` only wires real dependencies. Integration tests for startup order, lease → scheduler/dispatcher, index failure, shutdown. |

## Checklist (resume here)

- [x] Plan written (this file)
- [x] H1 interval max + scheduler guard
- [ ] H2 per-monitor source errors
- [ ] H3 leader start failure retried
- [ ] M1 lease watchdog + timeoutMS
- [ ] M2 grouped alert merge race
- [ ] M3 SSRF mapped IPv6 + connection pinning
- [ ] M4 indexes at startup (in runtime)
- [ ] M5 outbox refused in production
- [ ] M6 claim token + send deadline
- [ ] M7 concurrency cap for webhook only (+ ±30 s accuracy test)
- [ ] M8 one find per check
- [ ] M9 shutdown order and timers (in runtime)
- [ ] M10 runtime extraction + wiring tests
- [ ] Docs: requirements, architecture, database-design, security, technical-decisions (TD-29..31), .env.example, review status column, progress log
- [ ] All gates once at the end
