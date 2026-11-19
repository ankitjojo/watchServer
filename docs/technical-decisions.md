# payMonitor — Technical Decisions (ADR log)

> Each decision: context → decision → trade-offs → status. Add new entries at the bottom; never rewrite history — supersede instead.
> Status values: **Accepted** (user agreed) · **Proposed** (recommended, awaiting implementation/approval) · **Superseded**.

---

### TD-01 · Language & module system — Accepted
- **Decision**: Node.js 22 LTS (installed: v22.23.1) + TypeScript strict, **ESM** (`"type": "module"`, `module`/`moduleResolution: nodenext`).
- **Why**: Matches the source backend (`jojo_subscription_backend_2_0`), so the team reads one style. Node 22 gives native `fetch`, `AbortSignal.timeout`, `process.loadEnvFile`.
- **Trade-off**: ESM requires `.js` extensions in relative imports and complicates Jest (see TD-10).

### TD-02 · Web framework & views — Accepted
- **Decision**: Express 5 + EJS server-rendered pages; small JSON API under `/api/v1` for in-page actions and chart data.
- **Why**: Requirements specify it; Express 5 forwards rejected async handlers to the error middleware (no wrapper needed).
- **Trade-off**: No SPA; charts use a small browser script that fetches JSON.

### TD-03 · Two MongoDB connections, source is read-only — Accepted
- **Decision**: `MONGO_URI` (Monitor DB, read/write) and `SOURCE_MONGO_URI` (Source DB, MongoDB user with `read` role only). Source access wrapped by `modules/sourceData` which exposes no write method.
- **Why**: Requirement §5; defence in depth (DB role + code boundary).

### TD-04 · Field naming in Monitor DB — Superseded by TD-16
- ~~Plain camelCase (`name`, `isActive`, `createdAt`).~~ Replaced on 2026-11-18 at the user's request, before any code or data existed.

### TD-05 · Single instance + in-process scheduler with lease lock — Accepted
- **Decision**: Scheduler runs inside the web process using `setTimeout` chains per monitor. A `scheduler_locks` document (owner id + `expiresAt`, renewed every 15 s, TTL 45 s) must be held to run checks or dispatch email.
- **Why**: User confirmed single instance. Lease prevents double emails during restart overlap or an accidental second process. Avoids Redis/BullMQ/Agenda.
- **Rejected**: `node-cron` — requirements use "every N minutes/hours" intervals, not cron expressions; per-monitor `setTimeout` is simpler and supports immediate reschedule. BullMQ — would add Redis infra for one instance.
- **Upgrade path**: Multiple instances → per-monitor leases (same collection, key per monitor).

### TD-06 · Validation — Accepted
- **Decision**: Zod for env config, request bodies/query/params, and narrowing Source DB values.
- **Why**: Already used by the source backend; types inferred from schemas avoid duplication.

### TD-07 · Logging — Accepted
- **Decision**: Pino (+ `pino-http` for request logs), JSON to stdout, `pino-pretty` in dev only. Redaction list in `.claude/rules/error-handling-logging.md`.
- **Why**: Fast structured logs; requirements ask for structured logs per check/alert/email attempt.

### TD-08 · Durations stored as entered + normalized ms — Accepted
- **Decision**: Store `{ nValue: number, eUnit: DurationUnit, nMs: number }`. `ms` computed on save using `DAYS_PER_MONTH` at that time.
- **Why**: Show admins what they typed; logic uses `ms`. Changing `DAYS_PER_MONTH` affects only monitors saved afterwards — explicit and predictable.
- **Trade-off**: Requires a recompute script if the team ever wants existing monitors re-normalized.

### TD-09 · Alert idempotency via dedupe keys (no transactions required) — Accepted
- **Decision**: `alerts.sDedupeKey` unique index. Keys:
  `incident:<incidentId>:open`, `incident:<incidentId>:reminder:<n>`, `incident:<incidentId>:recovered`, `check:<checkId>:every` (Every-check mode), `sourceError:<incidentId>:open|recovered`, `test:<uuid>`.
  Duplicate-key error on insert = already created → treat as success.
- **Why**: Store-first + crash/restart must never produce duplicate emails; works without a replica set (open question A1).

### TD-10 · Testing — Accepted (Jest)
- **Decision**: Jest + `ts-jest` (ESM preset, run with `NODE_OPTIONS=--experimental-vm-modules`), `supertest` for HTTP, `mongodb-memory-server` for repository/integration tests. Endpoint probes tested against a local `http.createServer` (no HTTP-mocking library). Nodemailer replaced by an injected fake transport.
- **Trade-off**: Jest ESM support is still flagged experimental; `jest.mock` hoisting does not work in ESM — use dependency injection or `jest.unstable_mockModule`. Prefer DI.

### TD-11 · Sessions & CSRF — Accepted
- **Decision**: `express-session` + `connect-mongo` (sessions in Monitor DB; no Redis). CSRF: synchronizer token stored in the session — **`csrf-sync`** (same author as `csrf-csrf`; session-based variant fits because we already have server sessions).
- **Note**: The user approved "csrf-csrf"; `csrf-sync` (its session-backed sibling) was installed under the default of decision D2 on 2026-11-18. Swapping to `csrf-csrf` would be a small change confined to `src/middlewares/csrf.ts`.

### TD-12 · Endpoint probing with native fetch — Accepted
- **Decision**: Native `fetch` with `redirect: 'manual'` and a manual redirect loop (to honour `ENDPOINT_MAX_REDIRECTS`), `AbortSignal.timeout(ENDPOINT_TIMEOUT_MS)`. Response body is never read beyond what is needed to release the socket (`res.body?.cancel()`).
- **Why**: No dependency; native fetch's built-in redirect follow ignores a custom max.

### TD-13 · Charts — Accepted
- **Decision**: Chart.js installed via npm and served from a static route (`/vendor/chart.js`) — no CDN, so CSP stays `script-src 'self'`.

### TD-14 · Environment loading — Accepted
- **Decision**: `process.loadEnvFile()` (Node ≥ 20.12) in dev when `.env` exists; no `dotenv` dependency. Production supplies real env vars.

### TD-15 · Soft delete for monitors — Accepted (requirements FR-D2)
- **Decision**: `dDeletedAt` timestamp; all list queries filter `dDeletedAt: null`; history remains linked.

### TD-16 · Type-prefixed field names in Monitor DB (same as subscription backend) — Accepted
- **Context**: The user wants payMonitor's database to follow the same naming convention as the JOJO subscription DB so the team reads one style across both databases. Decided 2026-11-18, before any code or data existed, so there is no migration.
- **Decision**: Every stored field (top level and nested) uses a one-letter type prefix + PascalCase: `s` string, `n` number, `b` boolean, `d` Date, `e` enum value, `o` object, `a` array, `i` ObjectId reference. `_id` unchanged; collection names stay snake_case. Full table and rules: `docs/database-design.md` §B.0.
- **Scope (updated 2026-11-18)**: Prefixed names exist **only in the persistence layer**: document types (`<Entity>Doc` in `<module>.types.ts`), `<module>.mapper.ts`, `<module>.repository.ts`, and `src/database/indexes.ts`.
- **Everything above the repository is camelCase**: domain types, services, controllers, EJS view-models, HTML form field names, JSON request **and** response bodies, URL query params, log fields. (User decision: forms and API bodies stay camelCase.)
- **Mapping**: each module has a `<module>.mapper.ts` with pure functions `to<Entity>(doc)` (doc → domain) and `to<Entity>Doc(input, ctx)` / `to<Entity>Update(input)` (input → doc / `$set` object). Repositories call the mapper, so services never see a prefixed field. Mappers are unit-tested (a field missed in a mapper is a silent bug).
- **Trade-off vs. the subscription backend**: it uses prefixed names end-to-end with no mapping. We add one mapper per module in exchange for a clean camelCase API/forms; the cost is keeping mapper + both types in sync when a field is added.
- **Exception**: `sessions` (owned by `connect-mongo`) keeps the library's field names.
- **Trade-off**: Prefixes are noisier in code and don't add compile-time safety beyond what TypeScript already gives; accepted for consistency with the existing team codebase.


### TD-17 · STALE ↔ NO_DATA stay in the same incident — Accepted

- **Decision**: A webhook monitor moving between STALE and NO_DATA keeps one incident and sends no new "open" email; reminders use the alert type of the current result. (D4)

### TD-18 · EVERY_CHECK mode records incidents — Accepted

- **Decision**: Incidents are recorded for history; every failing check emails; no RECOVERED email. (D5)

### TD-19 · MONITOR_ERROR grouping window — Accepted

- **Decision**: The first `MONITOR_ERROR` alert is delayed by `SOURCE_ERROR_GROUP_WINDOW_MS` (default 60 s) so simultaneously failing monitors share one email; later monitors join the incident without a new email. (D6)

### TD-20 · Outbox mail transport and sandbox — Accepted

- **Decision**: `MAIL_TRANSPORT=outbox` writes `.eml` files; `npm run sandbox` runs two memory MongoDBs, fake endpoints and a control CLI so the system can be tested with no external services. (D11)

### TD-21 · Alert counters live on the incident — Accepted

- **Decision**: `dLastAlertAt` and `nReminderCount` are stored on `incidents`; alerts carry `nRetryIndex`, reset to 0 on resend. (D12, D13)

### TD-22 · Deleting a monitor closes its incident silently — Accepted

- **Decision**: Open incident closed with `eCloseReason: MONITOR_DELETED`, no email. (D7)

### TD-23 · First-run timing — Accepted

- **Decision**: Check runs immediately on create and resume; on edit the next run is `lastCheckAt + new interval` (or now if past). (D8)

### TD-24 · Index warning accepts any single-field index on the key — Accepted

- **Decision**: Ascending or descending index with the key first counts (MongoDB can walk it either way). (D9)

### TD-25 · Monitor actions and edit semantics — Accepted

- **Decision**: Run-now works on paused monitors and stays paused; editing a monitor leaves an open incident open. (D14, D15)

### TD-26 · User and recipient management rules — Accepted

- **Decision**: Password optional on user edit; `isActive` is a checkbox; NORMAL → MASTER recipient allowed, MASTER → NORMAL refused. (D16, D17)

### TD-27 · Resend recipients and grouped-alert subjects — Accepted

- **Decision**: Resend keeps stored recipients unless the list is empty (then re-resolve); grouped source alerts use `MONITOR_ERROR – Source DB (<n> monitors)` / `RECOVERED – Source DB`. (D18, D19)

### TD-28 · Composition root, late-bound scheduler port, lease self-fencing — Accepted

- **Decision**: One `compositionRoot.ts` builds all services; a late-bound scheduler port breaks the service ↔ scheduler cycle; the lease holder steps down before its lease can expire for others.

### TD-29 · Per-collection source failures are the monitor's own MONITOR_ERROR — Accepted (2026-11-18, review H2)

- **Context**: Every Source DB read failure was treated as a global outage, and any other monitor's healthy read "recovered" it. One unindexed or dropped collection produced a MONITOR_ERROR + RECOVERED pair to masters every check interval.
- **Decision** (user): only a connection-level failure (server selection, network, closed client, authentication) is an outage: grouped, masters only, monitor status unchanged (FR-A4a, unchanged). A missing collection, query timeout (`maxTimeMS`) or other query error is a check result `ERROR` that goes through the monitor's own alert policy: type `MONITOR_ERROR`, recipients = active + masters, alert mode applies, same incident as STALE/NO_DATA (like D4), `oState.eCurrentStatus = ERROR`, recovered only by that monitor's next successful check. Such a check never ends a grouped outage.
- **Compatibility**: stored documents unchanged; `eCurrentStatus` may now hold `ERROR`. Error codes: `SOURCE_UNAVAILABLE` (outage), `SOURCE_TIMEOUT`, `SOURCE_COLLECTION_NOT_FOUND`, `SOURCE_QUERY_FAILED`.

### TD-30 · Check interval at most 24 hours — Accepted (2026-11-18, review H1)

- **Context**: Node fires any `setTimeout` above 2^31−1 ms (≈24.8 days) after 1 ms; intervals up to 10 000 h were accepted.
- **Decision** (user): `MAX_CHECK_INTERVAL_MIN` (default and upper bound 1440) enforced by the form/API schema and config; the scheduler also refuses (logs `check.scheduleRefused`, does not re-arm) any delay above the Node limit. Stored monitors with longer intervals still load; above the Node limit they run once at start and are not re-armed until edited.

### TD-31 · Monitor DB indexes are created at every startup — Accepted (2026-11-18, review M4)

- **Decision** (user): `ensureMonitorDbIndexes` (idempotent `createIndex`) runs at startup in every environment; on failure `app.indexesFailed` is logged at fatal and startup stops. Source DB indexes are never created or modified. Supersedes the "not silently on every boot in production" recommendation in database-design B.4.

### TD-32 · Dispatcher claim token and send deadline; lease watchdog — Accepted (2026-11-18, review M6/M1)

- **Decision**: `claimNext` stores a random `sClaimId`; `markSent/markRetry/markFailed` match on it, so a dispatcher whose claim expired cannot overwrite the outcome written by the one that took over (`alert.claimLost` is logged). One send has an overall deadline of 2 × `SMTP_TIMEOUT_MS` (config requires `DISPATCHER_LOCK_MS` above it). Delivery stays at-least-once: an abandoned send may still be delivered by the server.
- **Lease**: the fence is `request start + LEASE_TTL_MS − LEASE_RENEW_MS`; `isHeld()` is time-based, a watchdog timer steps down at the fence even while a renewal hangs, and every lease operation is abandoned after `LEASE_RENEW_MS` (the driver's per-operation `timeoutMS` has no effect in mongodb 7).

### TD-33 · Runtime module separate from the entry point — Accepted (2026-11-18, review M10/M9)

- **Decision**: `src/runtime.ts` owns the startup order, the leader hooks (scheduler starts before the dispatcher; a failed start makes the lease release itself and retry, review H3) and shutdown; `server.ts` only creates the real clients, handles signals and exits. Shutdown releases the lease in parallel with draining HTTP; the hard exit is `SHUTDOWN_TIMEOUT_MS + send deadline + 5 s`.

### TD-35 · Product name from `APP_NAME` (visible text only) — Accepted (2026-11-19)

- **Context**: "payMonitor" was hard-coded in the UI, email subjects/footers and messages, so renaming the product meant a code change.
- **Decision** (user): one env variable `APP_NAME` (default `payMonitor`, 1–40 characters, no control characters so it cannot split an email header) read only in `src/config`. It drives what people see: page title and brand (`res.locals.appName`, printed with `<%= %>`), the email subject prefix `[<APP_NAME>] <TYPE> – <monitor>` (FR-A6, no separate prefix variable), both email footers and the body wording (`EmailContext.appName`, HTML-escaped), the no-index warning (service dependency) and the startup log message. The log `event` names do not change.
- **Not changed on purpose**: MongoDB `appName` connection labels, the log `service` field, the default DB name `paymonitor` (a rename would point at an empty database; `MONGO_DB_NAME` exists for that), the `window.payMonitorApi` browser global, the bcrypt timing constant, the `pm.sid` cookie, code comments and docs.
- **Consequences**: with `APP_NAME` unset every output is identical to before. Alerts already stored keep the old name because subject and body are rendered and stored at creation (FR-A1), including on Resend. Mail filters on the old subject prefix stop matching after a rename. The sender display name stays in `MAIL_FROM` and must be changed together with `APP_NAME`.
