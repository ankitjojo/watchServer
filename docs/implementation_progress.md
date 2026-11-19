# payMonitor v1 — Implementation Progress

> Full task checklist for [implementation_plans/paymonitor-v1-implementation.md](implementation_plans/paymonitor-v1-implementation.md) ("the plan").
> Every file, test, gate and doc update from the plan is listed here. Exact contracts and algorithms stay in the plan; each item links to its section, so there's one source of truth.
> **Resume rule:** continue from the first unchecked `[ ]` / in-progress `[~]` item. After each phase, run the gates and add a log entry with the real command results.
> **Next step:** none. All 12 phases are complete. Remaining work is yours: browser click-through (the sandbox makes it one command), real Mongo/SMTP configuration, deployment behind HTTPS, and your product decisions listed in the final report.
> Legend: `[x]` done · `[~]` in progress · `[ ]` not started · **[C]** = critical test (testing-strategy §2)

---

## Phase 0: Approvals (no code)

### Decisions (plan §1)

| #     | Topic                                         | Default in plan                                                      | Status                 |
| ----- | --------------------------------------------- | -------------------------------------------------------------------- | ---------------------- |
| D1    | Install dependency list (testing-strategy §6) | Yes, the full list                                                   | [x] Accepted (default) |
| D2    | CSRF library                                  | `csrf-sync`                                                          | [x] Accepted (default) |
| D3    | Password policy                               | Min 12 chars, max 72 bytes                                           | [x] Accepted (default) |
| D4    | STALE ↔ NO_DATA without passing in between    | Same incident, no new open email                                     | [x] Accepted (default) |
| D5    | Every-check mode records incidents            | Yes, no RECOVERED email                                              | [x] Accepted (default) |
| D6    | MONITOR_ERROR grouping window                 | `SOURCE_ERROR_GROUP_WINDOW_MS` = 60000                               | [x] Accepted (default) |
| D7    | Delete monitor with open incident             | Close with `MONITOR_DELETED`, no email                               | [x] Accepted (default) |
| D8    | First-run timing                              | Immediately on create and resume; edit → `lastCheckAt + interval`    | [x] Accepted (default) |
| D9    | Index warning                                 | Any single-field index (±1) on the key counts                        | [x] Accepted (default) |
| D10   | New internal tunables                         | Add the NEW keys (plan §3) to requirements §5.1                      | [x] Accepted (default) |
| D11   | Dev mail delivery                             | `MAIL_TRANSPORT=outbox` writes `.eml` files                          | [x] Accepted (default) |
| D12   | Alert counters location                       | On incident (`dLastAlertAt`, `nReminderCount`)                       | [x] Accepted (default) |
| D13   | Retry counter after resend                    | `nRetryIndex`, reset to 0 on resend                                  | [x] Accepted (default) |
| D14   | Run-now on a paused monitor                   | Allowed; alert rules apply; stays paused                             | [x] Accepted (default) |
| D15   | Edit during an open incident                  | Incident stays; next check decides with the new config               | [x] Accepted (default) |
| D16   | User management                               | Password optional on edit; `isActive` checkbox; no self-service      | [x] Accepted (default) |
| D17   | NORMAL → MASTER recipient                     | Allowed one way; MASTER → NORMAL refused                             | [x] Accepted (default) |
| D18   | Resend a "no recipients" alert                | Re-resolve recipients only when the stored list is empty             | [x] Accepted (default) |
| D19   | Subject for grouped source alerts             | `MONITOR_ERROR – Source DB (<n> monitors)` / `RECOVERED – Source DB` | [x] Accepted (default) |
| Redis | Use local Redis?                              | **Not used** (user decision 2026-11-18; TD-05/TD-11 stay)            | [x] Decided            |

### Tasks

- [x] User confirmed D1–D19 as defaults and approved `npm install` of the plan's dependency list (2026-11-18, via the execution prompt)
- [x] Add TD-17…TD-28 to `docs/technical-decisions.md` (plan §7)
- [x] Add the NEW config keys to `docs/requirements.md` §5.1 (D10, D6, D11)
- [x] Explicit approval to run `npm install` (D1)

**Phase 0 done:** [x]

---

## Phase 1: Tooling skeleton (plan §5 Phase 1, §2.5)

### Files

- [x] `package.json`: `"type": "module"`, `engines.node >=22.12`, all scripts from plan §2.5, `config.mongodbMemoryServer` binary version pinned
- [x] Install runtime deps: `express@5`, `ejs@3`, `mongodb` (major matching `connect-mongo`), `nodemailer`, `zod`, `pino`, `pino-http`, `helmet`, `express-session`, `connect-mongo`, `bcrypt`, `csrf-sync`, `express-rate-limit`, `chart.js@4`
- [x] Install dev deps: `typescript`, `tsx`, `@types/node`, `@types/express`, `@types/ejs`, `@types/nodemailer`, `@types/express-session`, `@types/bcrypt`, `jest`, `ts-jest`, `@types/jest`, `supertest`, `@types/supertest`, `mongodb-memory-server`, `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `eslint-plugin-import-x`, `prettier`, `pino-pretty`
- [x] `package-lock.json` created (not committed; commits only on request)
- [x] `tsconfig.json` (coding-standards §1)
- [x] `tsconfig.build.json` (excludes tests and scripts)
- [x] `tsconfig.test.json` (`rootDir: "."`; includes `src`, `tests`, `scripts`)
- [x] `jest.config.js`: projects `unit`, `integration`, `acceptance`; ESM preset (testing-strategy §4)
- [x] `eslint.config.js`:
  - [x] `strictTypeChecked` + prettier
  - [x] `no-console`
  - [x] `import-x/no-cycle`
  - [x] `no-restricted-imports`: `nodemailer` only in `notifications/email`; `database/sourceDb` only in `modules/sourceData`
- [x] `.prettierrc`, `.prettierignore`, `.editorconfig`
- [x] `.env.example`: every key from plan §3, with placeholders and comments
- [x] `.gitignore`: add `.sandbox/`
- [x] `scripts/copy-assets.mjs`: copies `src/views` and `src/public` → `dist/`
- [x] `src/server.ts`: temporary minimal app with `GET /healthz`
- [x] `tests/unit/smoke.test.ts`: placeholder, deleted in Phase 2

### Done when

- [x] `npm ci` ok
- [x] `npm run typecheck` ok
- [x] `npm run lint` ok
- [x] `npm run format:check` ok
- [x] `npm test` ok
- [x] `npm run build` ok
- [x] `npm start`, then `curl localhost:3000/healthz` → `{"status":"ok"}`

**Phase 1 done:** [x]

---

## Phase 2: Foundations (plan §5 Phase 2, §3, §4.1, §4.2)

### Config, logger and errors

- [x] `src/config/env.schema.ts`: every row of plan §3 with Zod rules, defaults and superRefines:
  - [x] SMTP vars required in smtp mode
  - [x] default retry count ≤ max
  - [x] lease renew < ttl/2
- [x] `src/config/index.ts` (+ `src/config/loadConfig.ts` holds the pure `loadConfig` and `ConfigError`, so tests never trigger the env-reading `config` export):
  - [x] `loadConfig(env)`: pure
  - [x] frozen `config`
  - [x] `process.loadEnvFile` only outside production when `.env` exists
  - [x] on failure: log variable names only, then `exit(1)`
- [x] `src/logger/index.ts`: `createLogger({level, destination?})` with the redaction list (no module-level `logger`: it is injected, because importing config at load time would break tests; see Log)
- [x] `src/errors/appError.ts`: `AppError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ExternalServiceError`
- [x] `src/errors/errorCodes.ts`: the codes from api-standards §2 plus `ALREADY_RUNNING`, `SCHEDULER_STANDBY`, `LAST_ADMIN`, `MASTER_PROTECTED`
- [x] `src/errors/mongoErrors.ts`: `isDuplicateKeyError`, `toAppError`

### Constants (`as const` + union type + `z.enum`)

- [x] `src/constants/checkResult.ts`
- [x] `src/constants/alertType.ts`
- [x] `src/constants/alertStatus.ts`
- [x] `src/constants/alertMode.ts`
- [x] `src/constants/roles.ts`
- [x] `src/constants/recipientType.ts`
- [x] `src/constants/durationUnit.ts` (interval / threshold / repeat unit sets)
- [x] `src/constants/checkTrigger.ts`
- [x] `src/constants/monitorType.ts`
- [x] `src/constants/incidentKind.ts`
- [x] `src/constants/auditAction.ts`
- [x] `src/constants/collections.ts` (`COLLECTIONS`)
- [x] `src/constants/display.ts` (display status incl. `PAUSED`)

### Types and utils

- [x] `src/types/clock.ts`: `Clock` + `systemClock`
- [x] `src/types/duration.ts`
- [x] `src/types/paginated.ts`
- [x] `src/utils/duration.ts`: `UNIT_MS`, `toMs`, `toStoredDuration`, `formatHumanDuration` (plan §4.1)
- [x] `src/utils/timestamp.ts`: `parseSourceTimestamp` (plan §4.2)
- [x] `src/utils/time.ts`: `formatUtc`
- [x] `src/utils/escapeHtml.ts`
- [x] `src/utils/maskUrl.ts`
- [x] `src/utils/cursor.ts`
- [x] `src/utils/objectId.ts`: `objectIdSchema`, `toObjectId`
- [x] `src/utils/validation.ts`: `emailSchema`, `checkboxSchema`, `durationSchema(unitSet)`, bounded string helpers (plan App. D)

### Database

- [x] `src/database/monitorDb.ts`: connect / close, logs the host only
- [x] `src/database/sourceDb.ts`: `maxPoolSize 5`, `secondaryPreferred`, `serverSelectionTimeoutMS 5000`
- [x] `src/database/indexes.ts`: `ensureMonitorDbIndexes(db)` with every index from database-design B.1
- [x] `scripts/ensure-indexes.ts` (`npm run db:indexes`)

### Tests

- [x] **[C]** `tests/unit/config/env.schema.test.ts`: defaults; invalid backoff / days-per-month / timeout name the var only; smtp-mode requirement; rate-limit parsing
- [x] **[C]** `tests/unit/utils/duration.test.ts`
- [x] **[C]** `tests/unit/utils/timestamp.test.ts`: epoch boundary at `1e11 − 1` / `1e11`
- [x] `tests/unit/utils/misc.test.ts` covers maskUrl, uriHost, formatUtc, escapeHtml and cursor (replaces the three separate files below):
- [x] `tests/unit/utils/maskUrl.test.ts`
- [x] `tests/unit/utils/escapeHtml.test.ts`
- [x] `tests/unit/utils/cursor.test.ts`
- [x] `tests/unit/utils/validation.test.ts`: checkbox, duration bounds, email normalisation
- [x] `tests/unit/logger/redaction.test.ts`: redacted keys never appear in output
- [x] `.claude/rules/error-handling-logging.md`: link to the event catalogue (plan App. G)
- [x] `tests/integration/database/indexes.test.ts`: unique partial indexes behave as designed
- [x] Delete `tests/unit/smoke.test.ts`

### Done when

- [x] All gates pass
- [x] A missing `SESSION_SECRET` → exit 1 naming the variable

**Phase 2 done:** [x]

---

## Phase 3: HTTP shell, auth, users (plan §5 Phase 3)

### App and server

- [x] `src/app.ts`: `createApp(deps)` with middleware in this order:
  1. [x] requestContext
  2. [x] pino-http
  3. [x] helmet (CSP)
  4. [x] urlencoded (extended) + json, 50 kb limit
  5. [x] static `/public` and `/vendor/chart.js`
  6. [x] session (connect-mongo, `pm.sid`)
  7. [x] csrf-sync
  8. [x] loadCurrentUser
  9. [x] `res.locals`
  10. [x] routers → notFound → errorHandler
- [x] `src/compositionRoot.ts`: `buildContainer()` in the exact order of plan App. E (grows each phase; ports start as no-ops)
- [x] `src/server.ts` (startup sequence plan App. F.1):
  - [x] Config → Monitor DB (fatal if down) → Source DB client (**non-blocking**; warn `sourceDb.unavailable`) → indexes (automatic outside production) → seeds → container → listen
  - [x] SIGTERM / SIGINT graceful shutdown; a second signal forces exit
  - [x] `unhandledRejection` / `uncaughtException` → fatal log + shutdown

### Middlewares

- [x] `src/middlewares/requestContext.ts`
- [x] `src/middlewares/requireAuth.ts`: pages → `/login`, API → 401 JSON
- [x] `src/middlewares/requireRole.ts`
- [x] `src/middlewares/validate.ts`: `defineValidation({params,query,body})` returns `handler(mode)`, typed `read(res)` and `formFailure(res)`; strips `_csrf` first; values on `res.locals.validated` (plan said `res.locals.input`; docs updated)
- [x] `src/utils/flash.ts`: session-backed `setFlash` / `consumeFlash` (no extra dependency)
- [x] `src/middlewares/csrf.ts`
- [x] `src/middlewares/rateLimit.ts`: `loginLimiter` (IP + email), `actionLimiter` (per user)
- [x] `src/middlewares/noStore.ts`
- [x] `src/middlewares/errorHandler.ts`: JSON envelope for `/api/v1`, error pages otherwise
- [x] `src/middlewares/notFound.ts`

### Views and assets

- [x] `src/utils/renderPage.ts`: renders the page, then wraps it in `layouts/main.ejs`
- [x] `src/views/layouts/main.ejs`
- [x] `src/views/partials/`: `head`, `nav`, `flash`, `formErrors`, `statusBadge`, `pagination`, `emptyState`
- [x] `src/views/errors/403.ejs`, `404.ejs`, `500.ejs` (show requestId only)
- [x] `src/views/pages/auth/login.ejs`
- [x] `src/public/css/app.css`
- [x] `src/public/js/confirm.js`
- [x] `src/public/js/api.js`: fetch wrapper adding `x-csrf-token`

### Health and auth modules

- [x] `modules/health/health.routes.ts`: `/healthz`; `/readyz` (both DB pings, 2 s timeout, scheduler state, no hostnames)
- [x] `modules/auth/auth.routes.ts`, `.controller.ts`, `.service.ts`, `.schemas.ts`:
  - [x] GET/POST `/login`, POST `/logout`
  - [x] Session regenerated on login; same message for every failure
  - [x] Updates `dLastLoginAt`; audit `LOGIN` (no-op dependency until Phase 4)
- [x] `modules/auth/auth.seed.ts`: `seedFirstAdmin()` only when `users` is empty; missing env → fatal naming the vars

### Users module

- [x] `modules/users/users.routes.ts`: list, new, edit (incl. `isActive` checkbox and optional password, D16), delete (all ADMIN); paths per plan App. C.1
- [x] `users.controller.ts`, `users.service.ts`, `users.repository.ts`, `users.mapper.ts`, `users.schemas.ts`, `users.types.ts`
- [x] Rules:
  - [x] Unique email → 409
  - [x] Password policy D3
  - [x] bcrypt cost 12
  - [x] Hash never mapped into the domain type
  - [x] Last active admin can't be demoted, deactivated or deleted → 409 `LAST_ADMIN`
- [x] `views/pages/users/list.ejs`, `form.ejs`

### Test helpers

- [x] `tests/helpers/testConfig.ts`
- [x] `tests/helpers/memoryMongo.ts` (created in Phase 2 for the index test)
- [x] `tests/helpers/fakeClock.ts`
- [x] `tests/helpers/factories.ts`
- [x] `tests/helpers/httpAgent.ts`: logged-in agent with CSRF, for admin or viewer
- [x] `tests/helpers/routeManifest.ts`: starts with the users routes

### Tests

- [x] `tests/integration/http/auth.test.ts`: success / failure; 429 on the 6th attempt; inactive user rejected, including mid-session; logout needs CSRF; unauthenticated → redirect / 401
- [x] `tests/integration/http/csrf.test.ts`: POST without token → 403 `CSRF_INVALID`; a form post with a valid `_csrf` passes `.strict()` validation
- [x] `tests/integration/server/startup.test.ts`: app starts and `/healthz` is 200 when the Source DB is unreachable; `/readyz` reports `sourceDb: down` without hostnames
- [x] **[C]** `tests/unit/users/users.service.test.ts`
- [x] **[C]** `tests/unit/users/users.mapper.test.ts`
- [x] **[C]** `tests/integration/http/rbac.test.ts`: table-driven over the manifest

### Done when

- [x] Gates pass
- [x] Verified without a browser: real `server.ts` smoke run on a memory MongoDB (login 303, `/` 200, `/users` 200, `/readyz` sourceDb down) plus supertest RBAC (viewer → 403 on every users route). Browser click-through happens with the Phase 11 sandbox.

**Phase 3 done:** [x]

---

## Phase 4: Audit and recipients (plan §5 Phase 4)

### Audit module

- [x] `modules/audit/audit.service.ts`: `record(...)`, strips password and hash fields
- [x] `audit.repository.ts`: append-only (no update or delete methods), plus `audit.mapper.ts` and `audit.types.ts`
- [x] Wire audit into users and auth

### Recipients module

- [x] `modules/recipients/recipients.routes.ts`: list, new, edit, delete (ADMIN)
- [x] `recipients.controller.ts`, `.service.ts`, `.repository.ts`, `.mapper.ts`, `.schemas.ts`, `.types.ts`
- [x] Rules:
  - [x] Email unique and lower-cased
  - [x] Master can't be deactivated, deleted or have its type changed → 409 `MASTER_PROTECTED`
  - [x] Master name and email are editable
  - [x] NORMAL → MASTER allowed, MASTER → NORMAL refused (D17)
  - [x] Master badge shown
- [x] `recipients.seed.ts`: `seedMasterRecipient()` when no MASTER exists; missing env → fatal
- [x] `resolveAlertRecipients('ALL' | 'MASTERS_ONLY')`: the only source of alert recipients
- [x] Audit on every change
- [x] `views/pages/recipients/list.ejs`, `form.ejs`

### Tests

- [x] **[C]** `tests/unit/recipients/recipients.service.test.ts`
- [x] **[C]** `tests/unit/recipients/recipients.mapper.test.ts`
- [x] `tests/integration/recipients/recipients.repository.test.ts`: unique email
- [x] `tests/unit/audit/audit.service.test.ts`: hash stripped
- [x] Route manifest += recipient routes

### Done when

- [x] Gates pass
- [x] Manual: master can't be deleted or deactivated; an audit row exists for each change

**Phase 4 done:** [x]

---

## Phase 5: Source data and webhook monitor CRUD (plan §5 Phase 5)

### sourceData module (the only importer of `sourceDb`)

- [x] `modules/sourceData/sourceData.service.ts`:
  - [x] `listCollections()`: nameOnly, sorted, without `system.*`
  - [x] `getLatestTimestamp(collection, key)`:
    - [x] Collection must be in the live list; key must match the regex
    - [x] Projection `{_id, key}`, `maxTimeMS`, `sort -1`, `limit 1`
    - [x] Reads nested paths for dotted keys
  - [x] `hasTimestampIndex(collection, key)` (D9)
  - [x] Frozen object; no filter, document or update parameters anywhere
- [x] `modules/sourceData/sourceData.errors.ts`
- [x] `modules/sourceData/sourceData.routes.ts`: `GET /api/v1/source/collections`, `POST /api/v1/source/validate-timestamp-key` (ADMIN, CSRF)

### Webhook monitors module

- [x] `modules/webhookMonitors/webhookMonitors.routes.ts`: list, new, detail (config only for now), edit, delete
- [x] `webhookMonitors.controller.ts`, `.service.ts`, `.repository.ts`, `.mapper.ts`, `.types.ts`
- [x] `webhookMonitors.schemas.ts`:
  - [x] Nested `threshold[value]` / `threshold[unit]`
  - [x] Check interval ≥ minimum
  - [x] `repeatInterval` required if and only if `REPEAT_EVERY`, and ≥ check interval
  - [x] Each duration uses its own unit set
- [x] Service create / update:
  - [x] FR-W2 key validation with a clear field error
  - [x] Empty collection → saved with a warning flash
  - [x] `bHasDescIndexAtSave` set; index warning flash when false
  - [x] Durations stored with `toStoredDuration`
  - [x] Audit; `schedulerPort` (no-op until Phase 9)
  - [x] Edit keeps any open incident (D15); `$set` only changed config fields, never `oState`
- [x] Delete:
  - [x] Soft delete (`dDeletedAt`)
  - [x] Close the open incident per D7 (port no-op until Phase 7)
  - [x] `scheduler.remove`; audit
- [x] Duplicate name among non-deleted monitors → 409 field error
- [x] `views/pages/webhookMonitors/list.ejs`, `form.ejs`, `detail.ejs`
- [x] `public/js/monitorForm.js`: collection dropdown (server pre-fills it when JS is off), shows repeat interval only for `REPEAT_EVERY`, "Validate key" button

### Tests

- [x] `tests/integration/sourceData/sourceData.service.test.ts`: returns `_id` + key only; `maxTimeMS` set; bad collection / key rejected (`$where`, `a..b`, 65 chars); index detection
- [x] **[C]** `tests/unit/sourceData/readOnly.static.test.ts`: forbidden method names; no `sourceDb` import outside the module
- [x] **[C]** `tests/unit/webhookMonitors/webhookMonitors.schemas.test.ts`
- [x] **[C]** `tests/unit/webhookMonitors/webhookMonitors.mapper.test.ts`
- [x] `tests/integration/http/webhookMonitors.test.ts`: valid → 303; invalid key → 400 with values kept; empty collection → warning; duplicate → 409; soft-deleted hidden
- [x] Route manifest += webhook routes and source API routes

### Done when

- [x] Gates pass
- [x] Verified by HTTP integration tests (dropdown filled, bad timestamp rejected, missing index warned). Browser click-through happens with the Phase 11 sandbox.

**Phase 5 done:** [x]

---

## Phase 6: Endpoint monitor CRUD and HTTP probe (plan §5 Phase 6, §4.4)

### Probe

- [x] `modules/endpointMonitors/httpProbe.ts` — `probeOnce` + `probe`:
  - [x] Injected `fetch`, `lookup`, `sleep`, `clock`
  - [x] One `AbortSignal.timeout` covers the whole attempt
  - [x] DNS check against the blocked list on every hop
  - [x] Manual redirects, http(s) only, `maxRedirects`
  - [x] Body always cancelled
  - [x] Error-code mapping (plan §4.4)
  - [x] Only status 200 passes; stops at the first pass; `retryCount + 1` attempts at most

### Endpoint monitors module

- [x] `modules/endpointMonitors/endpointMonitors.routes.ts`: same page set under `/endpoint-monitors`
- [x] `.controller.ts`, `.service.ts`, `.repository.ts`, `.mapper.ts`, `.schemas.ts`, `.types.ts`
- [x] Schema:
  - [x] URL: http(s) only, no credentials, ≤ 2048 chars
  - [x] Retry count 0–max; form default from config
  - [x] Interval, alert mode and repeat interval as in Phase 5
- [x] URL masked in lists, logs and emails; full URL only in the admin edit form
- [x] Delete per D7; audit
- [x] `views/pages/endpointMonitors/list.ejs`, `form.ejs`, `detail.ejs`

### Tests

- [x] **[C]** `tests/integration/probe/httpProbe.test.ts`: 200; 500 on all attempts; fail then 200; timeout; connection refused; redirect → 200; redirect loop; `ftp:` redirect; blocked address directly and via redirect; endless body doesn't hang
- [x] **[C]** `tests/unit/endpointMonitors/endpointMonitors.schemas.test.ts`
- [x] **[C]** `tests/unit/endpointMonitors/endpointMonitors.mapper.test.ts`
- [x] `tests/integration/http/endpointMonitors.test.ts`
- [x] Route manifest += endpoint routes

### Done when

- [x] Gates pass
- [x] Verified by HTTP integration tests (create, edit, delete, masking, viewer view). Browser click-through happens with the Phase 11 sandbox.

**Phase 6 done:** [x]

---

## Phase 7: Checks, incidents, runners (plan §5 Phase 7, §4.3)

### Checks module

- [x] `modules/checks/checks.service.ts` + `.repository.ts`:
  - [x] `record`
  - [x] `listForMonitor` (keyset)
  - [x] `series` (≤ 500 points, bucketed)
  - [x] `latestForMonitors`: NOT built (YAGNI): the dashboard reads `oState` instead; add it only if a feature needs it
- [x] `checks.mapper.ts`, `checks.types.ts`: webhook details include `nThresholdMs`; endpoint details include `aAttempts`

### Incidents module

- [x] `modules/incidents/incidents.service.ts` + `.repository.ts`:
  - [x] `findOpen`, `open` (duplicate key → re-read), `markAlerted`, `close(reason)`
  - [x] `listForMonitor`, `countOpen`
  - [x] `findOpenSourceError`, `openSourceError`, `addAffectedMonitor`
- [x] `incidents.mapper.ts`, `incidents.types.ts`: incl. `dLastAlertAt`, `nReminderCount`, `eCloseReason` (D7, D12)
- [x] Connect the D7 delete port in the webhook and endpoint services

### Runners

- [x] `modules/webhookMonitors/staleness.evaluator.ts` (plan §4.3)
- [x] `modules/webhookMonitors/webhookMonitors.runner.ts`:
  - [x] Load the monitor; skip if deleted, or disabled on a non-manual trigger
  - [x] Source query; a thrown error becomes `ERROR` with a safe `oError`
  - [x] Evaluate → record the check → alerts port (no-op in this phase, returns `{ openIncidentId: null }`)
  - [x] Update `oState` per plan App. B.1 (`eLastResult`, `eCurrentStatus`, `dLastCheckAt`, `iLastCheckId`, `nLastAgeMs`); ERROR leaves `eCurrentStatus` and `iOpenIncidentId` unchanged
- [x] `modules/endpointMonitors/endpointMonitors.runner.ts`: same flow with `probe()`; result OK / DOWN; sets `nLastResponseTimeMs`

### Tests

- [x] **[C]** `tests/unit/webhookMonitors/staleness.evaluator.test.ts`
- [x] `tests/integration/checks/checks.repository.test.ts`: keyset order, cursor, bucketing
- [x] `tests/integration/incidents/incidents.repository.test.ts`: one open incident per monitor even with concurrent opens; one open SOURCE_ERROR
- [x] **[C]** `tests/unit/checks/checks.mapper.test.ts`
- [x] **[C]** `tests/unit/incidents/incidents.mapper.test.ts`
- [x] `tests/integration/runners/webhookRunner.test.ts`: every FR-H1 field; ERROR when the source client is closed
- [x] `tests/integration/runners/endpointRunner.test.ts`

### Docs

- [x] `docs/database-design.md`:
  - [x] Incident fields `dLastAlertAt`, `nReminderCount`, `eCloseReason`
  - [x] `oState`: drop the counters, add `eLastResult`, `nLastAgeMs`, `nLastResponseTimeMs` (plan App. A.1)

### Done when

- [x] Gates pass

**Phase 7 done:** [x]

---

## Phase 8: Alerts, email, dispatcher (plan §5 Phase 8, §4.5–§4.8)

### Email

- [x] `src/notifications/email/transport.ts`: `createMailer(cfg)` with `send` and `verify`
  - [x] smtp mode with `SMTP_TIMEOUT_MS`
  - [x] outbox mode writes `.eml` files; a `FAIL` file in the dir → throws
- [x] `src/notifications/email/templates/layout.ts`
- [x] `templates/webhookStale.ts`: every FR-W4 field
- [x] `templates/webhookNoData.ts`
- [x] `templates/endpointDown.ts`: every FR-E3 field
- [x] `templates/reminder.ts`: open-for duration and earlier reminder count
- [x] `templates/recovered.ts`: downtime
- [x] `templates/monitorError.ts`: affected monitors and safe error text
- [x] `templates/test.ts`
- [x] Contents match plan App. H for every type, including the subjects for grouped source alerts (D19)
- [x] Every template:
  - [x] Subject per FR-A6
  - [x] HTML values escaped
  - [x] Times as UTC with the "UTC" label
  - [x] Human-readable durations
  - [x] Dashboard link

### Alerts module

- [x] `modules/alerts/alert.policy.ts`: `decideAlert`, the full table in plan §4.5, plus alert-type mapping and dedupe keys
- [x] `modules/alerts/alerts.service.ts`:
  - [x] `processCheckOutcome`: the exact 10-step order in plan §4.6
  - [x] No recipients → stored directly as FAILED with "no recipients"
  - [x] `handleSourceError`: grouping window, masters only, updates the PENDING body, monitor state untouched (plan §4.7)
  - [x] `handleSourceHealthy`: closes the outage, RECOVERED to masters
  - [x] `sendTestEmail`: `test:<uuid>`, recipients ALL
  - [x] `resend`: FAILED only, audit `RESEND`; re-resolve recipients only when the stored list is empty (D18)
  - [x] During a source outage, no policy runs for that monitor (no reminders or recovery until the first non-ERROR check, plan §4.7)
  - [x] `listForMonitor`, `listGlobal` (filters), `countFailed`
- [x] `modules/alerts/alerts.dispatcher.ts`:
  - [x] `start` (resumes on boot), poll, `nudge`, single loop
  - [x] Atomic claim
  - [x] SENT, RETRYING with config backoff, or FAILED; `nRetryIndex`
  - [x] Runs only while holding the lease
- [x] `alerts.repository.ts`: `insertPending`, `claimNext`, `markSent`, `markRetry`, `markFailed`, `requeueFailed`, `updatePendingBody`
- [x] `alerts.mapper.ts`, `alerts.types.ts`, `alerts.schemas.ts`
- [x] `alerts.routes.ts`: `POST /api/v1/alerts/:id/resend` (ADMIN, CSRF) → 202 "queued"
- [x] Runners wired to the real alerts service by swapping the port in `compositionRoot.ts` (no runner change)

### Tests (all [C])

- [x] `tests/unit/alerts/alert.policy.test.ts`: every row; reminder at exactly N and N − 1 ms; numbering; no RECOVERED in every-check; `lastAlertAt` null; STALE → NO_DATA (D4)
- [x] `tests/unit/notifications/templates.test.ts`: exact subjects, required fields, escaping, UTC
- [x] `tests/unit/notifications/transport.test.ts`: outbox writes `.eml`, FAIL file simulates SMTP down, SMTP errors never leak details
- [x] `tests/integration/alerts/alerts.service.test.ts`: stored PENDING before send; dedupe; no recipients; source outage grouping; late monitor joins the incident only; monitor state untouched; RECOVERED to masters
- [x] `tests/integration/alerts/crashRecovery.test.ts`: each crash point in plan App. F.3 (after incident open, after alert insert, after RECOVERED insert) → exactly one alert per dedupe key after the next check
- [x] `tests/integration/alerts/alerts.dispatcher.test.ts`: SENT fields; retry timing follows `[1,5,15]` and `[2]`; FAILED after `backoff.length + 1` attempts; resend only from FAILED, second → 409; racing dispatchers send once; resume PENDING on start
- [x] Route manifest += resend route

### Docs

- [x] `docs/database-design.md`: alerts += `nRetryIndex`; affected monitors in the snapshot

### Done when

- [x] Gates pass
- [x] Every critical alerting case in testing-strategy §2 has a passing test

**Phase 8 done:** [x]

---

## Phase 9: Scheduler, lease, monitor actions (plan §5 Phase 9, §4.9)

### Scheduler and lease

- [x] `src/scheduler/leaseLock.ts`: `acquireOrRenew` (upsert; duplicate key = held elsewhere), renew chain, `acquired` / `lost` events, `release`
  - [x] Self-fencing: `lost` at `lastRenewedAt + ttl − renew` when renewals fail (plan §4.9)
- [x] `src/scheduler/schedulerPort.ts`: late-bound port that breaks the service ↔ scheduler cycle (plan App. E step 10)
- [x] `onScheduled(type, id, nextRunAt | null)` → monitor services set `oState.dNextCheckAt`
- [x] `src/scheduler/scheduler.ts`:
  - [x] `start`: run all enabled now (concurrency 5)
  - [x] `upsert(type, id, reason)` (D8), `remove`, `runNow` (shared in-flight guard), `stop`, `state`
  - [x] Per-monitor `setTimeout` from `startedAt`; no replay of missed runs
  - [x] In-flight skip logged as `check.skipped`
  - [x] A failing run is caught per run; the next run is still scheduled
  - [x] Standby → `runNow` returns 409 `SCHEDULER_STANDBY`
- [x] `src/server.ts`: lease events → scheduler and dispatcher start / stop; graceful shutdown releases the lease
- [x] Real `schedulerPort` injected into the webhook and endpoint services

### Monitor actions module

- [x] `modules/monitors/monitorActions.routes.ts`, `.controller.ts`, `.service.ts` (delegates by `:type`)
- [x] `POST /api/v1/monitors/:type/:id/run`: 200 with the result, or 409; `actionLimiter`; also works on paused monitors (D14)
- [x] `POST …/pause`, `…/resume`: idempotent; scheduler remove / upsert; audit; pause keeps the incident open
- [x] `POST …/test-email`: 202 "queued"; `actionLimiter`
- [x] `GET …/checks`, `GET …/series` (Viewer)
- [x] `public/js/monitorActions.js` + buttons on the two detail pages: button disabled while running; result inline; error message + requestId on failure

### Tests

- [x] **[C]** `tests/unit/scheduler/scheduler.test.ts`: start runs all; interval; overlap skip; edit reschedules; remove; one runner throwing doesn't stop the rest; stop awaits in-flight; `runNow` already running
- [x] **[C]** `tests/integration/scheduler/leaseLock.test.ts`: second owner blocked; takeover after expiry; `lost` event; self-fence fires before expiry when the DB is unreachable
- [x] `tests/integration/http/monitorActions.test.ts`: run now stores a MANUAL check; pause; test email 202
- [x] Route manifest += action routes (viewer → 403 on run, pause, resume, test-email, resend)

### Docs

- [x] `docs/api-standards.md` §1: monitors action module
- [x] `docs/project-structure.md`: `modules/monitors/`
- [x] `docs/architecture.md` §5: composition root, startup and shutdown, lease self-fencing (plan App. E, F)

### Done when

- [x] Gates pass
- [x] Manual (`npm run dev`): checks run on schedule; emails appear in the outbox; an interval edit applies without a restart

**Phase 9 done:** [x]

---

## Phase 10: Dashboard pages and charts (plan §5 Phase 10)

### Pages

- [x] `modules/dashboard/dashboard.service.ts` + `.controller.ts` + `.routes.ts` (`GET /`):
  - [x] 6 count cards (definitions in plan App. B.2)
  - [x] Monitor table: type, status, last / next check, age or response time
  - [x] Display status derivation incl. `PAUSED` and "Not checked yet" (App. B.2); source outage banner
- [x] Layout nav filtered by role; `Cache-Control: no-store` on HTML (App. I)
- [x] Every view-model in plan App. I; `public/js/alertActions.js` (Resend)
- [x] `views/pages/dashboard/overview.ejs`
- [x] Webhook detail page (full): config, status, history (filters, keyset), incidents, alerts (+ Resend), range picker, actions
- [x] Endpoint detail page (full): same sections
- [x] View-model builders: `webhookMonitors.view.ts`, `endpointMonitors.view.ts` (formatted UTC, durations, `can.*`)

### Global alert log

- [x] `GET /alerts` + `views/pages/alerts/list.ejs`: filters for monitor, type, status and date range; FAILED rows highlighted; Resend button

### Charts

- [x] `public/js/charts.js`: reads the `data-config` attribute (not a JSON `<script>` block: script text is not entity-decoded), fetches `/series`
  - [x] Webhook: age line + threshold line
  - [x] Endpoint: response time + up/down
  - [x] UTC axis

### Tests

- [x] `tests/integration/http/pages.test.ts`: each page returns 200 for both roles with its `<h1>`; admin buttons visible to admins only
- [x] Series API (range validation, ≤ 500 points, envelope): covered in `tests/integration/http/monitorActions.test.ts` and `tests/integration/checks/checks.repository.test.ts` (no separate file)
- [x] `tests/unit/dashboard/dashboard.service.test.ts`: counts, PAUSED / ERROR display

### Docs

- [x] `docs/api-standards.md` §1: replaced with the full catalogue from plan App. C

### Done when

- [x] Gates pass
- [x] Every FR-D1–D7 page shows real data

**Phase 10 done:** [x]

---

## Phase 11: Sandbox and acceptance suite (plan §5 Phase 11, §2.2, §6)

### Sandbox

- [x] `scripts/sandbox/sandbox.ts`:
  - [x] Refuses when `NODE_ENV=production`
  - [x] Two memory servers on ports 27101 / 27102, data in `.sandbox/`
  - [x] Sets the env; starts `tsx watch src/server.ts`
  - [x] Prints the URL, credentials and commands
- [x] `scripts/sandbox/seed.ts`: the 5 launch collections plus `empty_webhooks` and `bad_ts_webhooks` with the ages in plan §2.2; `amazon_pay_webhook_data` has no index. It only connects to the memory server it started.
- [x] `scripts/sandbox/fakeEndpoints.ts`: `/ok`, `/fail`, `/slow`, `/flaky`, `/redirect-loop`, `/switch` on 127.0.0.1:4010
- [x] `scripts/sandbox/controlServer.ts`: 127.0.0.1:4011 only
- [x] `scripts/sandbox/ctl.ts` commands:
  - [x] `insert-webhook`
  - [x] `source-down`, `source-up`
  - [x] `endpoint-status`
  - [x] `mail-down`, `mail-up`
  - [x] `outbox`
  - [x] `reset` (confirms y/N)

### Acceptance tests (`tests/acceptance/`, one per requirements §9 criterion)

- [x] `01-create-webhook-monitor.test.ts`
- [x] `02-stale-once.test.ts`
- [x] `03-recovered.test.ts`
- [x] `04-endpoint-down.test.ts`
- [x] `05-every-check.test.ts`
- [x] `06-repeat-every.test.ts`
- [x] `07-source-outage.test.ts`
- [x] `08-config-changes.test.ts`
- [x] `09-smtp-down.test.ts`
- [x] `10-recipients.test.ts`
- [x] `11-viewer-readonly.test.ts`
- [x] `12-live-reschedule.test.ts`
- [x] `13-source-read-only.test.ts`

### Docs

- [x] `README.md`: purpose, prerequisites, run commands (plan §2), link to the runbook, real-mode setup
- [x] `docs/project-structure.md`: `scripts/sandbox/`, `tests/acceptance/`
- [x] `docs/testing-strategy.md`: Jest projects, `test:acceptance`

### Done when
- [x] `npm run sandbox` starts with one command (verified live: up in ~4 s)
- [x] `npm run test:acceptance` passes (13 suites / 44 tests)
- [x] Manual runbook (plan §6). Rows marked LIVE were driven against the running sandbox over HTTP/ctl in this session; the others are proven by the matching acceptance file (same behaviour, deterministic clock). A click-through in a real browser has NOT been done (no browser available here):
  - [x] 1 · Create monitor / reject invalid key: LIVE + acceptance 01
  - [x] 2 · STALE once: LIVE + acceptance 02
  - [x] 3 · RECOVERED + incident duration: LIVE + acceptance 03
  - [x] 4 · Endpoint DOWN / flaky has no alert: LIVE + acceptance 04
  - [x] 5 · Every check: acceptance 05
  - [x] 6 · Repeat every N: acceptance 06
  - [x] 7 · Source outage → MONITOR_ERROR to masters → RECOVERED: LIVE + acceptance 07
  - [x] 8 · Config change / invalid config stops startup: acceptance 08 (incl. real entry point exit code 1)
  - [x] 9 · SMTP down → FAILED → Resend: LIVE (retry then SENT) + acceptance 09
  - [x] 10 · Recipients (inactive / master): acceptance 10
  - [x] 11 · Viewer is read-only (UI + API): acceptance 11
  - [x] 12 · Live reschedule / pause / resume: acceptance 12
  - [x] 13 · Source DB read-only: acceptance 13

**Phase 11 done:** [x]

---

## Phase 12: Hardening and handover (plan §5 Phase 12)

- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run format:check`
- [x] `npm run test:all`
- [x] `npm run build`
- [x] `npm audit --omit=dev`: 0 vulnerabilities (dev-only jest/glob advisories exist and are not shipped)
- [x] Production-like run (`NODE_ENV=production`, dev resources):
  - [x] Secure cookie behind `TRUST_PROXY`
  - [x] CSP headers (`curl -I`)
  - [x] `/readyz` contains no hostnames
- [x] Grep checks:
  - [x] No `console.`
  - [x] No `process.env` outside `src/config`
  - [x] No `<%-` except `include`
  - [x] No `any`
- [x] Docs status "Proposed" → "Implemented" where true; TD-08/09/11/12/13 → Accepted
- [x] `CLAUDE.md` Status updated
- [x] Security mapping (plan App. J): every row's "Verified by" item exists and passes
- [x] Failure-mode matrix (plan App. F.3): every row has its test or documented acceptance
- [x] Final report (CLAUDE.md format)

> **Every phase** also satisfies the Definition of Done in plan App. K before it is ticked.

**Phase 12 done:** [x]

---

## Log

- 2026-11-18: Plan and tracker created. No code, no dependencies installed.
- 2026-11-18: User has Redis running locally and decided not to use it; the design stays Redis-free.
- 2026-11-18: Tracker expanded into a full per-task checklist covering every file, test, gate and doc update in the plan.
- 2026-11-18: Senior review of the plan. Added D14–D19 and appendices A–K (data model, state machines, routes, validation, composition root, startup/shutdown/failure modes, logs, emails, view-models, security mapping, DoD). Tracker synced. Fixed: `_csrf` vs `.strict()`, non-blocking Source DB at boot, lease self-fencing, service ↔ scheduler cycle, Phase 7 no-op port.
- 2026-11-18: Phase 0 done. D1–D19 accepted as defaults, npm install approved. TD-17…TD-28 and NEW config keys added to docs.
- 2026-11-18: Phase 1 started [~].
- 2026-11-18: Phase 1 done. Real results: typecheck ok, lint ok, format:check ok, `npm test` 1 passed (smoke), build ok, `node dist/server.js` + curl /healthz → {"status":"ok"}. Installed: express 5.3, mongodb 7.9, zod 4.6, jest 30 / ts-jest 29, typescript 6.0, eslint 10 (versions in lockfile). `npm audit` flags only dev-only jest/glob (moderate); `npm audit --omit=dev` to be checked in Phase 12.
- 2026-11-18: Incident: `prettier --write .` reformatted CLAUDE.md, .claude/rules and docs/*.md. User approved restore; restored via git checkout, Phase 0 additions re-applied, `.prettierignore` now excludes docs, CLAUDE.md, README.md, .claude.
- 2026-11-18: Phase 2 started [~].
- 2026-11-18: Phase 2 done. Real results: typecheck ok, lint ok, format:check ok, `npm test` 7 suites / 80 tests passed (unit + integration incl. indexes on mongodb-memory-server 7.0.14), build ok. `node dist/config/index.js` with SESSION_SECRET missing → exit 1, stderr names only the variable. Notes: (1) MongoDB rejects `{field: null}` in partialFilterExpression, so unique partial indexes use `{ $type: "null" }`; documents must store `dDeletedAt` / `dClosedAt` as explicit null (documented in indexes.ts; update database-design.md in Phase 7 doc task). (2) Logger is created via `createLogger` and injected; no global `logger`. (3) mongodb 7 deprecates the 2-arg `createIndex`; `indexes.ts` uses the 3-arg overload.
- 2026-11-18: Phase 3 started [~].
- 2026-11-18: Phase 3 done. Real results: typecheck ok, lint ok, format:check ok, `npm test` 13 suites / 120 tests passed, build ok. Smoke (scratchpad script, memory MongoDB, real `src/server.ts` via tsx): `/healthz` 200, `/readyz` {"monitorDb":"up","sourceDb":"down"}, login 303 → `/` 200, `/users` 200 (connect-mongo sessions work with mongodb 7). Notes: (1) validation helper is `defineValidation` (docs/rules updated). (2) `src/compositionRoot.ts`, `modules/audit/audit.types.ts` + `audit.noop.ts` (port, replaced in Phase 4), `modules/dashboard/dashboard.routes.ts` (placeholder overview, replaced in Phase 10) were added. (3) Login limiter uses `skipSuccessfulRequests`, so only failed attempts count; test config sets a high limit by default and the rate-limit test uses the real `5 per 15 min`. (4) `/vendor/chart.js` is served from `<root>/node_modules/chart.js/dist` (chart.js has no exported package.json).
- 2026-11-18: Phase 4 started [~].
- 2026-11-18: Phase 4 done. Real results: typecheck ok, lint ok, format:check ok, `npm test` 19 suites / 160 tests passed (3 consecutive runs), build ok. Bug found by a test and fixed: `checkboxSchema` treated an omitted key (unchecked HTML checkbox) as invalid; it is now `.optional()` and has a regression test. Test helper `startTestMongo` now retries (mongod occasionally loses a startup race when many suites start at once). Notes: (1) audit `oBefore`/`oAfter` store camelCase domain snapshots (documented exception to TD-16) and audit docs use `dAt` only; add both to database-design.md in the Phase 7 docs task. (2) `audit.noop.ts` was removed once the real audit service was wired. (3) Master recipients: `isActive` is forced true on create/update; the edit form submits hidden `type=MASTER` and `isActive=on`; MASTER→NORMAL → 409 `MASTER_PROTECTED`; NORMAL→MASTER allowed (D17). (4) Seed promotes an existing same-email recipient to master instead of failing.
- 2026-11-18: Phase 5 started [~].
- 2026-11-18: Phase 5 done. Real results: typecheck ok, lint ok, format:check ok, `npm test` 24 suites / 253 tests passed, build ok. Highlights: runtime read-only proof (a command-monitoring test shows only find/listCollections/listIndexes reach the server; find carries projection `{_id,key}`, `maxTimeMS`, `limit 1`, empty filter) plus a static scan (no write/admin method names in `modules/sourceData`, only `server.ts` imports the Source DB client). Added beyond the plan list: `sourceData.validation.ts`, `sourceData.controller.ts`, `src/utils/response.ts` (`sendData` envelope), `src/types/monitorState.ts` + `src/utils/monitorState.ts` (shared `oState`), `src/utils/displayStatus.ts`, `src/utils/labels.ts`, `src/scheduler/schedulerPort.ts` (no-op until Phase 9), `modules/incidents/incidents.port.ts` (no-op until Phase 7), `inspectTimestampKey` in the sourceData service. Notes: (1) `buildServices` now needs `sourceDb: Db` (read-only handle); tests seed a second database on the same memory server. (2) Webhook schemas are a factory (`createWebhookMonitorValidations(limits)`) because min interval and days-per-month come from config. (3) Monitor `dDeletedAt` is stored as explicit null for the partial unique index. (4) Pending doc updates (do in Phase 7 docs task): database-design.md for `$type: null` partial indexes, audit `dAt` + snapshot exception, `oState` fields (`nLastAgeMs`, `nLastResponseTimeMs`, `eLastResult`).
- 2026-11-18: Phase 6 started [~].
- 2026-11-18: Phase 6 done. Real results: typecheck ok, lint ok, format:check ok, `npm test` 28 suites / 334 tests passed, build ok. Probe tests run against a local `http.createServer` (200, 500 on all attempts, fail-then-200, timeout, refused port, DNS failure, redirect OK/loop/ftp/credentials/no-Location, metadata IP direct/resolved/via redirect, endless bodies). Bugs found and fixed by tests: (1) error classification used `instanceof Error`, which fails for fetch errors from another realm; it is now duck-typed. (2) blank "Retry count" coerced to 0; now a validation error. Notes: (1) fetch refuses well-known "bad ports" (for example 1, 25) with NETWORK_ERROR; a monitored endpoint on such a port cannot be probed. (2) Shared interval/repeat validation moved to `src/utils/monitorValidation.ts` (used by webhook and endpoint schemas). (3) `ALERT_MODE_OPTIONS`/`DURATION_UNIT_OPTIONS` are imported by the endpoint controller from the webhook view module; move them to `src/utils` if a third consumer appears. (4) `httpProbe.deps.ts` holds the production wiring (native fetch, system resolver); DNS is resolved once for the SSRF check and again by fetch (accepted TOCTOU, security 2.9).
- 2026-11-18: Phase 7 started [~].
- 2026-11-18: Phase 7 done. Real results: typecheck ok, lint ok, format:check ok, `npm test` 35 suites / 390 tests passed, build ok. Added: `src/utils/monitorState.ts` `toStateSet`/`MonitorStatePatch`; `modules/alerts/alerts.port.ts` (`AlertsPort`, `MonitorSnapshot`, `noopAlertsPort`); `modules/checks/checkRunner.ts` (`CheckRunner` interface for the scheduler); `updateState` on both monitor repos/services; runners exposed as `services.runners.{WEBHOOK,ENDPOINT}`; `buildServices` accepts `alerts`, `probeDeps`, `scheduler`. Behaviour proven by tests: check stored BEFORE alerts are called; if alerting throws the check and monitor state are still saved and the error is rethrown; during ERROR `eCurrentStatus` is unchanged; monitor snapshot carries a masked URL; a deleted monitor closes its incident with MONITOR_DELETED (D7). docs/database-design.md updated (oState fields, incident fields, audit dAt + snapshot exception, `$type: null` partial indexes); the `alerts` collection additions (`nRetryIndex`, snapshot extras) are still a Phase 8 docs task.
- 2026-11-18: Phase 8 started [~].
- 2026-11-18: Phase 8 CODE done (tests pending): `notifications/email/transport.ts` (smtp + outbox with FAIL-file switch, safe `MailSendError`), `templates/*` (+ `buildAlertEmail`), `alert.policy.ts`, `alerts.{types,mapper,repository,service,dispatcher,schemas,controller,routes,port}.ts`, composition root wiring (`mailer`, `dispatcher`, `alerts`), `POST /api/v1/alerts/:id/resend`, `tests/helpers/fakeMailer.ts`, `server.ts` starts/stops the dispatcher (Phase 9 moves it under the lease). Gates at this point: typecheck ok, lint ok, 35 suites / 391 tests pass (no new Phase 8 tests yet). Design notes: grouped source-outage alerts keep `aAffectedMonitors` at the top level of the alert doc; the outage mail is `dNextAttemptAt = incident.openedAt + SOURCE_ERROR_GROUP_WINDOW_MS`; on recovery a still-pending outage mail is expedited and the RECOVERED mail is due 1 ms later so the order is right.
- 2026-11-18: Phase 8 done. Real results: typecheck ok, lint ok, format:check ok, `npm test` 42 suites / 503 tests passed (4 consecutive runs), build ok. Verified by tests: store-first (the mailer reads the DB while sending and finds the same rendered email stored as PENDING); SENT only after acceptance; PENDING→RETRYING→SENT following the 1,5 min backoff; FAILED after backoff.length+1 attempts; `EMAIL_RETRY_BACKOFF_MIN=2` changes behaviour; resend works from FAILED only (second click 409); two racing dispatchers send each alert once; start() resumes PENDING/RETRYING alerts; locked alerts are skipped until the lock expires (at-least-once); canRun=false sends nothing; all crash points of plan App. F.3; once+recovery, every-check, repeat-every (1 open + 2 reminders + 1 RECOVERED for a 1 h outage), STALE→NO_DATA same incident, source outage grouping (one alert, masters only, late monitors join the incident only, concurrent failures lose no monitor, recovery ordering); templates carry every FR-W4/FR-E3 field, escape HTML, end all times with UTC, and cannot inject headers. Notes: (1) `startTestMongo` now uses a 60 s launch timeout and 5 retries (an occasional `mongod` startup race when many suites start at once). (2) Nodemailer encodes the en dash in subjects as an RFC 2047 word; mail clients show it normally. (3) database-design.md updated with the alerts fields. (4) The dispatcher is started by `server.ts` for now; Phase 9 gates it with the lease via `canDispatch`.
- 2026-11-18: Phase 9 started [~].
- 2026-11-18: Phase 9 CODE done (UI script + tests pending): `src/scheduler/{leaseLock,scheduler,schedulerPort}.ts`, `modules/monitors/*` (run/pause/resume/test-email/checks/series), `setEnabled` on both monitor services, composition root builds the scheduler and binds the late port, `server.ts` starts/stops scheduler + dispatcher from the lease (dispatcher `canDispatch: lease.isHeld`), new config key `SCHEDULER_CONCURRENCY` (default 5; requirements 5.1, .env.example, env test updated). Incident: a script line truncated `src/server.ts`; it was rewritten from the earlier printed content and all gates re-run green (511 tests). Lesson: never `open(p, "w").write(open(p).read())`.
- 2026-11-18: Phase 9 done. Real results: typecheck ok, lint ok, format:check ok, `npm test` 45 suites / 564 tests passed, build ok. Verified: scheduler with virtual time (first run at start, interval measured from run start, no drift or replay, overlap skip with `check.skipped`, a throwing runner never stops others, live create/edit/remove/resume per D8, concurrency cap, run-now 409 ALREADY_RUNNING / SCHEDULER_STANDBY, graceful stop waits then times out); lease (acquire, exclusion among 6 instances, renewal, takeover after expiry, release on stop, **self-fencing steps down before the lease expires and another instance cannot take it until it does**); monitor actions over HTTP (run stores a MANUAL check, pause unschedules and keeps the incident open and is idempotent/audited, resume runs a check at once, test email 202 queued, history keyset + filters, series incl. range validation, rate limit 429, viewer read-only, buttons only for admins and no inline JS). Fixes: Jest project-level `testTimeout` is ignored, so `tests/setup/timeout.ts` (`jest.setTimeout(120000)`) is now a `setupFilesAfterEnv` for integration/acceptance; this removes the recurring "suite failed to run" caused by `afterAll(mongo.stop())` exceeding 5 s. Docs updated: api-standards, project-structure, architecture §5.5. Manual item ("npm run dev: checks run on schedule, emails in outbox") is covered by the Phase 11 sandbox.
- 2026-11-18: Phase 10 started [~].
- 2026-11-18: Phase 10 done. Real results at phase end: typecheck ok, lint ok, format:check ok, build ok, `npm test` 47 suites / 593 tests (one intermittent failure in `monitorActions` pause test was reproduced and fixed: a test race where the first scheduled check legitimately closed the manually opened incident; the test now waits for the first check; file then passed 3 consecutive isolated runs). New: dashboard service + overview page (6 cards, outage banner, table), shared `monitors/monitorDetail.ts` builder (history with filters + keyset "Older", incidents, alerts + Resend, chart settings), `GET /alerts` page, `charts.js`, `alertActions.js`, partials (pagination, alertsTable, monitorExtras), CSS. Verified by tests: every page renders for admin and viewer with `no-store`; HTML escaping of monitor names; chart/scripts served locally; no inline `<script>`; Resend and action buttons only for admins; filters, malformed filters 400, paging. Process notes: (1) targeted test runs must use `NODE_OPTIONS=--experimental-vm-modules npx jest <path>`; `npm test -- <path>` ignores the path (the script passes `--selectProjects unit integration`). (2) A browser click-through of the charts is still pending (needs the Phase 11 sandbox); chart rendering code is exercised only by serving assets, not by a headless browser.
- 2026-11-18: Phase 11 started [~].
- 2026-11-18: Phase 11 sandbox done and run LIVE (not just compiled): `scripts/sandbox/{sandbox,seed,fakeEndpoints,controlServer,ctl}.ts`. Verified against the real running app via HTTP: boots in ~4 s; login; collection dropdown lists seeded collections; `bad_ts_webhooks` rejected with a clear message; stale monitor → exactly one `WEBHOOK_STALE` email (to the master only, the only recipient) in `.sandbox/outbox`; `insert-webhook` + run-now → `RECOVERED` email and an incident row with duration on the detail page; endpoint `/fail` (retry 2) → one `ENDPOINT_DOWN`, `/flaky` → no email; restart keeps data and the lease transfers (`/readyz` leader); `source-down` → exactly one `MONITOR_ERROR` (master only, 1 monitor) and `/readyz` sourceDb down; `source-up` → `RECOVERED – Source DB`; `mail-down` + test email → alert RETRYING, `mail-up` → SENT. Fixed while testing: RFC 2047 header decoding in `ctl outbox` (adjacent encoded words). The sandbox only sets connection settings itself; tuning values (e.g. EMAIL_RETRY_BACKOFF_MIN) can still come from `.env`/shell. Throwaway `.sandbox/` data from this test run was deleted.
- 2026-11-18: Phase 11 done. Real results: typecheck ok, lint ok, format:check ok, `npm test` 47 suites / 593 tests passed, `npm run test:acceptance` 13 suites / 44 tests passed, build ok. Acceptance suites drive the real pipeline (HTTP forms → runners → incidents → stored alerts → dispatcher → fake mailer) with a fake clock; 07 uses a switchable Source DB (real seeded DB vs unreachable), 12 injects virtual timers into the real scheduler (`buildServices({ timers })`), 13 uses command monitoring to prove only find/listCollections/listIndexes reach the Source DB (projection `{_id, dCreatedAt}`, limit 1, maxTimeMS) and a SHA-256 fingerprint of every source document and index is unchanged after a full run. Finding: the RECOVERED-source email is due 1 ms after storage (so it cannot overtake the outage mail); tests with a frozen clock must advance it. README written. docs/project-structure and docs/testing-strategy updated.
- 2026-11-18: Phase 12 started [~].
- 2026-11-18: Phase 12 done, v1 COMPLETE. Final gates (run once at the end): typecheck ok, lint ok, format:check ok, `npm test` 48 suites / 598 tests, `npm run test:acceptance` 13 suites / 44 tests, build ok, `npm audit --omit=dev` 0 vulnerabilities. Production-like run (compiled app, NODE_ENV=production, throwaway memory MongoDB): CSP + HSTS + referrer policy + nosniff present, no x-powered-by, `no-store` on HTML, session cookie HttpOnly/Secure/SameSite=Lax behind `X-Forwarded-Proto: https` (and correctly NOT set over plain http), `/readyz` shows no hostnames, 404 page and API errors leak no stack/paths, logs contain no secrets, SIGTERM exits 0 with app.stopping/app.stopped logged. Greps: no `console.`, no `process.env` outside `src/config`, no `any`, no inline scripts/handlers, only `<%- body %>` besides includes. Added security-control tests (bcrypt cost, cookie flags, no CORS, session id changes on login). Docs statuses moved to Implemented; TD-08/09/11/12/13/14 Accepted; CLAUDE.md Status updated; README has the production HTTPS note. Known gaps (also in the final report): no browser click-through or headless chart rendering test; "Monitor DB down at runtime" is proven by the lease self-fencing test, not end to end; email delivery is at-least-once (one duplicate is possible if the process dies between SMTP accepting and the status update); `checks` grows unbounded by design (FR-H3), a retention decision is open.
- 2026-11-19: Pre-production review fixes (`docs/review_opus.md`, plan `docs/implementation_plans/review-fixes-opus.md`). Fixed: H1 (24 h max interval + timer guard, TD-30), H2 (per-collection source errors are the monitor's own MONITOR_ERROR, TD-29), H3 (failed leader start releases the lease and retries), M1 (lease watchdog + time-based fence, TD-32), M2 (atomic join of grouped outage alert), M3 (BlockList + connection-pinned probe), M4 (indexes at every startup, fatal on failure, TD-31), M5 (outbox refused in production), M6 (dispatcher claim token + send deadline, TD-32), M7 (concurrency cap for webhook checks only), M8 (one find per check), M9 (lease released in parallel with HTTP drain), M10 (`src/runtime.ts` + wiring tests, TD-33). Low items L1–L13 pending. Gates (one full run): typecheck ok, lint ok (after a one-line test fix), format:check ok, build ok, `npm run test:acceptance` 14 suites / 47 tests passed, `npm test` 50 suites / 644 tests with **1 failure**: `tests/integration/server/runtime.test.ts` "stops checks, releases the lease, closes the databases, then exits with the code" (`MongoClientClosedError`: an operation was still in flight when shutdown closed the Monitor DB client). Not yet fixed. Manual: local `npm run dev` with real local MongoDB and Gmail SMTP; alert stored → RETRYING on `SMTP_AUTH` (bad credentials), then SMTP login verified OK after the App Password was corrected.
- 2026-11-19: Product name from `APP_NAME` (plan `docs/implementation_plans/app-name-from-env.md`, TD-35), IMPLEMENTED, not committed. `APP_NAME` (default `payMonitor`, 1-40 chars, no control characters) now drives what people see: page title and brand (`res.locals.appName`), email subject prefix `[<APP_NAME>]` (FR-A6), both email footers and the per-monitor error wording (`EmailContext.appName`), the no-index warning, and the startup log message. Technical identifiers (Mongo appName, log `service`, default DB name, `payMonitorApi`, cookie) unchanged on purpose; stored alerts keep the old name. Docs: requirements FR-A6 and §5.1, `.env.example`, README, TD-35. Gates (second run): typecheck ok, lint ok, format:check ok, `npm test` 50 suites / 670 tests passed, `npm run test:acceptance` 14 suites / 47 tests passed, build ok. The first run failed lint (fixed) and the new runtime test failed under load; that exposed the known shutdown flake (connect-mongo's background sessions-index creation is never awaited in `src/runtime.ts`; the earlier failing shutdown test passed this time but the cause is unfixed; proposed fix recorded in the plan's progress log).
