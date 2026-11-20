# payMonitor — Architecture

> Status: **Implemented** (v1; see §5.5 for the composition root and lease). Source of truth for WHAT: [requirements.md](requirements.md).
> Decisions and trade-offs: [technical-decisions.md](technical-decisions.md). Folder layout: [project-structure.md](project-structure.md).

Legend used in this doc: **[Confirmed]** = stated in requirements or verified in code · **[Decision]** = agreed with the user · **[Recommendation]** = proposed, change via technical-decisions.md · **[Open]** = unresolved.

---

## 1. System context

```
                 ┌──────────────────────────── payMonitor (single Node.js process) ───────────────────────────┐
 Admin/Viewer ──►│ Express 5 HTTP layer (EJS pages + /api/v1 JSON)                                          │
   (browser)     │        │                                                                                │
                 │        ▼                                                                                │
                 │   Module services ◄──── Scheduler (in-process timers) ◄── Mongo lease lock              │
                 │        │                       │                                                        │
                 │        ▼                       ▼                                                        │
                 │  Monitor DB repos       Check runners ──► Source DB reader (read-only) ──► Source MongoDB │──► JOJO subscription DB
                 │        │                       │                                          (find only)   │    (read role only)
                 │        │                       └──► HTTP prober (GET) ───────────────────────────────────│──► Monitored endpoints
                 │        ▼                                                                                │
                 │  Monitor MongoDB ◄── Alert dispatcher (store-first, retry) ──► SMTP (Nodemailer) ────────│──► Recipients
                 └─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **[Confirmed]** Two MongoDB connections: Monitor DB (read/write, `MONGO_URI`) and Source DB (read-only, `SOURCE_MONGO_URI`).
- **[Decision]** Single production instance. The scheduler runs in the web process. A Mongo **lease lock** makes a second instance (accidental restart overlap, a dev laptop pointed at prod) unable to run checks or send email.
- **[Confirmed]** Source webhook collections write `dCreatedAt` as BSON `Date` (verified in `jojo_subscription_backend_2_0` repositories/controllers).

## 2. Layers and responsibilities

| Layer | Owns | Must NOT |
|-------|------|----------|
| **Routes** (`*.routes.ts`) | URL → middleware chain → controller. Role guards declared here. | Contain logic, touch DB. |
| **Controllers** (`*.controller.ts`) | Parse/validate input with the module's Zod schema, call one service method, choose view or JSON response. | Query DB, hold business rules, call SMTP/HTTP. |
| **Services** (`*.service.ts`) | Business rules, orchestration, audit-log calls, transactions of intent. | Know about `req`/`res`, render views. |
| **Repositories** (`*.repository.ts`) | All Monitor-DB queries for one collection; convert prefixed documents ↔ camelCase domain types via `*.mapper.ts` (TD-16). | Contain business decisions. |
| **Pure domain functions** (`*.policy.ts`, `*.evaluator.ts`) | Deterministic logic: staleness evaluation, alert decision, duration math. No I/O. | Import DB, logger, clock (time is passed in). |
| **Source reader** (`modules/sourceData`) | The ONLY code that touches the Source DB. Exposes `listCollections`, `getLatestTimestamp`, `hasDescendingIndex`. | Expose the raw `Db`/`Collection` object or any write method. |
| **Scheduler** (`src/scheduler`) | Timers, per-monitor in-flight guard, lease lock, (re)loading monitors. | Contain check logic — it calls module runners. |
| **Notifications** (`src/notifications/email`) | SMTP transport, email templates. | Decide WHO/WHEN to email — that is the alerts module. |
| **Middlewares** | Session auth, role guard, CSRF, request context, error handler, 404. | Business logic. |
| **Config** (`src/config`) | Zod-validated env → frozen typed object. | Be read via `process.env` anywhere else. |
| **Views** (`src/views`) | Presentation only, receive a typed view-model. | Query DB, compute business state. |

## 3. Modules (feature ownership)

| Module | Owns collections | Responsibilities (requirements ref) |
|--------|------------------|------------------------------------|
| `auth` | `sessions` (via connect-mongo) | Login/logout, seed first admin (§3). |
| `users` | `users` | Dashboard user CRUD, roles, last-admin protection (§3). |
| `recipients` | `recipients` | Recipient CRUD, master protection, seed master (FR-R1..R3). |
| `webhookMonitors` | `webhook_monitors` | CRUD, timestamp-key validation, index warning, staleness runner (FR-W1..W4). |
| `endpointMonitors` | `endpoint_monitors` | CRUD, HTTP probe with retries, runner (FR-E1..E3). |
| `checks` | `checks` | Persist check results, history queries, chart series (FR-H1, FR-D4). |
| `incidents` | `incidents` | Open/close incidents, durations (FR-A3). |
| `alerts` | `alerts` | Alert policy (mode decision), store-first, dispatcher with retry/backoff, resend, `MONITOR_ERROR` grouping (FR-A1..A6, FR-A4a). |
| `audit` | `audit_logs` | Record config changes (FR-H2). |
| `dashboard` | — (reads via other services) | Overview counts + table (FR-D1). |
| `sourceData` | — (Source DB, read-only) | See §2. |
| `health` | — | `/healthz`, `/readyz`. |

## 4. Allowed dependency directions

```
routes → controllers → services → repositories → database
                         │  ▲
                         │  └── other modules' SERVICES (never their repositories)
                         ▼
                    pure policies/evaluators, utils, constants, types, config

scheduler → module runners (webhookMonitors.runner, endpointMonitors.runner, alerts.dispatcher)
module runners → services of: checks, incidents, alerts, sourceData
alerts.service → notifications/email, recipients.service
```

Hard rules:
1. A module never imports another module's `*.repository.ts`. Cross-module reads go through that module's service.
2. `constants/`, `types/`, `utils/`, `config/` import nothing from `modules/`, `scheduler/`, `middlewares/`.
3. No import cycles. `alerts` must not import `webhookMonitors`/`endpointMonitors`; runners pass a monitor snapshot into `alerts.service`.
4. Only `modules/sourceData` imports the Source DB client.
5. Only `notifications/email` imports Nodemailer.

## 5. Core runtime flows

### 5.1 Webhook check (FR-W3) — one scheduled run
1. Scheduler fires for monitor `M` → skip if `M` already in flight (log `check.skipped`).
2. Runner calls `sourceData.getLatestTimestamp(collection, key)` (projection `{_id, key}`, `maxTimeMS`).
3. Pure `evaluateStaleness({ latestTs, now, thresholdMs })` → `OK | STALE | NO_DATA`. Source failure → `ERROR`. The read is one `find`; existence (`listCollections` by name) is checked only when it comes back empty (review M8).
4. `checks.service.record(...)` inserts the check. Then the runner re-reads the monitor (`isStillRunnable`): if it was **deleted** meanwhile (or, for a scheduled run, paused), the check stays stored but no incident, alert or state change follows (`check.droppedDeleted`, review L4, TD-36).
5. Source DB **outage** (connection-level, TD-29) → `alerts.service.handleSourceError(...)` (grouped, master only, FR-A4a). Monitor state unchanged.
   A per-collection `ERROR` (missing collection, timeout, query error) is the monitor's own failure and, like every other result, goes to `processCheckOutcome` → pure `decideAlert({ monitorState, result, alertMode, repeatIntervalMs, now })` returns actions:
   `openIncident | sendFailure | sendReminder | closeIncident+sendRecovered | none`.
6. Apply actions: incidents update, alert docs inserted with status `PENDING` (**store first**), monitor `oState.eCurrentStatus / dLastCheckAt / dNextCheckAt` updated atomically.
7. Dispatcher picks up PENDING alerts (immediately via in-process nudge, and by polling as a fallback).

### 5.2 Endpoint check (FR-E2)
Same as 5.1 but step 2 is `httpProbe(url, { timeoutMs, retryCount, retryDelayMs, maxRedirects })` returning all attempts. `DOWN` only if every attempt fails. No `ERROR` grouping — an unreachable URL **is** the alert.

### 5.3 Alert dispatch (FR-A1, FR-A2)
1. Atomically claim one due alert: `findOneAndUpdate({eStatus ∈ {PENDING,RETRYING}, dNextAttemptAt ≤ now, dLockedUntil < now}, {$set:{dLockedUntil, sClaimId}})`. Outcome writes match `sClaimId`, so an expired claim cannot overwrite the dispatcher that took over (TD-32).
2. Resolve recipients at creation time (already stored on the alert) → send via email module.
3. Success → `SENT` (+`dSentAt`, `sMessageId`). Failure (or the overall send deadline of 2 × `SMTP_TIMEOUT_MS`) → `RETRYING` with next backoff from config; after last → `FAILED`. Delivery is at-least-once.
4. On startup, the dispatcher resumes PENDING/RETRYING alerts (FR crash-safety, §5 of requirements).

### 5.4 Scheduler lifecycle (FR-S1..S4)
- Boot: acquire lease → load enabled, non-deleted monitors (the scheduler is active only once this worked; a failure releases the lease and is retried, review H3) → run each immediately → then every interval (`setTimeout` chain computed from `lastStartedAt + interval`, not `setInterval`, to avoid drift pile-up).
- Monitor create/edit/pause/resume/delete → service calls `scheduler.upsert(id)` / `scheduler.remove(id)` (in-process, immediate).
- `SCHEDULER_CONCURRENCY` caps webhook checks only (Source DB reads); endpoint probes are not queued behind it (review M7). Delays above the Node timer limit are refused (TD-30).
- Lease lost → stop all timers, log `error`, keep serving the dashboard read-only for checks.
- Shutdown: stop timers → await in-flight checks (bounded) → stop dispatcher → close DB clients.

### 5.5 Composition root, lease and shutdown (TD-28)
- `src/runtime.ts` (TD-33) owns startup, the lease hooks and shutdown; `server.ts` only provides the real clients, signals and `exit`.
- `src/compositionRoot.ts` builds every service in one place with plain factory arguments. Monitor services receive a **late-bound scheduler port**, and the real scheduler is bound after the runners exist, which breaks the cycle monitor service → scheduler → runner → monitor service.
- The scheduler lease (`scheduler_locks`) is renewed every `LEASE_RENEW_MS`. A holder that cannot renew **steps down at `renewal request time + LEASE_TTL_MS − LEASE_RENEW_MS`**, before the lease can expire for another instance, so two leaders never overlap. A watchdog enforces that moment even while a renewal hangs, `isHeld()` is time-based, and each lease operation is abandoned after `LEASE_RENEW_MS` (TD-32). On `acquired` the runtime starts the scheduler, then the dispatcher; on `lost` it stops both; the dispatcher only sends while `lease.isHeld()`.
- Startup: config → Monitor DB (fatal if down) → Source DB (non-blocking) → indexes (every environment, fatal on failure, TD-31) → services → seeds → listen → lease. Shutdown: stop accepting connections **and, in parallel,** release the lease (stops the scheduler and waits for running checks, then the dispatcher) → close both Mongo clients. Hard exit after `SHUTDOWN_TIMEOUT_MS + send deadline + 5 s` (review M9).
- `/readyz` reports `leader` (scheduler running), `standby` (lease loop running, not held) or `stopped`.

## 6. Cross-cutting

- **Time**: all logic in UTC; `Clock` (`now(): Date`) injected into runners/policies for testability. Display timezone from config (`TIMEZONE`, default `UTC`).
- **Durations**: stored as `{ nValue, eUnit }` (what the admin typed) **and** `nMs` (derived on save) so queries/logic never re-derive with a changed `DAYS_PER_MONTH`. [Recommendation — see technical-decisions TD-08]
- **Errors**: `AppError` hierarchy → central handler; see [coding-standards.md](coding-standards.md#errors).
- **Logging**: Pino with redaction; see [.claude/rules/error-handling-logging.md](../.claude/rules/error-handling-logging.md).
- **Security**: see [security.md](security.md).

## 7. Open architectural questions

| # | Question | Default until answered |
|---|----------|------------------------|
| A1 | Is the Monitor DB a replica set (needed for multi-document transactions)? | Design does **not** depend on transactions; uses idempotent dedupe keys + atomic single-doc updates. |
| A2 | Deployment target (PM2, Docker, VM)? Affects shutdown signals & log shipping. | Handle `SIGTERM` + `SIGINT`; log JSON to stdout. |
| A3 | Should private-network/loopback URLs be allowed for endpoint monitors? | Allowed (monitoring internal servers is a use case); admin-only creation. See security.md §SSRF. |
