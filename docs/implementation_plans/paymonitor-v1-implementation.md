# payMonitor v1 — Implementation Plan

> Status: **DRAFT — awaiting approval** · Created 2026-11-18
> Implements: everything in [requirements.md](../requirements.md) (§3–§6, acceptance criteria §9).
> Follows: [architecture.md](../architecture.md), [project-structure.md](../project-structure.md), [database-design.md](../database-design.md), [api-standards.md](../api-standards.md), [security.md](../security.md), [testing-strategy.md](../testing-strategy.md), [coding-standards.md](../coding-standards.md), TD-01…TD-16.
> Progress tracker (resume point for interrupted sessions): [../implementation_progress.md](../implementation_progress.md).

**Goal of this plan:** when all phases are done, you run one command (`npm run sandbox`), open the dashboard, and test every acceptance criterion by hand. A second command (`npm run test:acceptance`) checks the same criteria automatically. You don't need a local MongoDB, an SMTP server or Docker.

---

## Contents

0. [How to use this plan](#0-how-to-use-this-plan)
1. [Decisions to confirm before coding](#1-decisions-to-confirm-before-coding)
2. [End state: how you will run and test it](#2-end-state-how-you-will-run-and-test-it)
3. [Configuration (full env schema)](#3-configuration-full-env-schema)
4. [Core algorithms (exact behaviour)](#4-core-algorithms-exact-behaviour)
5. [Phases](#5-phases)
6. [Manual acceptance runbook](#6-manual-acceptance-runbook)
7. [Doc updates this plan requires](#7-doc-updates-this-plan-requires)
8. [Risks and mitigations](#8-risks-and-mitigations)

Appendices (the reference contracts that the phases point to):

- [A. Data model: stored docs ↔ domain types](#appendix-a--data-model-stored-docs--domain-types)
- [B. State machines](#appendix-b--state-machines)
- [C. Route catalogue](#appendix-c--route-catalogue)
- [D. Validation catalogue](#appendix-d--validation-catalogue)
- [E. Composition root and module dependencies](#appendix-e--composition-root-and-module-dependencies)
- [F. Startup, shutdown and failure modes](#appendix-f--startup-shutdown-and-failure-modes)
- [G. Log event catalogue](#appendix-g--log-event-catalogue)
- [H. Email content specification](#appendix-h--email-content-specification)
- [I. Pages and view-models](#appendix-i--pages-and-view-models)
- [J. Security controls → code location](#appendix-j--security-controls--code-location)
- [K. Definition of Done (every change)](#appendix-k--definition-of-done-every-change)

---

## 0. How to use this plan

- Work through the phases in order. Each phase ends in a state that compiles, passes its tests and can be run. Don't start a phase until the previous phase's **Done when** list is all ticked.
- After each phase, run the quality gates (testing-strategy §5) and tick the phase in `docs/implementation_progress.md`. Record the commands you ran and their real results.
- Each phase is roughly one reviewable change (one commit or PR, made only when the user asks).
- File lists show **what** to create. Signatures and algorithms show the **contract**. Write the implementation to match them.
- If a step needs behaviour that isn't in `requirements.md` or in §1 below, stop and ask. Don't invent it.

---

## 1. Decisions to confirm before coding

The requirements leave these points open, but the code needs an answer. Each has a **default** that this plan is written against. Confirm or change each one in Phase 0. Every change of default must be reflected in this plan before the affected phase starts.

| #   | Question                                                                                                                    | Default used in this plan                                                                                                                                                                                                                              | Affects   |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| D1  | Approve installing the dependency list in testing-strategy §6?                                                              | Yes, the full list as written.                                                                                                                                                                                                                         | Phase 1   |
| D2  | CSRF library: `csrf-sync` (session-backed) or `csrf-csrf` (double-submit)?                                                  | `csrf-sync` (TD-11)                                                                                                                                                                                                                                    | Phase 3   |
| D3  | Password policy for dashboard users                                                                                         | Min 12 chars, max 72 **bytes** (the bcrypt limit)                                                                                                                                                                                                      | Phase 3   |
| D4  | A webhook monitor goes STALE → NO_DATA (or the reverse) without passing in between. Same incident or a new one?             | **Same incident.** No new "open" email. Reminders use the alert type of the current result.                                                                                                                                                            | Phase 8   |
| D5  | `Every check` mode: does it record incidents (for the detail page) even though it sends no recovery email?                  | **Yes.** It opens and closes incidents for history, emails every failing check and sends no RECOVERED email.                                                                                                                                           | Phase 8   |
| D6  | FR-A4a grouping: how long to wait before the `MONITOR_ERROR` email goes out so that more affected monitors can join it?     | New config `SOURCE_ERROR_GROUP_WINDOW_MS`, default `60000`. Monitors that fail after the email has gone out are added to the incident (visible on the dashboard) but don't trigger another email.                                                      | Phase 8   |
| D7  | Deleting a monitor that has an open incident                                                                                | Close the incident with `eCloseReason: 'MONITOR_DELETED'` and send **no** RECOVERED email.                                                                                                                                                             | Phase 5/6 |
| D8  | When to run the first check                                                                                                 | Run immediately on **create** and **resume**. On **edit**, the next run is `lastCheckAt + new interval`, or now if that time has passed.                                                                                                               | Phase 9   |
| D9  | The index warning (§5) asks for a "descending index on the timestamp key". Does an ascending single-field index also count? | **Yes.** MongoDB walks a single-field index in either direction. The warning shows only when **no** index has the key as its first field.                                                                                                              | Phase 5   |
| D10 | New internal tunables (requirements §5.1 rule: no hard-coded tunables)                                                      | Add the keys in §3 marked **NEW** to requirements §5.1.                                                                                                                                                                                                | Phase 2   |
| D11 | Dev email delivery                                                                                                          | New `MAIL_TRANSPORT=smtp\|outbox`. In `outbox` mode, emails are written as `.eml` files to `MAIL_OUTBOX_DIR`, so no real email is ever sent in dev.                                                                                                    | Phase 8   |
| D12 | Where to keep "last alert time" and "reminder count"                                                                        | On the **incident** document (`dLastAlertAt`, `nReminderCount`), since database-design B.2 already makes incidents the source of truth. The `oState` copies listed in database-design are dropped.                                                     | Phase 7/8 |
| D13 | Alert retry counter after a manual resend                                                                                   | New field `nRetryIndex`. Resend resets it to 0, so a resent alert gets the full backoff list again. `aAttempts` keeps the full history.                                                                                                                | Phase 8   |
| D14 | "Run check now" on a **paused** monitor                                                                                     | **Allowed.** The check is stored with `MANUAL` and alert rules apply (FR-D3 says it works "the same way a scheduled run does"). The monitor stays paused.                                                                                              | Phase 9   |
| D15 | Editing a monitor while its incident is open                                                                                | **The incident stays open.** The next check decides, using the new config (threshold, mode, interval). No email is sent because of the edit itself.                                                                                                    | Phase 5/6 |
| D16 | User management details                                                                                                     | Admins set a password on create. On edit, the password field is optional (blank = unchanged). Activate/deactivate is the `isActive` checkbox on the edit form, with no separate routes. There's no self-service password change (not in requirements). | Phase 3   |
| D17 | Can a NORMAL recipient be changed to MASTER?                                                                                | **Yes, one way only** (NORMAL → MASTER). MASTER → NORMAL is refused (FR-R3). Admins may also create MASTER recipients directly (FR-R1 lists both types).                                                                                               | Phase 4   |
| D18 | Resending an alert that was stored `FAILED` with "no recipients"                                                            | Resend keeps the stored recipient list (FR-A5), **except** when that list is empty: then it re-resolves the current recipients. If that is still empty, it stays FAILED.                                                                               | Phase 8   |
| D19 | Subject for alerts that aren't about one monitor (grouped `MONITOR_ERROR` and its `RECOVERED`)                              | `[payMonitor] MONITOR_ERROR – Source DB (<n> monitors)` / `[payMonitor] RECOVERED – Source DB`.                                                                                                                                                        | Phase 8   |

Recommendation: accept all the defaults. Each one follows the existing docs closely and keeps the code simple.

---

## 2. End state: how you will run and test it

### 2.1 One-time setup (after Phase 1)

```bash
cd watchServer
npm ci                       # installs the approved dependencies (D1)
cp .env.example .env         # sandbox mode needs NO edits; real mode: fill values
```

### 2.2 Sandbox mode (no MongoDB, SMTP or Docker needed)

```bash
npm run sandbox
```

`scripts/sandbox/sandbox.ts` does the following:

1. Refuses to start when `NODE_ENV=production`.
2. Starts **two** `mongodb-memory-server` instances, with data kept in `.sandbox/` so it survives restarts:
   - Monitor DB on port `27101`
   - Source DB on port `27102`, database `jojo_source_sandbox`
3. Seeds the sandbox Source DB, and only that one, with the 5 launch collections (requirements §6) plus `empty_webhooks`. Each collection gets a few `{ dCreatedAt: Date }` docs:
   - `razor_pay_webhook_data`: newest doc 1 min old (a fresh monitor)
   - `apple_pay_webhook_data`: newest doc 3 h old (stale for a 2 h threshold)
   - `amazon_pay_webhook_data`: no index, to trigger the index warning (D9)
   - `empty_webhooks`: empty, to test the FR-W2 warning and NO_DATA
   - `bad_ts_webhooks`: `dCreatedAt: "not-a-date"`, so FR-W2 rejects it
4. Starts a **fake endpoint server** on `127.0.0.1:4010`:
   - `GET /ok` returns 200
   - `GET /fail` returns 500
   - `GET /slow` never answers (tests the timeout)
   - `GET /flaky` returns 500 once, then 200
   - `GET /redirect-loop` keeps redirecting
   - `GET /switch` returns whatever was set last with `sandbox:ctl`
5. Starts a **control server** on `127.0.0.1:4011`, localhost only, used by `npm run sandbox:ctl`.
6. Sets the env for the child app:
   - `MONGO_URI`, `SOURCE_MONGO_URI` and `SOURCE_DB_NAME` pointing at the sandbox servers
   - `MAIL_TRANSPORT=outbox`
   - The seed admin `admin@sandbox.local` / `sandbox-admin-pass` and the master recipient `master@sandbox.local`. These are throwaway sandbox values, documented as such.
   - Then it starts `src/server.ts` (via `tsx watch`).
7. Prints the login URL, the credentials and the control commands.

Control commands (from a second terminal):

```bash
npm run sandbox:ctl -- insert-webhook razor_pay_webhook_data   # new doc now → recovery
npm run sandbox:ctl -- source-down                              # stop Source DB → MONITOR_ERROR
npm run sandbox:ctl -- source-up                                # restart it → RECOVERED (masters)
npm run sandbox:ctl -- endpoint-status 500                      # /switch returns 500
npm run sandbox:ctl -- endpoint-status 200
npm run sandbox:ctl -- mail-down                                # outbox transport throws (SMTP down)
npm run sandbox:ctl -- mail-up
npm run sandbox:ctl -- outbox                                   # list emails "sent" (subject, to, time)
npm run sandbox:ctl -- reset                                    # wipe .sandbox/ and re-seed (asks y/N)
```

Emails appear as `.eml` files in `.sandbox/outbox/`. They open directly in macOS Mail or Quick Look.

### 2.3 Real mode (your own Mongo and SMTP sandbox)

```bash
# .env: MONGO_URI (dev DB), SOURCE_MONGO_URI (read-only user), SMTP_* (Mailtrap or similar), etc.
npm run db:indexes      # creates Monitor DB indexes only (never touches Source DB)
npm run dev             # tsx watch, pretty logs
npm run build && npm start   # production-like run from dist/
```

### 2.4 Automated tests

```bash
npm run typecheck && npm run lint && npm run format:check
npm test                    # unit + integration (mongodb-memory-server, local HTTP server, fake mailer)
npm run test:acceptance     # tests/acceptance/*: one test per requirements §9 criterion
npm run build
```

### 2.5 `package.json` scripts (final)

| Script                    | Command                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `dev`                     | `tsx watch --clear-screen=false src/server.ts \| pino-pretty`                                             |
| `sandbox`                 | `tsx scripts/sandbox/sandbox.ts`                                                                          |
| `sandbox:ctl`             | `tsx scripts/sandbox/ctl.ts`                                                                              |
| `build`                   | `tsc -p tsconfig.build.json && node scripts/copy-assets.mjs` (copies `src/views`, `src/public` → `dist/`) |
| `start`                   | `node dist/server.js`                                                                                     |
| `db:indexes`              | `tsx scripts/ensure-indexes.ts`                                                                           |
| `typecheck`               | `tsc --noEmit -p tsconfig.test.json`                                                                      |
| `lint`                    | `eslint .`                                                                                                |
| `format` / `format:check` | `prettier --write .` / `prettier --check .`                                                               |
| `test`                    | `NODE_OPTIONS=--experimental-vm-modules jest --selectProjects unit integration`                           |
| `test:acceptance`         | `NODE_OPTIONS=--experimental-vm-modules jest --selectProjects acceptance --runInBand`                     |
| `test:all`                | `NODE_OPTIONS=--experimental-vm-modules jest --runInBand`                                                 |

---

## 3. Configuration (full env schema)

`src/config/env.schema.ts` (Zod) parses `process.env` once, and `src/config/index.ts` exports `config` as a frozen typed object. If parsing fails, startup logs every bad variable **name** with a reason (never the value) and calls `process.exit(1)`.

`process.loadEnvFile('.env')` runs only if `.env` exists and `NODE_ENV !== 'production'` (TD-14).

| Env var                                         | Zod rule                                                      | Default                 | `config` path                                              |
| ----------------------------------------------- | ------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------- |
| `NODE_ENV`                                      | `development\|test\|production`                               | `development`           | `env`                                                      |
| `PORT`                                          | int 1–65535                                                   | `3000`                  | `http.port`                                                |
| `TRUST_PROXY` **NEW**                           | int ≥ 0 (hops)                                                | `0`                     | `http.trustProxyHops`                                      |
| `LOG_LEVEL` **NEW**                             | pino levels                                                   | `info`                  | `log.level`                                                |
| `MONGO_URI`                                     | url string, required                                          | —                       | `monitorDb.uri`                                            |
| `MONGO_DB_NAME` **NEW**                         | `^[A-Za-z0-9_-]{1,64}$`                                       | `paymonitor`            | `monitorDb.name`                                           |
| `SOURCE_MONGO_URI`                              | required                                                      | —                       | `sourceDb.uri`                                             |
| `SOURCE_DB_NAME`                                | required                                                      | —                       | `sourceDb.name`                                            |
| `SOURCE_QUERY_TIMEOUT_MS`                       | int 100–60000                                                 | `10000`                 | `sourceDb.queryTimeoutMs`                                  |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` | required when `MAIL_TRANSPORT=smtp` (superRefine)             | —                       | `mail.smtp.*`                                              |
| `SMTP_SECURE` **NEW**                           | `true\|false`                                                 | `false`                 | `mail.smtp.secure`                                         |
| `MAIL_FROM`                                     | email or `Name <email>`                                       | —                       | `mail.from`                                                |
| `MAIL_TRANSPORT` **NEW** (D11)                  | `smtp\|outbox`                                                | `smtp`                  | `mail.transport`                                           |
| `MAIL_OUTBOX_DIR` **NEW**                       | path                                                          | `./.sandbox/outbox`     | `mail.outboxDir`                                           |
| `SESSION_SECRET`                                | string ≥ 32 chars                                             | —                       | `session.secret`                                           |
| `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`        | optional (needed only when `users` is empty, checked at boot) | —                       | `seed.admin`                                               |
| `MASTER_ALERT_EMAIL`/`MASTER_ALERT_NAME`        | optional (needed only when no master exists)                  | —                       | `seed.master`                                              |
| `DASHBOARD_BASE_URL`                            | http(s) URL, no trailing slash                                | `http://localhost:3000` | `dashboardBaseUrl`                                         |
| `ENDPOINT_TIMEOUT_MS`                           | int 100–120000                                                | `10000`                 | `endpoint.timeoutMs`                                       |
| `ENDPOINT_RETRY_DELAY_MS`                       | int 0–60000                                                   | `5000`                  | `endpoint.retryDelayMs`                                    |
| `ENDPOINT_MAX_REDIRECTS`                        | int 0–20                                                      | `5`                     | `endpoint.maxRedirects`                                    |
| `ENDPOINT_MAX_RETRY_COUNT`                      | int 0–10                                                      | `5`                     | `endpoint.maxRetryCount`                                   |
| `ENDPOINT_DEFAULT_RETRY_COUNT`                  | int, ≤ max (superRefine)                                      | `2`                     | `endpoint.defaultRetryCount`                               |
| `EMAIL_RETRY_BACKOFF_MIN`                       | `^\d+(,\d+)*$`, each value 1–1440                             | `1,5,15`                | `email.retryBackoffMs: number[]` (converted to ms)         |
| `DAYS_PER_MONTH`                                | int 28–31                                                     | `30`                    | `durations.daysPerMonth`                                   |
| `MIN_CHECK_INTERVAL_MIN`                        | int ≥ 1                                                       | `1`                     | `durations.minCheckIntervalMs`                             |
| `TIMEZONE`                                      | valid IANA zone (checked with `Intl.DateTimeFormat`)          | `UTC`                   | `display.timeZone`                                         |
| `LOGIN_RATE_LIMIT`                              | `^(\d+) per (\d+) (min\|hour)$`                               | `5 per 15 min`          | `rateLimit.login: { max, windowMs }`                       |
| `ACTION_RATE_LIMIT` **NEW**                     | same format                                                   | `10 per 1 min`          | `rateLimit.action` (run now, test email; api-standards §6) |
| `SOURCE_ERROR_GROUP_WINDOW_MS` **NEW** (D6)     | int 0–600000                                                  | `60000`                 | `alerts.sourceErrorGroupWindowMs`                          |
| `DISPATCHER_POLL_MS` **NEW**                    | int 1000–60000                                                | `10000`                 | `alerts.dispatcherPollMs`                                  |
| `DISPATCHER_LOCK_MS` **NEW**                    | int 30000–600000                                              | `120000`                | `alerts.dispatcherLockMs` (must exceed the SMTP timeout)   |
| `SMTP_TIMEOUT_MS` **NEW**                       | int 1000–120000                                               | `15000`                 | `mail.smtp.timeoutMs` (api-standards §7)                   |
| `LEASE_TTL_MS` / `LEASE_RENEW_MS` **NEW**       | ints, renew < ttl/2 (superRefine)                             | `45000` / `15000`       | `scheduler.lease*` (TD-05)                                 |
| `SHUTDOWN_TIMEOUT_MS` **NEW**                   | int                                                           | `15000`                 | `shutdownTimeoutMs`                                        |
| `SESSION_MAX_AGE_MS` **NEW**                    | int                                                           | `28800000` (8 h)        | `session.maxAgeMs` (security §2.5)                         |

`.env.example` lists every key with a safe placeholder and a one-line comment. It contains **no** real values.

---

## 4. Core algorithms (exact behaviour)

These are the parts where a bug sends wrong emails or no email at all. Each is a pure function, or a small service with injected dependencies, and each has the tests listed in Phase 7/8/9.

### 4.1 Durations: `src/utils/duration.ts`

```ts
export const UNIT_MS = { MINUTE: 60_000, HOUR: 3_600_000, DAY: 86_400_000, WEEK: 604_800_000 } as const;
export function toMs(d: { value: number; unit: DurationUnit }, daysPerMonth: number): number; // MONTH = daysPerMonth × DAY
export function toStoredDuration(d: Duration, daysPerMonth: number): StoredDuration; // TD-08 { nValue, eUnit, nMs }
export function formatHumanDuration(ms: number): string; // "3 h 12 min", "2 d 4 h", "45 s", "0 s"; at most 2 parts
```

### 4.2 Timestamp parsing: `src/utils/timestamp.ts` (database-design A.3)

`parseSourceTimestamp(value: unknown, now: Date): { ok: true; date: Date } | { ok: false; reason: 'MISSING' | 'INVALID_TYPE' | 'INVALID_DATE' | 'FUTURE' }`

- `undefined`/`null` → `MISSING`
- A `Date` → valid if `!isNaN`
- A `string` → must match an ISO-8601 regex, then `Date.parse`
- A `number` → `< 1e11` is seconds (×1000), otherwise milliseconds; a negative number is `INVALID_DATE`
- Any date later than `now + 1 day` → `FUTURE`

### 4.3 Staleness: `modules/webhookMonitors/staleness.evaluator.ts`

```ts
evaluateStaleness({ latest: LatestDoc | null, thresholdMs, now }):
  | { result: 'OK' | 'STALE'; lastDocId; lastDocTimestamp; ageMs }
  | { result: 'NO_DATA'; reason: 'EMPTY_COLLECTION' | 'MISSING' | 'INVALID_TYPE' | 'INVALID_DATE' | 'FUTURE'; lastDocId? }
```

`ageMs = now − ts`. The result is `OK` when `ageMs ≤ thresholdMs` and `STALE` otherwise (FR-W3). `ERROR` never comes from here: the runner sets it when `sourceData` throws.

### 4.4 Endpoint probe: `modules/endpointMonitors/httpProbe.ts` (FR-E2, TD-12, security §2.9)

```ts
probeOnce(url, { timeoutMs, maxRedirects }, deps: { fetch, lookup }) → Attempt
  // Attempt = { attempt, statusCode?, responseTimeMs, errorCode?, errorMessage? }
probe(url, { retryCount, retryDelayMs, timeoutMs, maxRedirects }, deps: { fetch, lookup, sleep, clock })
  → { isUp: boolean; attempts: Attempt[] }
```

- One `AbortSignal.timeout(timeoutMs)` covers the whole attempt, including redirects.
- Before each hop: `lookup(host, { all: true })`. If any address is in the blocked list (`169.254.0.0/16`, `fd00:ec2::254`, `100.100.100.200`), the attempt fails with `errorCode: 'BLOCKED_ADDRESS'`.
- `fetch(url, { method: 'GET', redirect: 'manual', signal })`. For a 3xx with `Location`, resolve it against the current URL, accept only `http:`/`https:`, and count the hop. Going past `maxRedirects` gives `TOO_MANY_REDIRECTS`.
- Always call `await res.body?.cancel()`. The body is never read.
- Error codes: `TIMEOUT` (Abort/TimeoutError), `DNS_ERROR` (ENOTFOUND/EAI_AGAIN), `CONNECTION_REFUSED`, `CONNECTION_RESET`, `TLS_ERROR`, `NETWORK_ERROR`. The `errorMessage` is a short safe text, never a raw stack.
- The check passes only when `statusCode === 200` on the final response. It stops at the first passing attempt. `retryCount + 1` attempts at most, with `sleep(retryDelayMs)` between them. `isUp = attempts.some(a => a.statusCode === 200)`.

### 4.5 Alert decision policy: `modules/alerts/alert.policy.ts` (FR-A3, D4, D5, D12)

```ts
decideAlert({
  result: 'OK' | FailingResult,                // FailingResult = 'STALE' | 'NO_DATA' | 'DOWN'  (ERROR never reaches here)
  openIncident: { openedAt: Date; lastAlertAt: Date | null; reminderCount: number } | null,
  alertMode, repeatIntervalMs: number | null, now: Date,
}): { incident: 'OPEN' | 'KEEP' | 'CLOSE' | 'NONE'; email: Email | null }
// Email = { kind: 'FAILURE' } | { kind: 'REMINDER'; reminderNumber: number } | { kind: 'RECOVERED'; downtimeMs: number }
```

| Mode               | Open incident?                                                                             | Result                                          | → incident | → email                                        |
| ------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------- | ---------------------------------------------- |
| any                | no                                                                                         | OK                                              | NONE       | —                                              |
| any                | no                                                                                         | failing                                         | OPEN       | FAILURE                                        |
| any                | yes, `lastAlertAt === null` (crash after the incident opened, before the alert was stored) | failing                                         | KEEP       | FAILURE (same dedupe key, so it is idempotent) |
| ONCE_WITH_RECOVERY | yes                                                                                        | failing                                         | KEEP       | —                                              |
| ONCE_WITH_RECOVERY | yes                                                                                        | OK                                              | CLOSE      | RECOVERED (`now − openedAt`)                   |
| EVERY_CHECK        | yes                                                                                        | failing                                         | KEEP       | FAILURE                                        |
| EVERY_CHECK        | yes                                                                                        | OK                                              | CLOSE      | — (D5)                                         |
| REPEAT_EVERY       | yes                                                                                        | failing, `now − lastAlertAt ≥ repeatIntervalMs` | KEEP       | REMINDER (`reminderCount + 1`)                 |
| REPEAT_EVERY       | yes                                                                                        | failing, under the interval                     | KEEP       | —                                              |
| REPEAT_EVERY       | yes                                                                                        | OK                                              | CLOSE      | RECOVERED                                      |

The alert type comes from the current result: STALE → `WEBHOOK_STALE`, NO_DATA → `WEBHOOK_NO_DATA`, DOWN → `ENDPOINT_DOWN`.

Dedupe keys (TD-09):

- FAILURE in ONCE/REPEAT mode: `incident:<id>:open`
- EVERY_CHECK: `check:<checkId>:every`
- Reminders: `incident:<id>:reminder:<n>`
- Recovery: `incident:<id>:recovered`

### 4.6 Applying a check result: `modules/alerts/alerts.service.ts → processCheckOutcome()`

The order matters for crash safety (store first, FR-A1):

1. `checks.record(check)` → `checkId` (already done by the runner).
2. If the result is not `ERROR`, call `handleSourceHealthy(now)` (webhook monitors only, §4.7).
3. `incident = incidents.findOpen(monitorId)`.
4. `decision = decideAlert(...)`.
5. `OPEN` → `incidents.open(...)`. The unique partial index means a duplicate re-reads the existing incident.
6. If `email`:
   - Build the snapshot and resolve recipients: active normal recipients plus all masters (FR-A5).
   - Render the subject and bodies (FR-W4/E3/A6).
   - `alerts.insertPending({ dedupeKey, … })`. A duplicate key counts as done.
   - If the recipient list is empty, insert the alert directly as `FAILED` with `sFailureReason: 'no recipients'`.
7. After the alert is stored: `incidents.markAlerted(incidentId, now, reminderCount?)`. This sets `dLastAlertAt` and `nReminderCount`.
8. `CLOSE` → `incidents.close(incidentId, now, 'RECOVERED')`. This runs **after** the RECOVERED alert is stored.
9. The runner updates the monitor's `oState` (`eCurrentStatus`, `dLastCheckAt`, `dNextCheckAt`, `iLastCheckId`, `iOpenIncidentId`) with one `$set` on `oState.*` only.
10. `dispatcher.nudge()`.

### 4.7 Source DB outage: `alerts.service → handleSourceError / handleSourceHealthy` (FR-A4a, D6)

`handleSourceError({ monitorSnapshot, checkId, now })`:

1. Find or open the `SOURCE_ERROR` incident (unique partial index → only one can be open). Add the monitor with `$addToSet aAffectedMonitorIds`.
2. Recipients are **masters only**.
3. Upsert the alert with key `sourceError:<incId>:open`:
   - **New** → `PENDING`, `dNextAttemptAt = incident.dOpenedAt + sourceErrorGroupWindowMs`, body lists the affected monitors.
   - **Already exists** and `eStatus: 'PENDING'` and not locked → conditional `findOneAndUpdate` that re-renders the body with the current affected list.
   - **Already sent** → no change.
4. The monitor's incident and its `oState.eCurrentStatus` are **not** touched. Only `oState.dLastCheckAt`, `oState.iLastCheckId` and `oState.eLastResult = 'ERROR'` are updated, so the dashboard can show ERROR.

`handleSourceHealthy(now)`: if a `SOURCE_ERROR` incident is open, close it and insert a `RECOVERED` alert (`sourceError:<id>:recovered`, masters only, with the downtime and the affected monitors). Any webhook check that reaches the Source DB successfully calls this, whatever its own result.

While a monitor's checks return ERROR, `decideAlert` is never called for it. Its open incident (if any) gets no reminders and no recovery during the outage. The first non-ERROR check resumes the normal policy: a reminder is due at once if the interval has passed, and a recovery goes out if the check passes.

Dashboard status: `PAUSED` if disabled. Otherwise `oState.eLastResult` (so ERROR shows during an outage). A failing state such as STALE comes back on the next good check.

### 4.8 Dispatcher: `modules/alerts/alerts.dispatcher.ts` (FR-A1, FR-A2, architecture §5.3)

- `start()`: runs one claim loop immediately (this resumes PENDING/RETRYING alerts after a crash), then every `dispatcherPollMs`. `nudge()` triggers a run early. Only one loop runs at a time (guarded by a flag).
- Claim: `findOneAndUpdate({ eStatus: { $in: ['PENDING','RETRYING'] }, dNextAttemptAt: { $lte: now }, $or: [{ dLockedUntil: null }, { dLockedUntil: { $lt: now } }] }, { $set: { dLockedUntil: now + lockMs } }, { sort: { dNextAttemptAt: 1 }, returnDocument: 'after' })`. It keeps claiming until nothing is due.
- Send through `mailer.send({ to, subject, text, html })`, then push the outcome onto `aAttempts`:
  - **Success** → `eStatus: 'SENT'`, `dSentAt`, `sMessageId`, `dLockedUntil: null`
  - **Failure, `nRetryIndex < backoff.length`** → `RETRYING`, `dNextAttemptAt = now + backoff[nRetryIndex]`, `nRetryIndex + 1`
  - **Failure, retries used up** → `FAILED`, `sFailureReason` = safe error text, logged at `error`
- `resend(alertId)`: conditional update `{ _id, eStatus: 'FAILED' }` → `PENDING`, `nRetryIndex: 0`, `dNextAttemptAt: now`, then `nudge()`. A second click on an alert that's no longer FAILED returns `ConflictError` (409).
- Runs only while this process holds the lease (§4.9).

### 4.9 Scheduler and lease: `src/scheduler/`

`leaseLock.ts` (TD-05, database-design `scheduler_locks`):

- `acquireOrRenew()` updates `{ _id: 'scheduler', $or: [{ sOwnerId: me }, { dExpiresAt: { $lt: now } }] }` with upsert. Duplicate key 11000 means another process holds it.
- A `setTimeout` chain runs every `leaseRenewMs` and emits `acquired` and `lost`.
- **Self-fencing:** if renewal keeps failing (for example, the Monitor DB is unreachable), the holder emits `lost` once `now ≥ lastRenewedAt + leaseTtlMs − leaseRenewMs`. That is **before** the lease can expire for another process, so two leaders never overlap.
- `release()` on shutdown: `deleteOne({ _id: 'scheduler', sOwnerId: me })`.

`scheduler.ts`:

```ts
createScheduler({ runners: { WEBHOOK, ENDPOINT }, loadMonitor, listEnabledMonitors, onScheduled, clock, logger, config })
  // onScheduled(type, id, nextRunAt | null) → the monitor service sets oState.dNextCheckAt (null on remove)
  start(): Promise<void>       // FR-S3: load all enabled → run each now (concurrency cap 5) → schedule next
  upsert(type, id, reason: 'CREATE'|'EDIT'|'RESUME'): Promise<void>   // FR-S1, D8
  remove(type, id): void       // pause/delete
  runNow(type, id, trigger: 'MANUAL'): Promise<CheckResultView>       // shares the in-flight guard → ConflictError ALREADY_RUNNING
  stop(): Promise<void>        // clear timers, await in-flight (≤ shutdownTimeoutMs)
  state(): 'leader' | 'standby' | 'stopped'
```

- Uses one `setTimeout` per monitor, keyed `${type}:${id}`. The next run is `startedAt + intervalMs`, so delays don't pile up. A missed run is not replayed (FR-S3).
- In-flight `Set`: a scheduled run that would overlap is skipped and logged with `event: 'check.skipped'` (FR-S2).
- Each run is wrapped in `try/catch`. A failure is logged and the next run is still scheduled (FR-S4).
- Lease `lost` → `stop()` scheduling and the dispatcher, then retry. Lease `acquired` → `start()`.
- When this process is on standby, `runNow` returns 409 `SCHEDULER_STANDBY`.

---

## 5. Phases

Legend: 🧪 = tests that must exist at the end of the phase (critical areas from testing-strategy §2 are marked **[C]**).

### Phase 0: Approvals (no code)

- [ ] Confirm D1–D19 (§1). Update this plan if any default changes.
- [ ] Approve the dependency install (D1).
- **Done when:** decisions are recorded in `docs/implementation_progress.md` and `docs/technical-decisions.md` (new TD entries, §7).

### Phase 1: Tooling skeleton

**Create**

- `package.json`:
  - `"type": "module"`, `"engines": { "node": ">=22.12" }`, scripts from §2.5.
  - Dependencies per testing-strategy §6. Install with `npm install` (exact versions are recorded in the lockfile):
    - Runtime: `express@5`, `ejs@3`, `mongodb@6` (use the major supported by `connect-mongo`), `nodemailer`, `zod`, `pino`, `pino-http`, `helmet`, `express-session`, `connect-mongo`, `bcrypt`, `csrf-sync`, `express-rate-limit`, `chart.js@4`
    - Dev: `typescript`, `tsx`, the `@types/*` packages, `jest`, `ts-jest`, `@types/jest`, `supertest`, `@types/supertest`, `mongodb-memory-server`, `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `eslint-plugin-import-x`, `prettier`, `pino-pretty`
- `tsconfig.json` (coding-standards §1), `tsconfig.build.json` (excludes tests), `tsconfig.test.json` (`rootDir: "."`, includes `src`, `tests`, `scripts`).
- `jest.config.js` with **3 projects**: `unit` (`tests/unit`), `integration` (`tests/integration`) and `acceptance` (`tests/acceptance`). ESM preset per testing-strategy §4. The `mongodb-memory-server` binary version is pinned in the `config` field of `package.json`.
- `eslint.config.js`: flat config per coding-standards §8, plus `import-x/no-cycle` and `no-restricted-imports`:
  - `nodemailer` is allowed only in `src/notifications/email/**`.
  - Importing `src/database/sourceDb` is allowed only in `src/modules/sourceData/**`.
  - Matching `*.repository.js` paths from other modules are blocked (best effort; reviewed by hand).
- `.prettierrc`, `.prettierignore`, `.editorconfig`.
- `.env.example` (§3).
- `.gitignore`: add `.sandbox/`.
- `scripts/copy-assets.mjs` (uses `fs.cp`, no dependency).
- `src/server.ts`: temporary minimal Express app with `GET /healthz → { status: 'ok' }`. It is replaced in Phase 3.

**Done when:** `npm ci`, `typecheck`, `lint`, `format:check`, `build` and `npm start` all work, and `curl localhost:3000/healthz` returns `{"status":"ok"}`. `npm test` passes with one placeholder test (`tests/unit/smoke.test.ts`, deleted in Phase 2).

### Phase 2: Foundations (config, logger, errors, constants, utils, DB clients)

**Create**

- `src/config/env.schema.ts`, `src/config/index.ts`: §3. Exports `loadConfig(env: NodeJS.ProcessEnv): Config` (pure, testable) and `config`.
- `src/logger/index.ts`: Pino with the redaction list from the error-handling rules. Exports `createLogger(cfg)` and `logger`.
- `src/errors/`: `AppError` and its subclasses (coding-standards §7), `errorCodes.ts` (including `ALREADY_RUNNING`, `SCHEDULER_STANDBY`, `LAST_ADMIN`, `MASTER_PROTECTED`), `mongoErrors.ts` (`isDuplicateKeyError`, `toAppError`).
- `src/constants/`: `checkResult.ts`, `alertType.ts`, `alertStatus.ts`, `alertMode.ts`, `roles.ts`, `recipientType.ts`, `durationUnit.ts` (three unit sets), `checkTrigger.ts`, `monitorType.ts`, `incidentKind.ts`, `auditAction.ts`, `collections.ts` (`COLLECTIONS`), `display.ts` (display status incl. `PAUSED`). Each one is an `as const` object, a union type and a `z.enum`.
- `src/types/`: `clock.ts` (`Clock` interface + `systemClock`), `duration.ts`, `paginated.ts`.
- `src/utils/`:
  - `duration.ts`, `timestamp.ts` (§4.1, §4.2)
  - `time.ts`: `formatUtc(date, tz)` returns e.g. `2026-11-18 14:05:09 UTC`
  - `escapeHtml.ts`
  - `maskUrl.ts`: masks query values and strips credentials
  - `cursor.ts`: keyset cursor encode/decode, Zod-validated
  - `objectId.ts`: `objectIdSchema` and `toObjectId`
- `src/database/monitorDb.ts`, `src/database/sourceDb.ts`: `connect…(cfg)` → `{ client, db, close() }`. Source settings: `maxPoolSize: 5`, `readPreference: 'secondaryPreferred'`, `serverSelectionTimeoutMS: 5000`. Logs the host only.
- `src/database/indexes.ts`: `ensureMonitorDbIndexes(db)` creates every index from database-design B.1. `scripts/ensure-indexes.ts` calls it.

🧪

- `tests/unit/config/env.schema.test.ts` **[C]**:
  - Every default applies when the variable is unset.
  - An invalid `EMAIL_RETRY_BACKOFF_MIN`, `DAYS_PER_MONTH` or `ENDPOINT_TIMEOUT_MS` fails with the variable name and not its value.
  - `smtp` mode requires the `SMTP_*` variables.
  - `LOGIN_RATE_LIMIT` is parsed.
- `tests/unit/utils/duration.test.ts` **[C]**: every unit, MONTH × daysPerMonth, human format edge cases.
- `tests/unit/utils/timestamp.test.ts` **[C]**: Date, ISO, seconds vs ms epoch boundary (`1e11 − 1`, `1e11`), invalid, future.
- `tests/unit/utils/maskUrl.test.ts`, `escapeHtml.test.ts`, `cursor.test.ts`.
- `tests/integration/database/indexes.test.ts`: indexes exist; unique partial behaviour on `incidents` and `webhook_monitors`.

**Done when:** gates pass. Running `npm start` with a missing `SESSION_SECRET` exits 1 with `SESSION_SECRET: Required`.

### Phase 3: HTTP shell, auth and users

**Create**

- `src/app.ts`: `createApp(deps: AppDeps): Express`. `AppDeps` holds the services, config, logger and session store. It applies, in order:
  1. `requestContext` (requestId, `x-request-id` header)
  2. `pino-http`
  3. `helmet` (CSP from security §2.1)
  4. `express.urlencoded({ extended: true, limit: '50kb' })` and `express.json({ limit: '50kb' })`
  5. static `/public` and `/vendor/chart.js` (from `node_modules/chart.js/dist`)
  6. session (`connect-mongo` on the existing client, cookie `pm.sid`)
  7. `csrf-sync`
  8. `loadCurrentUser` (reloads the user and rejects inactive ones, security §2.3)
  9. `res.locals` (`currentUser`, `csrfToken`, `flash`, `requestId`)
  10. routers, then `notFound`, then `errorHandler`
- `src/server.ts` (final shape, filled in over the phases):
  1. config, then connect both DBs
  2. indexes (automatic when not in production; production uses `db:indexes`)
  3. seeds
  4. build services
  5. start the lease, scheduler and dispatcher
  6. `listen`
  7. signal handlers for graceful shutdown (error-handling rules, Operations)
- `src/middlewares/`:
  - `requestContext.ts`, `requireAuth.ts` (pages: 302 to `/login`; API: 401 JSON), `requireRole.ts`
  - `validate.ts` (`validate({ params, query, body })` → `res.locals.input`)
  - `csrf.ts`, `rateLimit.ts` (`loginLimiter` keyed by IP and email, `actionLimiter` keyed by user), `noStore.ts`
  - `errorHandler.ts` (JSON envelope for `/api/v1`, error pages otherwise), `notFound.ts`
- `src/views/`:
  - `layouts/main.ejs`. Pages are rendered via `renderPage(res, 'pages/x/y', viewModel)`: the helper renders the page to a string, then the layout with `body` (`src/utils/renderPage.ts`; no layout dependency).
  - `partials/{head,nav,flash,formErrors,statusBadge,pagination,emptyState}.ejs`, `errors/{403,404,500}.ejs`, `pages/auth/login.ejs`
- `src/public/css/app.css`: plain CSS, mobile first, readable tables.
- `src/public/js/confirm.js`: confirms destructive form submissions.
- `src/public/js/api.js`: `fetch` wrapper that adds `x-csrf-token` from `<meta>`.
- `modules/health/`: `health.routes.ts` with `/healthz` and `/readyz` (Monitor DB ping, Source DB ping with a 2 s timeout, scheduler state; no hostnames).
- `modules/auth/`: routes, controller, service, schemas.
  - `GET/POST /login` and `POST /logout`. The session is regenerated on login, and a failed login gets the same message whatever the reason.
  - `auth.seed.ts`: `seedFirstAdmin()` runs if `users` is empty. If the seed env vars are missing, it throws a fatal error that names them.
  - Updates `dLastLoginAt` and writes a `LOGIN` audit entry once the audit module exists (Phase 4; until then the service gets a no-op audit dependency).
- `modules/users/`: the full template (routes, controller, service, repository, mapper, schemas, types).
  - Pages: `GET /users`, `GET/POST /users/new`, `GET/POST /users/:id/edit`, `POST /users/:id/delete`. All are ADMIN only. Activation is the `isActive` checkbox on the edit form (D16).
  - Rules: email unique (409); password policy D3; bcrypt cost 12; `sPasswordHash` is never mapped into the domain type.
  - `src/utils/flash.ts`: session-backed `setFlash(req, type, text)` / `consumeFlash(req)`. No `connect-flash` dependency.
  - The last active admin can't be demoted, deactivated or deleted (`LAST_ADMIN`, 409).
  - Views: `pages/users/{list,form}.ejs`.

🧪

- `tests/helpers/`:
  - `testConfig.ts` (config built in code, never from `.env`)
  - `memoryMongo.ts` (one server per worker; a unique DB per test file)
  - `fakeClock.ts`, `factories.ts`
  - `httpAgent.ts`: a logged-in supertest agent with CSRF for `ADMIN` or `VIEWER`
- `tests/integration/http/auth.test.ts`:
  - Login success and failure; the rate limit returns 429 on the 6th attempt.
  - An inactive user is rejected, including mid-session.
  - Logout needs CSRF.
  - Unauthenticated users are redirected or get 401.
- `tests/integration/http/csrf.test.ts`: a POST without a token gets 403 `CSRF_INVALID`.
- `tests/unit/users/users.service.test.ts` **[C]**: last-admin protection, password policy, hash never returned.
- `tests/unit/users/users.mapper.test.ts` **[C]**: round-trip.
- `tests/integration/http/rbac.test.ts` **[C]**: table-driven over a **route manifest** (`tests/helpers/routeManifest.ts`). Every mutating route sends a viewer a 403. The manifest grows each phase; it starts with the users routes.

**Done when:** gates pass. `npm run dev` against any reachable Mongo lets you log in as the seed admin, create a viewer, log in as the viewer, and get a 403 on `/users/new`.

### Phase 4: Audit and recipients

**Create**

- `modules/audit/`: `audit.service.ts` exposes `record({ actor, action, entityType, entityId, before, after })` and strips `sPasswordHash`/password fields. Repository, mapper, types. Append-only: no update or delete methods exist.
  - Wire it into users and auth now.
- `modules/recipients/`: the full template.
  - Pages: `GET /recipients`, `GET/POST /recipients/new`, `GET/POST /recipients/:id/edit`, `POST /recipients/:id/delete`. All are ADMIN only (api-standards §1).
  - Rules: email unique and lower-cased.
  - Masters can't be deactivated or deleted, and their type can't be changed (`MASTER_PROTECTED`, 409). Their name and email can be edited. The "Master" badge is shown.
  - `recipients.seed.ts`: `seedMasterRecipient()` runs if no MASTER exists. Missing env → fatal error naming the vars.
  - `recipients.service.resolveAlertRecipients(kind: 'ALL' | 'MASTERS_ONLY')` returns `{ name, email, type }[]` (FR-A5, FR-A4a). This is the **only** way alerts get recipients.
  - Every change writes to audit.

🧪

- `tests/unit/recipients/recipients.service.test.ts` **[C]**: inactive normal excluded, masters always included, master protection, `MASTERS_ONLY`.
- `tests/unit/recipients/recipients.mapper.test.ts` **[C]**.
- `tests/integration/recipients/recipients.repository.test.ts`: unique email.
- `tests/unit/audit/audit.service.test.ts`: the hash is stripped.
- The RBAC manifest gets the recipient routes.

**Done when:** gates pass. In the UI you can't delete or deactivate the seeded master, and audit rows exist for each change.

### Phase 5: Source data and webhook monitor CRUD (no checks yet)

**Create**

- `modules/sourceData/` (the **only** importer of `sourceDb`):
  - `sourceData.service.ts`:
    - `listCollections(): Promise<string[]>`: `listCollections({}, { nameOnly: true })`, sorted, without `system.*`.
    - `getLatestTimestamp(collection, key): Promise<LatestDoc | null>`:
      - Runs the validations from database-design A.2 first: collection in the live list, key regex.
      - `find({}, { projection: { _id: 1, [key]: 1 }, maxTimeMS }).sort({ [key]: -1 }).limit(1)`.
      - Reads the nested path for dotted keys. Returns `{ id, rawValue }`.
    - `hasTimestampIndex(collection, key): Promise<boolean>` (D9).
  - `sourceData.errors.ts`: wraps driver errors as `ExternalServiceError` with a safe message.
  - No method takes a filter, a document or an update. The service object is frozen.
- `modules/sourceData/sourceData.routes.ts`: `GET /api/v1/source/collections` and `POST /api/v1/source/validate-timestamp-key` (ADMIN, CSRF).
- `modules/webhookMonitors/`: routes, controller, service, repository, mapper, schemas, types.
  - Pages (api-standards §1): `GET /webhook-monitors`, `GET/POST /webhook-monitors/new`, `GET /webhook-monitors/:id` (temporary detail showing the config only; completed in Phase 10), `GET/POST /webhook-monitors/:id/edit`, `POST /webhook-monitors/:id/delete`.
  - Schemas: the create and update body from FR-W1 with nested `threshold[value]`/`threshold[unit]` fields. Cross-field rules (superRefine):
    - Check interval ≥ `MIN_CHECK_INTERVAL_MIN`.
    - `repeatInterval` is required if and only if the mode is `REPEAT_EVERY`, and must be ≥ the check interval (in ms).
    - Units must come from the right unit set.
  - Service `create` and `update`:
    1. Validate the timestamp key with `sourceData.getLatestTimestamp` and `parseSourceTimestamp` (FR-W2).
       - Invalid → `ValidationError` on the field `timestampKey` with a clear message, e.g. "Field `dCreatedAt` on the newest document is not a valid date (found type string)".
       - Empty collection → save, plus a flash **warning**.
    2. Set `bHasDescIndexAtSave` from `hasTimestampIndex`. If it's false, flash the index warning.
    3. Store durations with `toStoredDuration` (TD-08).
    4. Write audit. Call `scheduler.upsert`/`remove` through an injected `schedulerPort` (no-op until Phase 9).
  - Delete: soft delete (`dDeletedAt`), close the open incident per D7 (port no-op until Phase 7), `scheduler.remove`, audit.
  - Unique name among non-deleted monitors → 409 field error.
  - Views: `pages/webhookMonitors/{list,form,detail}.ejs`.
  - `public/js/monitorForm.js`:
    - Fills the collection `<select>` from the API. If JS is off, the server pre-fills the select at render time.
    - Shows the repeat-interval field only for `REPEAT_EVERY`.
    - "Validate key" button.

🧪

- `tests/integration/sourceData/sourceData.service.test.ts`:
  - Uses a seeded second DB on the memory server.
  - Returns only `_id` and the key, even when docs hold other fields.
  - `maxTimeMS` is set. An unknown collection or a bad key (`$where`, `a..b`, 65 chars) is rejected.
  - Index detection works.
- `tests/unit/sourceData/readOnly.static.test.ts` **[C]**: reads `src/modules/sourceData/**/*.ts` and fails if any of these names appear: `insert|update|delete|replace|drop|createIndex|bulkWrite|aggregate|findOneAnd|rename|\.command\(`. It also fails if any file outside `sourceData` imports `database/sourceDb`. This is the code-level part of acceptance criterion 13.
- `tests/unit/webhookMonitors/webhookMonitors.schemas.test.ts` **[C]**: repeat-interval rules, units, min interval.
- `tests/unit/webhookMonitors/webhookMonitors.mapper.test.ts` **[C]**.
- `tests/integration/http/webhookMonitors.test.ts`:
  - Create with a valid key → 303.
  - Invalid key → 400, the form is re-rendered with the error and keeps the entered values.
  - Empty collection → saved with a warning.
  - Duplicate name → 409 message.
  - Soft-deleted monitors disappear from the list.
- The RBAC manifest gets these routes.

**Done when:** gates pass. With `npm run dev` pointed at a dev Source DB (or the sandbox from Phase 11), the dropdown lists collections, `bad_ts_webhooks` is rejected, and `amazon_pay_webhook_data` shows the index warning.

### Phase 6: Endpoint monitor CRUD and the HTTP probe

**Create**

- `modules/endpointMonitors/httpProbe.ts` (§4.4). Dependencies are injected: `fetch`, `dns.promises.lookup`, `sleep`, `clock`.
- `modules/endpointMonitors/`: routes, controller, service, repository, mapper, schemas, types. Pages mirror Phase 5 under `/endpoint-monitors`.
  - Schema (FR-E1):
    - URL: `http(s)` only, no credentials, ≤ 2048 chars.
    - `retryCount` from 0 to `ENDPOINT_MAX_RETRY_COUNT`; the form default is `ENDPOINT_DEFAULT_RETRY_COUNT`.
    - Check every: minute/hour, ≥ min.
    - Alert mode and repeat interval as in Phase 5.
  - URLs are shown masked (`maskUrl`) in lists, logs and emails. The edit form shows the full URL to admins only.
  - Delete per D7. Audit.

🧪

- `tests/integration/probe/httpProbe.test.ts` **[C]**, against a local `http.createServer` on a random port:
  - 200 → up after 1 attempt.
  - 500 on every attempt → `retryCount + 1` attempts, down.
  - Fails once then 200 → up, 2 attempts.
  - Timeout (with a small `timeoutMs`) → `TIMEOUT`.
  - Connection refused.
  - A redirect to a 200 → up.
  - Redirect loop → `TOO_MANY_REDIRECTS`.
  - A redirect to `ftp:` → error.
  - `lookup` stub returns `169.254.169.254` → `BLOCKED_ADDRESS`, also when reached through a redirect.
  - The body is never read: the server streams forever and the test still ends.
- `tests/unit/endpointMonitors/endpointMonitors.schemas.test.ts`, `…mapper.test.ts` **[C]**.
- `tests/integration/http/endpointMonitors.test.ts`. The RBAC manifest is updated.

**Done when:** gates pass. You can create and edit endpoint monitors in the UI.

### Phase 7: Checks, incidents and runners (results are recorded, no email yet)

**Create**

- `modules/checks/`:
  - Repository and service: `record(input) → Check`, `listForMonitor({ monitorId, from, to, cursor, limit })` (keyset), `series({ monitorId, type, from, to, maxPoints: 500 })` (server-side bucketing for 7d/30d, database-design B.3), `latestForMonitors(ids)`.
  - Mapper and types. The webhook check docs store `nThresholdMs`. Endpoint docs store `aAttempts`.
- `modules/incidents/`:
  - Service: `findOpen(monitorId)`, `open({ monitorId, kind, openingResult, checkId, now })` (dup-key → re-read), `markAlerted(id, now, reminderCount?)`, `close(id, now, reason)`, `listForMonitor`, `countOpen()`, plus the SOURCE_ERROR variants `findOpenSourceError()`, `openSourceError()`, `addAffectedMonitor()`.
  - Doc fields per database-design plus `dLastAlertAt`, `nReminderCount` (D12) and `eCloseReason` (`RECOVERED`/`MONITOR_DELETED`, D7).
  - Hook up the D7 port from Phases 5 and 6.
- `modules/webhookMonitors/staleness.evaluator.ts` (§4.3).
- `modules/webhookMonitors/webhookMonitors.runner.ts`: `runWebhookCheck(monitorId, trigger) → CheckResultView`.
  1. Load the monitor; skip it if it's deleted or disabled and the trigger isn't MANUAL.
  2. `startedAt = clock.now()`.
  3. Call sourceData. If it throws, the result is `ERROR` with a safe `oError`.
  4. Evaluate, record the check, then call `alertsPort.processCheckOutcome` (or `handleSourceError` for ERROR).
  5. Update `oState` per Appendix B.1.

  In Phase 7, `alertsPort` is a **no-op** that returns `{ openIncidentId: null }`. Phase 7 therefore delivers: checks are stored and `oState` shows the last result. Incidents and alerts are wired in Phase 8 by swapping the port in the composition root (Appendix E), with no runner change.

- `modules/endpointMonitors/endpointMonitors.runner.ts`: the same flow with `probe()`. The result is `OK` or `DOWN`.

🧪

- `tests/unit/webhookMonitors/staleness.evaluator.test.ts` **[C]**: `age == threshold` → OK, `threshold + 1 ms` → STALE, empty → NO_DATA, invalid, future, seconds epoch.
- `tests/integration/checks/checks.repository.test.ts`: keyset pagination order and cursor, series bucketing ≤ 500 points.
- `tests/integration/incidents/incidents.repository.test.ts`: only one open incident per monitor (concurrent `open` calls → one doc), only one open SOURCE_ERROR.
- `tests/unit/checks/checks.mapper.test.ts`, `tests/unit/incidents/incidents.mapper.test.ts` **[C]**.
- `tests/integration/runners/webhookRunner.test.ts`, `endpointRunner.test.ts`: a check is stored with every FR-H1 field, ERROR when the Source DB client is closed.

**Done when:** gates pass. Runners can be called from a test and store correct checks.

### Phase 8: Alerts, email and dispatcher (the core of the system)

**Create**

- `src/notifications/email/transport.ts`: `createMailer(cfg) → Mailer { send(msg): Promise<{ messageId }> ; verify(): Promise<void> }`.
  - `smtp`: Nodemailer with `connectionTimeout`/`socketTimeout = SMTP_TIMEOUT_MS`.
  - `outbox` (D11): Nodemailer `streamTransport` with `buffer: true`, writing `<timestamp>-<alertId>.eml` to `MAIL_OUTBOX_DIR`. If `<dir>/FAIL` exists, it throws `Error('Simulated SMTP failure')` (used by sandbox `mail-down`).
- `src/notifications/email/templates/`: `webhookStale.ts`, `webhookNoData.ts`, `endpointDown.ts`, `recovered.ts`, `reminder.ts` (part of the failure templates), `monitorError.ts`, `test.ts`, `layout.ts`. Each one is `build(vm) → { subject, text, html }` and takes plain values only.
  - The subject follows FR-A6.
  - HTML escapes every value.
  - Times use `formatUtc` with the "UTC" label (FR-D7).
  - Durations use `formatHumanDuration`.
  - The link is `${dashboardBaseUrl}/<webhook|endpoint>-monitors/<id>`.
  - Field content:
    - STALE: every FR-W4 field.
    - DOWN: every FR-E3 field.
    - RECOVERED: the downtime.
    - Reminder: how long the incident has been open and how many reminders came before.
    - MONITOR_ERROR: the affected monitors list and the safe error text.
- `modules/alerts/`:
  - `alert.policy.ts` (§4.5).
  - `alerts.service.ts`: `processCheckOutcome` (§4.6), `handleSourceError`/`handleSourceHealthy` (§4.7), `sendTestEmail(monitorSnapshot, actor)` (FR-D3; key `test:<uuid>`; recipients `ALL`; stored like any alert), `resend(alertId, actor)` (§4.8 plus audit `RESEND`).
  - Queries: `listForMonitor`, `listGlobal({ monitorId?, type?, status?, from?, to?, cursor })` (FR-D5), `countFailed()`.
  - `alerts.dispatcher.ts` (§4.8).
  - Repository (`insertPending`, `claimNext`, `markSent`, `markRetry`, `markFailed`, `requeueFailed`, `updatePendingBody`), mapper, types, schemas (`/api/v1/alerts/:id/resend`).
- Wiring: the Phase 7 runners now call the real alerts service.

🧪 (all **[C]**)

- `tests/unit/alerts/alert.policy.test.ts`: the full table in §4.5 as `test.each`, including:
  - Reminder at exactly N and at N − 1 ms.
  - Reminder numbering.
  - No RECOVERED email in EVERY_CHECK mode.
  - The `lastAlertAt === null` recovery row.
  - STALE → NO_DATA in the same incident (D4).
- `tests/unit/notifications/templates.test.ts`:
  - Subjects match FR-A6 exactly.
  - Every required field from FR-W4/E3 is present.
  - `<script>` in a monitor name is escaped in the HTML.
  - Times end with "UTC".
- `tests/integration/alerts/alerts.service.test.ts` (memory Mongo, fake mailer, FakeClock):
  - **Store first:** the alert is `PENDING` in the DB before `mailer.send` is called. The fake mailer asserts this by reading the DB inside `send`.
  - Dedupe: calling `processCheckOutcome` twice for the same check gives one alert.
  - No recipients → `FAILED` with "no recipients".
  - **Source outage:**
    - 3 monitors error inside the window → 1 incident, 1 alert listing 3 monitors, masters only.
    - A 4th monitor errors after it was sent → no new alert, but the incident lists 4.
    - The monitors' own incidents and `eCurrentStatus` are unchanged.
    - The first successful check → 1 RECOVERED alert to masters.
- `tests/integration/alerts/alerts.dispatcher.test.ts`:
  - A success sets `SENT`, `dSentAt` and `sMessageId`.
  - The mailer fails 2 times then succeeds → RETRYING, RETRYING, SENT, with `dNextAttemptAt` following the configured backoff (`[1,5,15]` min, and with `[2]` to prove the config is used).
  - Failing every time → FAILED after `backoff.length + 1` attempts.
  - Resend works only from FAILED, and a second resend gets 409.
  - Two dispatchers racing → each alert is sent once.
  - Restart resume: PENDING alerts left in the DB are sent on `start()`.

**Done when:** gates pass. Every critical alerting case in testing-strategy §2 has a passing test.

### Phase 9: Scheduler, lease and monitor actions

**Create**

- `src/scheduler/leaseLock.ts`, `src/scheduler/scheduler.ts` (§4.9).
- `src/server.ts`: wires the lease events to `scheduler.start/stop` and `dispatcher.start/stop`, plus graceful shutdown.
- The real `schedulerPort` goes into the webhook and endpoint services (FR-S1).
- `modules/monitors/` (a small action module, so each monitor module doesn't repeat the same routes): `monitorActions.routes.ts`, `monitorActions.controller.ts` and `monitorActions.service.ts`. The service delegates to the webhook or endpoint service based on `:type`.
  - `POST /api/v1/monitors/:type/:id/run`: `scheduler.runNow` (FR-D3). Returns 200 with the check result view, or 409 `ALREADY_RUNNING`/`SCHEDULER_STANDBY`. Uses `actionLimiter`.
  - `POST /api/v1/monitors/:type/:id/pause` and `/resume`: sets `bIsEnabled`, then `scheduler.remove`/`upsert('RESUME')`, then audit `PAUSE`/`RESUME`. Pausing does **not** close incidents. Idempotent.
  - `POST /api/v1/monitors/:type/:id/test-email`: `alerts.sendTestEmail` → 202 "queued". Uses `actionLimiter`.
  - `GET /api/v1/monitors/:type/:id/checks` and `/series`: Viewer role. Used by Phase 10.
- `public/js/monitorActions.js`: run-now, pause, resume and test-email buttons. Each button is disabled while its request runs, shows the result inline, and shows the error message plus the requestId.
- Update `docs/api-standards.md` §1 to add the `monitors` action module ownership.

🧪

- `tests/unit/scheduler/scheduler.test.ts` **[C]** (Jest fake timers and fake runners):
  - Every enabled monitor runs at `start()`.
  - Runs repeat at the interval.
  - A slow run makes the next tick skip and log `check.skipped`.
  - `upsert('EDIT')` changes the interval without a restart.
  - `remove` stops runs.
  - A runner throwing doesn't stop other monitors (FR-S4).
  - `stop()` waits for in-flight runs.
  - `runNow` while in flight → `ALREADY_RUNNING`.
- `tests/integration/scheduler/leaseLock.test.ts` **[C]**: a second owner can't acquire the lease, takes over after expiry, and `lost` fires when it is stolen.
- `tests/integration/http/monitorActions.test.ts`:
  - Run now returns the result and stores a check with trigger `MANUAL`.
  - Pause → the scheduler no longer holds the monitor and the incident stays open.
  - Test email → a TEST alert is stored and the response is 202.
- The RBAC manifest gets the action routes. A viewer gets 403 on run, pause, resume, test-email and resend.

**Done when:** gates pass. `npm run dev` runs the checks on schedule and sends to the outbox, and editing an interval takes effect without a restart.

### Phase 10: Dashboard pages and charts

**Create**

- `modules/dashboard/`: service and controller for `GET /`. Count cards (FR-D1): total, OK, failing, paused, open incidents, emails FAILED. A combined monitor table shows type, display status, last check, next check, and the last doc age or response time. It reads only through the other modules' services.
- Webhook and endpoint detail pages (FR-D4):
  - Config panel.
  - Current status badge.
  - History table (server-rendered first page; filters for result and date range; keyset "Older" link).
  - Incidents list (start, end, duration; open incidents show "ongoing").
  - Alerts list (type, status, recipients count with a details toggle, sent time, error, a Resend button for admins on FAILED alerts).
  - Range picker (24 h / 7 d / 30 d / custom).
  - Action buttons.
- `pages/alerts/list.ejs` + `GET /alerts` (FR-D5): filters for monitor, type, status and date range; FAILED rows highlighted; Resend button.
- `public/js/charts.js`: reads `<script type="application/json" id="chart-config">` and fetches `/series`.
  - Webhook monitors: line chart of document age, with a threshold line.
  - Endpoint monitors: response time line plus up/down markers.
  - The x-axis is labelled UTC.
- View-model builders, e.g. `webhookMonitors.view.ts`, convert domain objects into display strings (formatted UTC, human durations, `can.*` flags).

🧪

- `tests/integration/http/pages.test.ts`: each page returns 200 for both roles and contains its `<h1>`. Viewers see no admin buttons and admins do.
- `tests/integration/http/seriesApi.test.ts`: range validation, ≤ 500 points, the envelope shape.
- `tests/unit/dashboard/dashboard.service.test.ts`: count logic, including PAUSED and ERROR display.

**Done when:** gates pass. Every page in FR-D1–D7 renders and shows real data.

### Phase 11: Sandbox and acceptance suite (the "just run and test" layer)

**Create**

- `scripts/sandbox/sandbox.ts`, `scripts/sandbox/seed.ts`, `scripts/sandbox/fakeEndpoints.ts`, `scripts/sandbox/controlServer.ts`, `scripts/sandbox/ctl.ts` (§2.2).
  - Guards: refuse if `NODE_ENV=production`; the seed only connects to the URI of the memory server it started itself, never to `.env` URIs; the control server binds to `127.0.0.1` only.
  - The seeding code lives in `scripts/` and **never** in `src/modules/sourceData` (that module stays read-only).
- `tests/acceptance/` (Jest project `acceptance`). They boot the real app via `createApp` and the real services against memory servers, with a FakeClock and the fake mailer, and drive time forward. Each criterion in requirements §9 maps to one file:

| File                                | Criterion                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `01-create-webhook-monitor.test.ts` | pick a collection, invalid key rejected                                                                                               |
| `02-stale-once.test.ts`             | threshold 1 min, no new doc → exactly 1 `WEBHOOK_STALE` stored, then 1 email                                                          |
| `03-recovered.test.ts`              | new doc → 1 `RECOVERED`, incident duration shown                                                                                      |
| `04-endpoint-down.test.ts`          | 500 on all `retry+1` attempts → 1 `ENDPOINT_DOWN`; flaky → none                                                                       |
| `05-every-check.test.ts`            | every failing check → one email each                                                                                                  |
| `06-repeat-every.test.ts`           | repeat 30 min, check 10 min, 1 h outage → 1 open + about 2 reminders + 1 RECOVERED                                                    |
| `07-source-outage.test.ts`          | Source DB stopped → masters only, 1 `MONITOR_ERROR` listing the monitors, no STALE; restart → RECOVERED                               |
| `08-config-changes.test.ts`         | `loadConfig` with changed `ENDPOINT_TIMEOUT_MS`/`EMAIL_RETRY_BACKOFF_MIN`/`DAYS_PER_MONTH` changes behaviour; an invalid value throws |
| `09-smtp-down.test.ts`              | PENDING → RETRYING → FAILED; resend after recovery → SENT                                                                             |
| `10-recipients.test.ts`             | inactive gets nothing; master always gets mail and can't be deactivated or deleted                                                    |
| `11-viewer-readonly.test.ts`        | viewer reads every page and is refused (403) on every mutation (UI and API)                                                           |
| `12-live-reschedule.test.ts`        | create, edit and pause take effect without a restart                                                                                  |
| `13-source-read-only.test.ts`       | re-runs the static scan; the Source DB stays unchanged after a full run (document counts and `dbHash`-style checksum before vs after) |

- Update `README.md`: what payMonitor is, prerequisites, the §2 commands, a link to the runbook (§6), and how to point it at real Mongo/SMTP.

**Done when:** `npm run sandbox` starts with one command, every step in §6 behaves as written, and `npm run test:acceptance` passes.

### Phase 12: Hardening and handover

- [ ] Full gates: `typecheck`, `lint`, `format:check`, `test:all`, `build`, `npm audit --omit=dev` (report the findings).
- [ ] `npm run build && npm start` with a production-like env (`NODE_ENV=production`, real-mode `.env` pointing at dev resources): checks secure cookies behind HTTPS (`TRUST_PROXY`), CSP headers (`curl -I`), and that `/readyz` contains no hostnames.
- [ ] Grep check: no `console.`, no `process.env` outside `src/config`, no `<%-` except `include`, no `any`.
- [ ] Docs updated (§7). Each `docs/*.md` status moves from "Proposed" to "Implemented" where true. Update CLAUDE.md "Status".
- [ ] Final report per CLAUDE.md.

---

## 6. Manual acceptance runbook

Run `npm run sandbox`, open the printed URL, and log in as the sandbox admin. "Outbox" means `npm run sandbox:ctl -- outbox` or the `.sandbox/outbox/` folder.

| #   | Steps                                                                                                                                                                           | Expected                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Webhook monitors → New.** Open the collection dropdown. Pick `bad_ts_webhooks` with key `dCreatedAt` and save. Then pick `razor_pay_webhook_data` with `dCreatedAt` and save. | The dropdown lists the seeded collections. The first save fails with a clear key error. The second save succeeds.                                                                                                            |
| 2   | Create `Apple stale`: `apple_pay_webhook_data`, threshold **1 minute**, every 1 minute, mode Once + recovery. Wait about 1 min.                                                 | The detail page shows STALE. Alerts has 1 `WEBHOOK_STALE` with status SENT. The outbox has 1 email with subject `[payMonitor] WEBHOOK_STALE – Apple stale` and every FR-W4 field. No second email arrives at the next check. |
| 3   | `sandbox:ctl -- insert-webhook apple_pay_webhook_data`, then press Run check now.                                                                                               | OK. 1 `RECOVERED` email with the downtime. The incident shows start, end and duration.                                                                                                                                       |
| 4   | Endpoint monitor `http://127.0.0.1:4010/fail`, retry 2. Then a second one on `/flaky`.                                                                                          | `/fail` gives 1 `ENDPOINT_DOWN` with 3 attempts listed. `/flaky` stays OK with 2 attempts in history and no alert.                                                                                                           |
| 5   | Endpoint `/switch`, mode Every check, every 1 min. `sandbox:ctl -- endpoint-status 500` and wait 3 checks.                                                                      | 3 `ENDPOINT_DOWN` emails. After `endpoint-status 200`, no RECOVERED email.                                                                                                                                                   |
| 6   | Same as 5 with mode Repeat every 2 min, check every 1 min. Let it fail for about 5 min, then set it back to 200.                                                                | 1 open email, 2 reminders ("open for …", "reminder #n"), then 1 RECOVERED.                                                                                                                                                   |
| 7   | Create 3 webhook monitors. `sandbox:ctl -- source-down` and wait about 2 min. Then `source-up`.                                                                                 | Exactly 1 `MONITOR_ERROR` email, sent to `master@sandbox.local` only, listing the affected monitors. The dashboard shows ERROR. No STALE emails. After `source-up`: 1 RECOVERED to masters.                                  |
| 8   | Stop the sandbox. Set `EMAIL_RETRY_BACKOFF_MIN=abc` in `.env`, then `npm run sandbox`.                                                                                          | Startup fails, naming `EMAIL_RETRY_BACKOFF_MIN`. Put back `1,1`: retries happen 1 min apart (seen in the next row).                                                                                                          |
| 9   | `sandbox:ctl -- mail-down` and trigger any alert (Test email). Wait for all retries. `mail-up`, then press Resend.                                                              | The status goes PENDING → RETRYING → FAILED (shown red on the dashboard). Resend → SENT.                                                                                                                                     |
| 10  | Add recipient A (active) and B (inactive). Trigger a test email. Try to deactivate or delete the master.                                                                        | The email goes to A and the master, not B. The master actions are refused with a clear message.                                                                                                                              |
| 11  | As admin, create a viewer. Log in as the viewer in a private window. Try the admin URLs (`/webhook-monitors/new`), and `curl` a POST with the viewer cookie.                    | Every page is readable. No admin buttons. 403 page and 403 JSON.                                                                                                                                                             |
| 12  | Edit a monitor's interval from 1 to 2 min. Pause it, then resume it.                                                                                                            | The next-check time updates right away. No checks run while paused. The check runs immediately on resume. No restart needed.                                                                                                 |
| 13  | `grep -rnE "insert                                                                                                                                                              | update                                                                                                                                                                                                                       | delete | drop | createIndex" src/modules/sourceData` | No matches. Real deployment: confirm the Source DB user has the `read` role only (`db.getUser()` in mongosh, run by the DB owner). |

---

## 7. Doc updates this plan requires

Make each update in the phase where the behaviour lands (CLAUDE.md "Changing things"):

| Doc                                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Phase            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `requirements.md` §5.1                    | Add the **NEW** config keys from §3 (D10, D6, D11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 0/2              |
| `technical-decisions.md`                  | TD-17 NO_DATA/STALE same incident (D4); TD-18 EVERY_CHECK records incidents (D5); TD-19 MONITOR_ERROR grouping window (D6); TD-20 outbox mail transport and sandbox (D11); TD-21 incident holds alert counters (D12, D13); TD-22 delete closes incident silently (D7); TD-23 first-run timing (D8); TD-24 index direction (D9); TD-25 monitor actions and edit semantics (D14, D15); TD-26 user/recipient management rules (D16, D17); TD-27 resend recipients and grouped subjects (D18, D19); TD-28 composition root with late-bound scheduler port and lease self-fencing (App. E, §4.9). Mark TD-08, TD-09, TD-11, TD-12 and TD-13 **Accepted** once implemented | 0 + as they land |
| `database-design.md`                      | `incidents` += `dLastAlertAt`, `nReminderCount`, `eCloseReason`; `alerts` += `nRetryIndex`, `aAffectedMonitors` in the snapshot for MONITOR_ERROR; `oState`: drop `dLastAlertAt`/`nReminderCount`, add `eLastResult`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 7/8              |
| `api-standards.md`                        | Replace §1 with the full catalogue in Appendix C (`monitors` action module, `GET /alerts` filters, exact page paths)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 3/9/10           |
| `architecture.md`                         | §5 flows: add the composition root (Appendix E), startup and shutdown (Appendix F), lease self-fencing (§4.9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 9                |
| `.claude/rules/error-handling-logging.md` | Point to the event catalogue (Appendix G)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2                |
| `project-structure.md`                    | `modules/monitors/`, `scripts/sandbox/`, `tests/acceptance/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 9/11             |
| `testing-strategy.md`                     | Jest projects, `test:acceptance`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 1/11             |
| `README.md`, `CLAUDE.md` Status           | Run instructions; "application implemented"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 11/12            |

---

## 8. Risks and mitigations

| Risk                                                               | Mitigation                                                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jest ESM + ts-jest quirks (TD-10)                                  | Phase 1 proves the setup with a real test before any feature code. Use DI instead of `jest.mock`.                                                         |
| `bcrypt` native build fails on a machine                           | Swap in `bcryptjs` (same API). Needs approval.                                                                                                            |
| `mongodb-memory-server` downloads a ~100 MB binary on first run    | One-time download, cached in `~/.cache/mongodb-binaries`. Pin the version in `package.json` `config`.                                                     |
| Version mismatch between `mongodb` and `connect-mongo`             | Install `connect-mongo` first and match its supported `mongodb` major.                                                                                    |
| `checks` growth (~10M docs/year, database-design B.5)              | Out of scope (FR-H3: keep everything). The indexes support it. Flagged for a product decision.                                                            |
| No index on `amazon_pay_webhook_data` / `me_pass_webhooks`         | The UI warning (D9). Ask the source backend owners to add `{ dCreatedAt: -1 }`. payMonitor never creates it.                                              |
| DNS check time-of-check vs time-of-use (SSRF)                      | Admin-only creation plus audit. Accepted in security §2.9.                                                                                                |
| Long-running timers drift                                          | `setTimeout` chain from `startedAt`. Accuracy target ±30 s is easily met.                                                                                 |
| Crash between SMTP acceptance and `markSent` → one duplicate email | At-least-once delivery is chosen over at-most-once, which could lose alerts. The window is milliseconds. See Appendix F.3.                                |
| Monitor DB outage silences all alerting (store-first can't store)  | `/readyz` returns 503, so an external uptime check on `/readyz` covers this gap. Recommend adding one at deployment (open question §8.3 of requirements). |

---

# Appendices

## Appendix A — Data model: stored docs ↔ domain types

Applies database-design §B.0 (TD-16). For every collection: `_id` → `id: string`, `dCreatedAt` → `createdAt`, `dUpdatedAt` → `updatedAt`. Only `<module>.mapper.ts` converts. **Bold** = field added by this plan (record it in database-design.md, plan §7).

### A.1 Shared shapes

| Stored                                  | Domain                         | Notes                         |
| --------------------------------------- | ------------------------------ | ----------------------------- |
| `StoredDuration { nValue, eUnit, nMs }` | `Duration { value, unit, ms }` | TD-08; `nMs` computed on save |
| `MonitorStateDoc` (`oState`)            | `MonitorState`                 | See below                     |

`oState` (webhook and endpoint monitors):

| Stored                                               | Domain               | Written by                                              |
| ---------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| **`eLastResult`**: `CheckResult \| null`             | `lastResult`         | Runner, every check (including ERROR)                   |
| `eCurrentStatus`: `OK\|STALE\|NO_DATA\|DOWN \| null` | `currentStatus`      | Runner, non-ERROR checks only (FR-A4a)                  |
| `dLastCheckAt`                                       | `lastCheckAt`        | Runner                                                  |
| `dNextCheckAt`                                       | `nextCheckAt`        | Scheduler `onScheduled` (null when paused or deleted)   |
| `iLastCheckId`                                       | `lastCheckId`        | Runner                                                  |
| `iOpenIncidentId`                                    | `openIncidentId`     | Runner, from the alerts outcome (non-ERROR checks only) |
| **`nLastAgeMs`** (webhook)                           | `lastAgeMs`          | Runner (FR-D1 "last document age")                      |
| **`nLastResponseTimeMs`** (endpoint)                 | `lastResponseTimeMs` | Runner (the last attempt's time)                        |
| ~~`dLastAlertAt`, `nReminderCount`~~                 | —                    | Moved to `incidents` (D12)                              |

### A.2 Collections

| Collection          | Stored fields → domain fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`             | `sName`→`name`, `sEmail`→`email`, `sPasswordHash` (**never mapped**; the repository has a dedicated `findCredentialsByEmail`), `eRole`→`role`, `bIsActive`→`isActive`, `dLastLoginAt`→`lastLoginAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `recipients`        | `sName`→`name`, `sEmail`→`email`, `bIsActive`→`isActive`, `eType`→`type`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `webhook_monitors`  | `sName`→`name`, `sGatewayName`→`gatewayName`, `sSourceCollection`→`sourceCollection`, `sTimestampKey`→`timestampKey`, `oCheckInterval`→`checkInterval`, `oThreshold`→`threshold`, `eAlertMode`→`alertMode`, `oRepeatInterval?`→`repeatInterval?`, `bIsEnabled`→`isEnabled`, `bHasDescIndexAtSave`→`hasTimestampIndexAtSave`, `oState`→`state`, `dDeletedAt`→`deletedAt`, `iCreatedBy`/`iUpdatedBy`→`createdBy`/`updatedBy`                                                                                                                                                                                                                                                                       |
| `endpoint_monitors` | `sServerName`→`serverName`, `sUrl`→`url`, `nRetryCount`→`retryCount`, plus the shared fields from `webhook_monitors` (interval, mode, repeat, enabled, state, deleted, created/updated by)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `checks`            | `iMonitorId`→`monitorId`, `eMonitorType`→`monitorType`, `eTrigger`→`trigger`, `dStartedAt`/`dFinishedAt`→`startedAt`/`finishedAt`, `eResult`→`result`, `oWebhook { iLastDocId (ObjectId\|string → string), dLastDocTimestamp, nAgeMs, nThresholdMs, eReason }`→`webhook {…}`, `oEndpoint { aAttempts[{ nAttempt, nStatusCode, nResponseTimeMs, sErrorCode, sErrorMessage }] }`→`endpoint { attempts[…] }`, `oError { sCode, sMessage }`→`error`                                                                                                                                                                                                                                                  |
| `incidents`         | `iMonitorId`→`monitorId`, `eKind`→`kind`, `dOpenedAt`→`openedAt`, `dClosedAt`→`closedAt`, `eOpeningResult`→`openingResult`, `aAffectedMonitorIds`→`affectedMonitorIds`, `iLastCheckId`→`lastCheckId`, **`dLastAlertAt`**→`lastAlertAt`, **`nReminderCount`**→`reminderCount`, **`eCloseReason`** (`RECOVERED\|MONITOR_DELETED`)→`closeReason`                                                                                                                                                                                                                                                                                                                                                    |
| `alerts`            | `sDedupeKey`→`dedupeKey`, `eType`→`type`, `iMonitorId`/`iIncidentId`/`iCheckId`→`monitorId`/`incidentId`/`checkId`, `oMonitorSnapshot`→`monitorSnapshot` (+ **`aAffectedMonitors [{ iMonitorId, sName, eMonitorType }]`**, **`nReminderNumber?`**, **`nDowntimeMs?`**), `aRecipients [{ sName, sEmail, eType }]`→`recipients`, `sSubject`/`sTextBody`/`sHtmlBody`→`subject`/`textBody`/`htmlBody`, `eStatus`→`status`, `aAttempts [{ dAt, bIsSuccess, sErrorCode, sErrorMessage }]`→`attempts`, `dNextAttemptAt`→`nextAttemptAt`, `dLockedUntil` (**not mapped**; dispatcher only), **`nRetryIndex`**→`retryIndex`, `dSentAt`/`sMessageId`/`sFailureReason`→`sentAt`/`messageId`/`failureReason` |
| `audit_logs`        | `iActorUserId`→`actorUserId`, `sActorEmail`→`actorEmail`, `eAction`→`action`, `eEntityType`→`entityType`, `iEntityId`→`entityId`, `oBefore`/`oAfter`→`before`/`after` (domain snapshots, camelCase, secrets stripped), `dAt`→`at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `scheduler_locks`   | `_id: 'scheduler'`, `sOwnerId`, `dExpiresAt`. Internal to `leaseLock.ts`; no mapper.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sessions`          | Owned by connect-mongo (TD-16 exception)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Mapper rules:

- Optional stored fields that are missing map to omitted domain props (`exactOptionalPropertyTypes`), so old docs keep loading.
- `to<Entity>Update(input)` returns a `$set` object containing only the changed config fields. It **never** includes `oState` or `dCreatedAt`.

## Appendix B — State machines

### B.1 Monitor state per check (runner)

| Check result                | `eLastResult` | `eCurrentStatus` | `iOpenIncidentId`          | `nLastAgeMs` / `nLastResponseTimeMs` |
| --------------------------- | ------------- | ---------------- | -------------------------- | ------------------------------------ |
| OK / STALE / NO_DATA / DOWN | result        | result           | from `processCheckOutcome` | set (age is absent for NO_DATA)      |
| ERROR (webhook only)        | `ERROR`       | **unchanged**    | **unchanged**              | unchanged                            |

There is always one atomic `updateOne({ _id }, { $set: { 'oState.…': … } })`. It never overwrites config fields (database-design B.2).

### B.2 Display status (dashboard and lists)

`deletedAt` set → not listed · `!isEnabled` → `PAUSED` · `lastResult === null` → `PENDING_FIRST_CHECK` (label "Not checked yet") · otherwise `lastResult`.
Count cards: **failing** = `STALE + NO_DATA + DOWN + ERROR`; **paused** = `PAUSED`; **open incidents** = open `MONITOR` incidents + open `SOURCE_ERROR` (0/1); **emails FAILED** = `alerts.eStatus = FAILED`.

### B.3 Incident lifecycle

```
MONITOR:      (none) ──fail──► OPEN ──markAlerted (0..n)──► OPEN ──OK──► CLOSED(RECOVERED)
                                  └──────monitor deleted──────────────► CLOSED(MONITOR_DELETED)  (D7, no email)
SOURCE_ERROR: (none) ──first ERROR──► OPEN (+affected monitors) ──first good source read──► CLOSED(RECOVERED)
```

Pause, edit (D15) and source outages never change a MONITOR incident.

### B.4 Alert lifecycle (FR-A2)

```
insert ──► PENDING ──send ok──► SENT
            │  └──send fail──► RETRYING ──ok──► SENT
            │                     └──fail (retryIndex = backoff.length)──► FAILED ──resend──► PENDING
insert with no recipients ──► FAILED("no recipients") ──resend (D18: re-resolve)──► PENDING | FAILED
```

`MONITOR_ERROR` open alerts are created with `dNextAttemptAt = openedAt + groupWindow` (D6). Their body may be re-rendered only while `PENDING` and unlocked.

## Appendix C — Route catalogue

Global middleware applies to every route (Phase 3 order). CSRF is enforced on **every** non-GET request. Columns: Role `P` public, `U` any logged-in user, `V` admin or viewer, `A` admin. "Schema" names a Zod schema in that module's `*.schemas.ts`.

### C.1 Pages

| Method        | Path                           | Role | Extra middleware | Schema                                  | Success                                         | Failure                                                                            |
| ------------- | ------------------------------ | ---- | ---------------- | --------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| GET           | `/login`                       | P    | —                | —                                       | login page (redirect `/` if already logged in)  | —                                                                                  |
| POST          | `/login`                       | P    | `loginLimiter`   | `loginBody`                             | 303 `/`                                         | 400 page "Invalid email or password" · 429                                         |
| POST          | `/logout`                      | U    | —                | —                                       | 303 `/login`                                    | —                                                                                  |
| GET           | `/`                            | V    | —                | —                                       | overview                                        | —                                                                                  |
| GET           | `/webhook-monitors`            | V    | —                | `listQuery`                             | list                                            | —                                                                                  |
| GET           | `/webhook-monitors/new`        | A    | —                | —                                       | empty form (collections pre-filled server-side) | 502 notice if Source DB is down (the form still renders, with a manual text input) |
| POST          | `/webhook-monitors/new`        | A    | —                | `createWebhookMonitorBody`              | 303 `/webhook-monitors/:id` + flash (warnings)  | 400 form re-render · 409 duplicate name                                            |
| GET           | `/webhook-monitors/:id`        | V    | —                | `idParams` + `detailQuery`              | detail                                          | 404                                                                                |
| GET           | `/webhook-monitors/:id/edit`   | A    | —                | `idParams`                              | form                                            | 404                                                                                |
| POST          | `/webhook-monitors/:id/edit`   | A    | —                | `idParams` + `updateWebhookMonitorBody` | 303 detail                                      | 400 · 404 · 409                                                                    |
| POST          | `/webhook-monitors/:id/delete` | A    | —                | `idParams`                              | 303 list + flash                                | 404                                                                                |
| (same 7 rows) | `/endpoint-monitors…`          |      |                  | `…EndpointMonitorBody`                  |                                                 |                                                                                    |
| GET           | `/alerts`                      | V    | —                | `alertListQuery`                        | alert log                                       | —                                                                                  |
| GET           | `/recipients`                  | A    | —                | —                                       | list                                            | —                                                                                  |
| GET/POST      | `/recipients/new`              | A    | —                | `createRecipientBody`                   | 303 list                                        | 400 · 409                                                                          |
| GET/POST      | `/recipients/:id/edit`         | A    | —                | `idParams` + `updateRecipientBody`      | 303 list                                        | 400 · 404 · 409 `MASTER_PROTECTED`                                                 |
| POST          | `/recipients/:id/delete`       | A    | —                | `idParams`                              | 303 list                                        | 404 · 409 `MASTER_PROTECTED`                                                       |
| GET           | `/users`                       | A    | —                | —                                       | list                                            | —                                                                                  |
| GET/POST      | `/users/new`                   | A    | —                | `createUserBody`                        | 303 list                                        | 400 · 409                                                                          |
| GET/POST      | `/users/:id/edit`              | A    | —                | `idParams` + `updateUserBody`           | 303 list                                        | 400 · 404 · 409 `LAST_ADMIN`                                                       |
| POST          | `/users/:id/delete`            | A    | —                | `idParams`                              | 303 list                                        | 404 · 409 `LAST_ADMIN`                                                             |

### C.2 JSON API (`/api/v1`, envelope per api-standards §2)

| Method | Path                             | Role | Extra           | Schema                               | 2xx `data`                                                 | Errors                                                |
| ------ | -------------------------------- | ---- | --------------- | ------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------- |
| GET    | `/source/collections`            | A    | —               | —                                    | `{ collections: string[] }`                                | 502                                                   |
| POST   | `/source/validate-timestamp-key` | A    | —               | `{ sourceCollection, timestampKey }` | `{ valid, warning?, latestTimestamp?, hasTimestampIndex }` | 400 · 502                                             |
| POST   | `/monitors/:type/:id/run`        | A    | `actionLimiter` | `monitorParams`                      | `CheckResultView` (200)                                    | 404 · 409 `ALREADY_RUNNING`/`SCHEDULER_STANDBY` · 429 |
| POST   | `/monitors/:type/:id/pause`      | A    | —               | `monitorParams`                      | `{ isEnabled: false }`                                     | 404                                                   |
| POST   | `/monitors/:type/:id/resume`     | A    | —               | `monitorParams`                      | `{ isEnabled: true, nextCheckAt }`                         | 404                                                   |
| POST   | `/monitors/:type/:id/test-email` | A    | `actionLimiter` | `monitorParams`                      | `{ alertId, status: 'queued' }` (202)                      | 404 · 429                                             |
| GET    | `/monitors/:type/:id/checks`     | V    | —               | `monitorParams` + `checksQuery`      | `CheckRow[]` + `meta.nextCursor`                           | 400 · 404                                             |
| GET    | `/monitors/:type/:id/series`     | V    | —               | `monitorParams` + `seriesQuery`      | `{ points: [{ t, value, isUp? }], thresholdMs? }`          | 400 · 404                                             |
| POST   | `/alerts/:id/resend`             | A    | —               | `idParams`                           | `{ status: 'queued' }` (202)                               | 404 · 409 (not FAILED)                                |

### C.3 Ops and static

`GET /healthz` (P) → `{ status: 'ok' }` · `GET /readyz` (P) → 200/503 `{ monitorDb, sourceDb, scheduler }` with `up/down` and `leader/standby/stopped` values only · `/public/*` and `/vendor/chart.js/*` static (P, not behind the session).

## Appendix D — Validation catalogue

Shared rules (in `src/utils/validation.ts`):

- Strings are trimmed and length-bounded.
- `emailSchema`: trim, lower-case, ≤ 254, RFC-like.
- `objectIdSchema`.
- `checkboxSchema`: `'on' | 'true' | true` → `true`, absent → `false`.
- `durationSchema(unitSet)`: `{ value: z.coerce.number().int().min(1).max(10000), unit: z.enum(unitSet) }`.
- `validate()` **removes `_csrf`** from the body before `.strict()` parsing. Without that, every form post would fail.

| Field                                          | Rule                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` (webhook), `serverName`                 | 1–100 chars, no control characters; uniqueness is checked by the index (→ 409)                                                                                             |
| `gatewayName`                                  | 1–60 chars                                                                                                                                                                 |
| `sourceCollection`                             | 1–120 chars; must be in the live `listCollections` result (service)                                                                                                        |
| `timestampKey`                                 | `^[A-Za-z_][A-Za-z0-9_.]{0,63}$`, no `..`, doesn't end with `.`                                                                                                            |
| `checkInterval`                                | `durationSchema(MINUTE\|HOUR)`, `ms ≥ MIN_CHECK_INTERVAL_MIN`                                                                                                              |
| `threshold`                                    | `durationSchema(MINUTE\|HOUR\|DAY\|WEEK\|MONTH)`                                                                                                                           |
| `alertMode`                                    | `ONCE_WITH_RECOVERY\|EVERY_CHECK\|REPEAT_EVERY`                                                                                                                            |
| `repeatInterval`                               | `durationSchema(MINUTE\|HOUR\|DAY)`; required iff `REPEAT_EVERY`, otherwise must be absent or empty (dropped); `ms ≥ checkInterval.ms`                                     |
| `isEnabled`                                    | `checkboxSchema` (the create form pre-checks it)                                                                                                                           |
| `url`                                          | `z.url()`, ≤ 2048, protocol `http:`/`https:`, no `username`/`password`                                                                                                     |
| `retryCount`                                   | `z.coerce.number().int().min(0).max(ENDPOINT_MAX_RETRY_COUNT)`                                                                                                             |
| User `name`                                    | 1–100 · `email` emailSchema · `role` `ADMIN\|VIEWER` · `password` D3 (required on create, optional on edit) · `isActive` checkbox                                          |
| Recipient `name`                               | 1–100 · `email` · `type` `NORMAL\|MASTER` (D17) · `isActive` checkbox                                                                                                      |
| `listQuery` / `checksQuery` / `alertListQuery` | `cursor` ≤ 512 (decoded and validated), `limit` 1–200 (default 50), `from`/`to` ISO dates with `from ≤ to`, `result`/`type`/`status`/`monitorId` enums or ids; `.strict()` |
| `seriesQuery`                                  | `range` `24h\|7d\|30d\|custom`; `from`/`to` required iff `custom`; span ≤ 90 days                                                                                          |
| `monitorParams`                                | `type` `webhook\|endpoint`, `id` objectId                                                                                                                                  |

Form field names are nested camelCase (`threshold[value]`), parsed by `express.urlencoded({ extended: true })`. JSON bodies use the same shape, so **one schema serves both**.

## Appendix E — Composition root and module dependencies

`src/server.ts` → `src/compositionRoot.ts`: `buildContainer(config, logger, dbs) → AppDeps` builds everything **in this order**. Each module exports a `create…` factory that takes an explicit deps object (no DI container, coding-standards §5).

1. `clock = systemClock`; `mailer = createMailer(config.mail)`
2. Repositories: `createXRepository(monitorDb)` for users, recipients, webhookMonitors, endpointMonitors, checks, incidents, alerts, audit
3. `audit = createAuditService({ repo, clock })`
4. `users = createUsersService({ repo, audit, clock, config })`; `auth = createAuthService({ users, audit, clock })`
5. `recipients = createRecipientsService({ repo, audit, clock })`
6. `sourceData = createSourceDataService({ sourceDb, config })`
7. `checks = createChecksService({ repo })`; `incidents = createIncidentsService({ repo, clock })`
8. `alerts = createAlertsService({ repo, incidents, recipients, templates, clock, config, logger, nudge: () => dispatcher.nudge() })`
9. `dispatcher = createDispatcher({ repo: alertsRepo, mailer, clock, config, logger })`
10. `schedulerPort = createLateBoundSchedulerPort()`: `{ upsert, remove, runNow }` that forward to a scheduler bound in step 13. This breaks the cycle monitor service → scheduler → runner → monitor service.
11. `webhookMonitors = createWebhookMonitorsService({ repo, sourceData, incidents, audit, schedulerPort, clock, config })`, plus the same for `endpointMonitors` (without sourceData)
12. `webhookRunner = createWebhookRunner({ monitors: webhookMonitors, sourceData, checks, alerts, clock, logger })`; `endpointRunner = createEndpointRunner({ monitors: endpointMonitors, probe, checks, alerts, clock, logger, config })`
13. `scheduler = createScheduler({ runners, loadMonitor, listEnabledMonitors, onScheduled, clock, logger, config })`; `schedulerPort.bind(scheduler)`
14. `monitorActions = createMonitorActionsService({ webhookMonitors, endpointMonitors, scheduler: schedulerPort, alerts, audit })`; `dashboard = createDashboardService({ webhookMonitors, endpointMonitors, incidents, alerts })`
15. `lease = createLeaseLock({ db: monitorDb, clock, config, logger })`
16. `app = createApp({ config, logger, sessionClient, services… })`

Import-level dependency graph (arrows are `import`; runtime wiring happens only in the composition root). Each module imports only **types** from the others:

```
routes → controller → service → repository → database/monitorDb
webhookMonitors.service ─► sourceData.service (instance injected) ; incidents (injected) ; audit (injected)
*.runner ─► (injected) checks, alerts, sourceData | httpProbe
alerts.service ─► notifications/email/templates (pure) ; (injected) incidents, recipients
alerts.dispatcher ─► (injected) Mailer interface   ← only notifications/email imports nodemailer
scheduler ─► runner interfaces only (types)
constants / types / utils / config / errors ─► nothing above them
```

ESLint `import-x/no-cycle` plus `no-restricted-imports` (Phase 1) enforce this.

## Appendix F — Startup, shutdown and failure modes

### F.1 Startup (`src/server.ts`)

1. `loadConfig` fails → log names, `exit(1)`.
2. Create the logger.
3. Connect the Monitor DB (`serverSelectionTimeoutMS` 10 s). On failure: `fatal`, `exit(1)` (the process manager restarts it). There's no app without its own DB.
4. Create the Source DB client **without blocking startup**: try `connect()`, and on failure log `warn` with `event: 'sourceDb.unavailable'` and continue. Webhook checks will return ERROR → FR-A4a. A down Source DB at boot must still produce a `MONITOR_ERROR` email.
5. `ensureMonitorDbIndexes` when not in production.
6. `seedFirstAdmin`, then `seedMasterRecipient` (fatal if needed and the env is missing).
7. `buildContainer`.
8. `app.listen(port)`, so `/healthz` responds early.
9. `lease.start()` → on `acquired`: `dispatcher.start()`, then `scheduler.start()`. On `lost`: `scheduler.stop()`, `dispatcher.stop()`.
10. Log `app.started` with port, env and lease state (no URIs).

### F.2 Shutdown (SIGTERM/SIGINT; a second signal → `exit(1)`)

`server.close()` → `scheduler.stop()` (awaits in-flight ≤ `SHUTDOWN_TIMEOUT_MS`) → `dispatcher.stop()` (awaits the current send) → `lease.release()` → close both Mongo clients → `logger.flush()` → `exit(0)`. `unhandledRejection` and `uncaughtException` → `fatal`, then the same sequence with `exit(1)`.

### F.3 Failure-mode matrix

| Failure                                                                        | Behaviour                                                                                                                                                                                                                                           | Tested in                              |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Source DB down (boot or runtime)                                               | Webhook checks → ERROR → one grouped `MONITOR_ERROR` to masters; monitor incidents untouched; RECOVERED when reads succeed                                                                                                                          | Phase 8 service test, acceptance 07    |
| A single source query times out (missing index)                                | That monitor → ERROR → joins/opens the SOURCE_ERROR incident (FR-A4a "query errored")                                                                                                                                                               | Phase 8                                |
| Monitor DB down at runtime                                                     | The check insert fails → run logged `check.failed`, **no alert** (store-first is impossible; nothing sent). Lease self-fences → scheduler and dispatcher stop. `/readyz` 503. Pages → 500 generic. On recovery the lease is re-acquired and resumes | Phase 9 lease test                     |
| SMTP down                                                                      | RETRYING per backoff → FAILED → resend                                                                                                                                                                                                              | Phase 8 dispatcher test, acceptance 09 |
| Crash after check insert, before the incident opens                            | Next check repeats the decision; the dedupe key prevents duplicates                                                                                                                                                                                 | Phase 8 dedupe test                    |
| Crash after the incident opens, before the alert insert                        | `lastAlertAt === null` row in §4.5 → the open alert is created at the next check                                                                                                                                                                    | Policy test                            |
| Crash after the alert insert, before `markAlerted`                             | Next decision computes the same dedupe key → duplicate = done → `markAlerted`                                                                                                                                                                       | Service test                           |
| Crash after the RECOVERED insert, before the incident closes                   | Next OK check → CLOSE + same `recovered` key → close                                                                                                                                                                                                | Service test                           |
| Crash **after SMTP accepted, before `markSent`**                               | The lock expires → the alert is sent again (**at-least-once**; one duplicate email possible). Accepted and documented: the alternative risks losing alerts                                                                                          | Documented (§8)                        |
| Check takes longer than its interval (e.g. endpoint 6 × 10 s timeout + delays) | The next tick is skipped (`check.skipped`); the run after that proceeds                                                                                                                                                                             | Scheduler test                         |
| Second process started                                                         | It can't get the lease → standby: serves the UI, runs no checks or sends, run-now → 409                                                                                                                                                             | Lease test                             |
| Runner throws unexpectedly                                                     | Caught per run, `check.failed` logged, the next run is still scheduled (FR-S4)                                                                                                                                                                      | Scheduler test                         |
| Seed env missing on an empty DB                                                | `fatal` naming the variable, `exit(1)`                                                                                                                                                                                                              | Phase 3/4                              |

## Appendix G — Log event catalogue

Every log has `event` plus the listed fields. Levels follow `.claude/rules/error-handling-logging.md`. Secrets, URIs, email bodies and recipient lists are **never** logged.

| Event                                                 | Level                      | Fields                                                                                          |
| ----------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `app.started` / `app.stopping` / `app.stopped`        | info                       | `port`, `env`, `reason?`                                                                        |
| `config.invalid`                                      | fatal                      | `variables: string[]`                                                                           |
| `monitorDb.connected` / `sourceDb.connected`          | info                       | `host`                                                                                          |
| `sourceDb.unavailable`                                | warn                       | `errorCode`                                                                                     |
| `lease.acquired` / `lease.lost` / `lease.renewFailed` | info / error / warn        | `ownerId`                                                                                       |
| `scheduler.started` / `scheduler.stopped`             | info                       | `monitorCount`                                                                                  |
| `check.scheduled`                                     | debug                      | `monitorId`, `monitorType`, `nextRunAt`                                                         |
| `check.result`                                        | info if OK, warn otherwise | `monitorId`, `monitorType`, `checkId`, `trigger`, `result`, `ageMs?`, `attempts?`, `durationMs` |
| `check.skipped`                                       | warn                       | `monitorId`, `reason: 'IN_FLIGHT'`                                                              |
| `check.failed`                                        | error                      | `monitorId`, `err` (serialized, sanitized)                                                      |
| `incident.opened` / `incident.closed`                 | warn / info                | `incidentId`, `monitorId?`, `kind`, `durationMs?`, `reason?`                                    |
| `sourceOutage.joined`                                 | warn                       | `incidentId`, `monitorId`                                                                       |
| `alert.created` / `alert.deduped`                     | info / debug               | `alertId`, `type`, `monitorId?`, `recipientCount`, `dedupeKey`                                  |
| `alert.sent`                                          | info                       | `alertId`, `messageId`, `attempt`                                                               |
| `alert.retry`                                         | warn                       | `alertId`, `attempt`, `nextAttemptAt`, `errorCode`                                              |
| `alert.failed`                                        | error                      | `alertId`, `reason`                                                                             |
| `alert.resend`                                        | info                       | `alertId`, `actorUserId`                                                                        |
| `auth.login` / `auth.loginFailed`                     | info / warn                | `userId?` (no email or password on failure; IP comes from pino-http)                            |
| `audit.recorded`                                      | debug                      | `action`, `entityType`, `entityId`                                                              |
| HTTP request (pino-http)                              | info                       | `requestId`, `method`, `url` (query masked), `statusCode`, `responseTime`                       |

## Appendix H — Email content specification

All emails: a plain-text body and an HTML body built from the same view-model. Every value is HTML-escaped. Times use `formatUtc` with the "UTC" label. Durations use `formatHumanDuration`. The footer has the link `${DASHBOARD_BASE_URL}/<webhook|endpoint>-monitors/<id>` and the line "Sent by payMonitor".

| Type                         | Subject (FR-A6, D19)                                    | Body content                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WEBHOOK_STALE`              | `[payMonitor] WEBHOOK_STALE – <name>`                   | FR-W4: name, gateway, collection, key, last doc `_id` + timestamp, age, threshold, check interval, check time, link                                          |
| `WEBHOOK_STALE` (reminder)   | same                                                    | Everything above, plus "Reminder #n · incident open for <duration> · <n−1> earlier reminders" (FR-A3)                                                        |
| `WEBHOOK_NO_DATA`            | `[payMonitor] WEBHOOK_NO_DATA – <name>`                 | Name, gateway, collection, key, reason in plain words (empty collection / key missing / invalid date / future date), last doc `_id` if any, check time, link |
| `ENDPOINT_DOWN` (+ reminder) | `[payMonitor] ENDPOINT_DOWN – <serverName>`             | FR-E3: server name, **masked** URL, failure time, attempts count, last status code or error, last response time, a per-attempt table, link                   |
| `RECOVERED` (monitor)        | `[payMonitor] RECOVERED – <name>`                       | Name, recovered at, incident opened at, **downtime**, current age or response time, link                                                                     |
| `MONITOR_ERROR`              | `[payMonitor] MONITOR_ERROR – Source DB (<n> monitors)` | "The source database could not be read", first error time, safe error code and text, affected monitors list (name + link each). Masters only                 |
| `RECOVERED` (source)         | `[payMonitor] RECOVERED – Source DB`                    | Outage start and end, downtime, affected monitors list                                                                                                       |
| `TEST`                       | `[payMonitor] TEST – <name>`                            | "Test email requested by <admin name>", monitor summary, time, link                                                                                          |

## Appendix I — Pages and view-models

Layout locals (middleware): `currentUser { name, role }`, `csrfToken`, `flash[]`, `requestId`, `nav` (items filtered by role: Overview, Webhook monitors, Endpoint monitors, Alerts for everyone; Recipients and Users for admins only). HTML responses send `Cache-Control: no-store`.

| Page (view)                                                      | View-model (built in `<module>.view.ts`)                                                                                                                                                                                                     | Sections / UX                                                                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pages/auth/login`                                               | `{ email?, error? }`                                                                                                                                                                                                                         | Email, password, submit; generic error                                                                               |
| `pages/dashboard/overview`                                       | `{ cards: { total, ok, failing, paused, openIncidents, emailsFailed }, monitors: MonitorRowView[], sourceOutage?: { openedAt, affectedCount } }`                                                                                             | Cards, outage banner, table: name (link), type, status badge, last check, next check, age or response time           |
| `pages/webhookMonitors/list` · `pages/endpointMonitors/list`     | `{ rows: MonitorRowView[], can: { create } }`                                                                                                                                                                                                | Table, empty state with a "Create" CTA (admins) or an explanation (viewers)                                          |
| `pages/webhookMonitors/form` · `pages/endpointMonitors/form`     | `{ mode: 'create'\|'edit', values, errors: Record<field, string>, options: { collections?, units, alertModes, maxRetry }, warnings[] }`                                                                                                      | FR-W1/E1 fields, repeat interval toggle, "Validate key" (webhook), field errors                                      |
| `pages/webhookMonitors/detail` · `pages/endpointMonitors/detail` | `{ monitor: ConfigView, status: StatusView, history: { rows, nextCursor, filters }, incidents: IncidentRowView[], alerts: AlertRowView[], chart: { seriesUrl, range, thresholdMs? }, can: { edit, delete, run, pause, testEmail, resend } }` | Config, status, actions bar, chart + range picker, history (filters + "Older"), incidents, alerts (Resend on FAILED) |
| `pages/alerts/list`                                              | `{ rows: AlertRowView[], filters, options: { monitors, types, statuses }, nextCursor, can: { resend } }`                                                                                                                                     | Filter form (GET), table with FAILED highlighted, Resend                                                             |
| `pages/recipients/list` · `form`                                 | `{ rows: RecipientRowView[] }` / `{ mode, values, errors, isMaster }`                                                                                                                                                                        | Master badge; delete/deactivate controls hidden for masters (the server also refuses)                                |
| `pages/users/list` · `form`                                      | `{ rows: UserRowView[] }` / `{ mode, values, errors }`                                                                                                                                                                                       | Role and active controls; password hint (D3)                                                                         |
| `errors/403`, `404`, `500`                                       | `{ requestId }`                                                                                                                                                                                                                              | Friendly text, no technical detail                                                                                   |

Browser scripts (no inline JS, CSP):

- `api.js`: fetch wrapper with CSRF and the error envelope
- `confirm.js`: `data-confirm` on destructive forms
- `monitorForm.js`
- `monitorActions.js`
- `charts.js`
- `alertActions.js`: Resend

## Appendix J — Security controls → code location

| Control (security.md)                              | Where                             | Phase | Verified by                                           |
| -------------------------------------------------- | --------------------------------- | ----- | ----------------------------------------------------- |
| Helmet CSP / no inline scripts                     | `app.ts`                          | 3     | `curl -I` (Phase 12), page tests                      |
| Session cookie flags, regenerate on login          | `app.ts`, `auth.service`          | 3     | auth test                                             |
| CSRF on all non-GET                                | `middlewares/csrf.ts`             | 3     | csrf test + RBAC manifest                             |
| bcrypt 12, D3 policy, hash never mapped            | `users.service`, `users.mapper`   | 3     | users tests                                           |
| Login rate limit (IP + email) / action limit       | `middlewares/rateLimit.ts`        | 3/9   | auth test, actions test                               |
| Server-side RBAC on every mutation or I/O route    | `*.routes.ts` + `requireRole`     | 3–10  | `rbac.test.ts` over the manifest                      |
| Inactive user cut off mid-session                  | `loadCurrentUser`                 | 3     | auth test                                             |
| Zod on all input; `.strict()`; no raw filters      | `validate.ts`, `*.schemas.ts`     | 3–10  | schema tests, NoSQL-injection cases (`{ "$gt": "" }`) |
| Source DB read-only boundary                       | `modules/sourceData`, ESLint rule | 5     | static test, acceptance 13                            |
| Key / collection validation                        | `sourceData.service`              | 5     | sourceData test                                       |
| SSRF: scheme, credentials, metadata IPs, redirects | `httpProbe.ts`, endpoint schema   | 6     | probe test                                            |
| No response bodies surfaced                        | `httpProbe.ts`                    | 6     | probe test                                            |
| Escaping in EJS (`<%=`) and email HTML             | views, templates                  | 3–10  | templates test, grep (Phase 12)                       |
| URL masking in logs and emails                     | `maskUrl`                         | 2/6/8 | unit tests                                            |
| Log redaction                                      | `logger/index.ts`                 | 2     | logger test (redacted keys)                           |
| Secrets only in config; names-only errors          | `config/`                         | 2     | config test, grep                                     |
| Audit of every config change, secrets stripped     | `audit.service`                   | 4+    | audit test                                            |

## Appendix K — Definition of Done (every change)

Every phase, PR or change ticks all of these before it is called done:

- [ ] The code follows the layer and boundary rules (Appendix E). No new import cycles (ESLint).
- [ ] Reused existing constants, schemas, utils and errors. No duplicates.
- [ ] Prefixed field names appear only in Doc types, mappers, repositories and `indexes.ts`.
- [ ] Every new route is added to Appendix C, `docs/api-standards.md` and the RBAC route manifest.
- [ ] Every new stored field or index is added to Appendix A, `docs/database-design.md`, `indexes.ts` and the mapper + mapper test.
- [ ] Every new tunable is added to `src/config`, §3, `.env.example` and requirements §5.1.
- [ ] Critical-area changes have tests (testing-strategy §2). A bug fix starts with a failing test.
- [ ] Logs use catalogue events (Appendix G). Nothing secret is logged.
- [ ] Gates run with their real output recorded: typecheck, lint, format:check, test, build (plus `npm audit` if dependencies changed).
- [ ] `docs/implementation_progress.md` is ticked and has a log entry.
- [ ] Final report in the CLAUDE.md format.
