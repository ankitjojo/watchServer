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

### TD-04 · Field naming in Monitor DB — Accepted
- **Decision**: Plain camelCase (`name`, `isActive`, `createdAt`). Source DB fields are referenced exactly as they exist (`dCreatedAt` etc.) — they are an external contract.
- **Trade-off**: Differs from the source backend's Hungarian prefixes; never "translate" source field names.

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

### TD-08 · Durations stored as entered + normalized ms — Proposed
- **Decision**: Store `{ value: number, unit: DurationUnit, ms: number }`. `ms` computed on save using `DAYS_PER_MONTH` at that time.
- **Why**: Show admins what they typed; logic uses `ms`. Changing `DAYS_PER_MONTH` affects only monitors saved afterwards — explicit and predictable.
- **Trade-off**: Requires a recompute script if the team ever wants existing monitors re-normalized.

### TD-09 · Alert idempotency via dedupe keys (no transactions required) — Proposed
- **Decision**: `alerts.dedupeKey` unique index. Keys:
  `incident:<incidentId>:open`, `incident:<incidentId>:reminder:<n>`, `incident:<incidentId>:recovered`, `check:<checkId>:every` (Every-check mode), `sourceError:<incidentId>:open|recovered`, `test:<uuid>`.
  Duplicate-key error on insert = already created → treat as success.
- **Why**: Store-first + crash/restart must never produce duplicate emails; works without a replica set (open question A1).

### TD-10 · Testing — Accepted (Jest)
- **Decision**: Jest + `ts-jest` (ESM preset, run with `NODE_OPTIONS=--experimental-vm-modules`), `supertest` for HTTP, `mongodb-memory-server` for repository/integration tests. Endpoint probes tested against a local `http.createServer` (no HTTP-mocking library). Nodemailer replaced by an injected fake transport.
- **Trade-off**: Jest ESM support is still flagged experimental; `jest.mock` hoisting does not work in ESM — use dependency injection or `jest.unstable_mockModule`. Prefer DI.

### TD-11 · Sessions & CSRF — Proposed
- **Decision**: `express-session` + `connect-mongo` (sessions in Monitor DB; no Redis). CSRF: synchronizer token stored in the session — **`csrf-sync`** (same author as `csrf-csrf`; session-based variant fits because we already have server sessions).
- **Note**: User approved "csrf-csrf"; `csrf-sync` is the session-backed sibling. Confirm before install.

### TD-12 · Endpoint probing with native fetch — Proposed
- **Decision**: Native `fetch` with `redirect: 'manual'` and a manual redirect loop (to honour `ENDPOINT_MAX_REDIRECTS`), `AbortSignal.timeout(ENDPOINT_TIMEOUT_MS)`. Response body is never read beyond what is needed to release the socket (`res.body?.cancel()`).
- **Why**: No dependency; native fetch's built-in redirect follow ignores a custom max.

### TD-13 · Charts — Proposed
- **Decision**: Chart.js installed via npm and served from a static route (`/vendor/chart.js`) — no CDN, so CSP stays `script-src 'self'`.

### TD-14 · Environment loading — Proposed
- **Decision**: `process.loadEnvFile()` (Node ≥ 20.12) in dev when `.env` exists; no `dotenv` dependency. Production supplies real env vars.

### TD-15 · Soft delete for monitors — Accepted (requirements FR-D2)
- **Decision**: `deletedAt` timestamp; all list queries filter `deletedAt: null`; history remains linked.
