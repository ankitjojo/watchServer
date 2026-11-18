# payMonitor — Testing Strategy & Quality Gates

> Status: **Proposed** — no test setup exists yet (no `package.json`). Framework: **Jest** (user decision, TD-10). Rules for Claude: `.claude/rules/testing.md`.

---

## 1. Test layers

| Layer | Location | Tools | What |
|-------|----------|-------|------|
| Unit (pure) | `tests/unit/**` | Jest | Evaluators, alert policy, duration/timestamp utils, Zod schemas, email template builders |
| Unit (service) | `tests/unit/**` | Jest + in-memory fakes | Services with fake repositories, fake clock, fake mailer |
| Integration (DB) | `tests/integration/**` | Jest + `mongodb-memory-server` | Repositories, indexes (uniqueness, partial indexes), dispatcher claim, lease lock |
| Integration (HTTP) | `tests/integration/http/**` | `supertest` against `createApp(deps)` | Auth, RBAC, CSRF, validation errors, response envelope, page renders |
| Probe | `tests/integration/probe/**` | Local `http.createServer` | 200 / 500 / timeout / redirect loop / max redirects / connection refused |
| Manual | checklist in PR | Browser + Mailtrap-like SMTP sandbox | Visual layout, email rendering, charts |

## 2. Risk-based coverage (instead of a % target)

Must have tests before merge (**critical** — each is a requirement with money-impacting consequences if wrong):

| Area | Cases |
|------|-------|
| `evaluateStaleness` | age == threshold (OK), threshold+1ms (STALE), empty (NO_DATA), invalid ts (NO_DATA), seconds vs ms epoch, ISO string, future timestamp |
| Duration utils | every unit incl. `month` × `DAYS_PER_MONTH`, min interval, repeat ≥ check interval |
| `decideAlert` policy | all 3 modes × transitions OK→fail, fail→fail, fail→OK; reminder timing at exactly N, before N; reminder count; no recovery mail for EVERY_CHECK |
| Source outage (FR-A4a) | masters only, grouping into one incident, monitor state unchanged, recovery mail |
| Store-first + dispatcher | alert stored before send; SMTP fail → RETRYING with backoff from config → FAILED; resend only from FAILED; dedupe key prevents duplicate; resume on restart |
| Recipients | inactive excluded, masters always included, master undeletable/undeactivatable, no-recipient → FAILED reason |
| RBAC | viewer gets 403 on every mutating route (table-driven over the route map) |
| Endpoint probe | DOWN only when all attempts fail; success on retry → no alert |
| Scheduler | in-flight skip, upsert/remove reschedules, lease lost stops timers, graceful stop awaits in-flight |
| Config | invalid `EMAIL_RETRY_BACKOFF_MIN` etc. → startup error naming the variable |
| Mappers (TD-16) | doc → domain → doc round-trip keeps every field; optional/null fields; old docs missing new optional fields still map |

Lower priority: simple CRUD happy paths (one per module), EJS render smoke tests (page returns 200 and contains key heading).

## 3. Techniques

- **Time**: inject `Clock`; use a `FakeClock` in policy/service tests. Use Jest fake timers only for scheduler tests (`jest.useFakeTimers({ now })`).
- **Mocks in ESM**: prefer dependency injection; `jest.mock` hoisting doesn't work under ESM. Use `jest.unstable_mockModule` only as a last resort.
- **Email**: inject a fake transport that records messages and can be told to fail N times.
- **Source DB**: in integration tests, a second database on the same memory server seeded with webhook-like docs (`{ dCreatedAt: Date }`), opened through the same read-only `sourceData` module.
- **Data isolation**: each test file gets a unique DB name; `afterEach` drops collections; no shared mutable fixtures. Factories in `tests/helpers/factories.ts`.
- **Never** point tests at real `MONGO_URI` / `SOURCE_MONGO_URI` / SMTP. Test config is built in code, not from `.env`.

## 4. Jest configuration notes (ESM)

```js
// jest.config.js (Proposed)
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },   // allow .js imports to resolve .ts
  transform: { '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.test.json' }] },
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
};
```
Script: `"test": "NODE_OPTIONS=--experimental-vm-modules jest"` (use `cross-env` if Windows dev machines exist — [Open]).

## 5. Quality gates (every change)

Run in this order; report each command and its actual result. **Never claim a gate passed without running it.**

| # | Command (Proposed scripts) | Gate |
|---|----------------------------|------|
| 1 | `npm run typecheck` (`tsc --noEmit -p tsconfig.test.json`) | 0 errors |
| 2 | `npm run lint` (`eslint .`) | 0 errors |
| 3 | `npm run format:check` (`prettier --check .`) | clean |
| 4 | `npm test` (or targeted `npm test -- <path>` for small changes, full suite before finishing) | all pass |
| 5 | `npm run build` (`tsc -p tsconfig.json`) | succeeds |
| 6 | `npm audit --omit=dev` (when dependencies change) | no high/critical without a note |
| 7 | Manual check (UI/email changes) | described in the report |

Until `package.json` exists, these gates cannot run — say so explicitly instead of skipping silently.

## 6. Proposed dependencies (NOT installed — require approval)

| Package | Kind | Purpose | Already covered? |
|---------|------|---------|------------------|
| `express@5` | runtime | HTTP server | — |
| `ejs` | runtime | Views | — |
| `mongodb` | runtime | Both DB clients | — |
| `nodemailer` | runtime | SMTP | — |
| `zod` | runtime | Env, request, source-value validation | Same as source backend |
| `pino`, `pino-http` | runtime | Structured logs, request logs | — |
| `helmet` | runtime | Security headers/CSP | — |
| `express-session`, `connect-mongo` | runtime | Sessions in Monitor DB (no Redis) | — |
| `bcrypt` | runtime | Password hashing | Native addon; `bcryptjs` if build tools are a problem |
| `csrf-sync` | runtime | CSRF synchronizer token (TD-11) | — |
| `express-rate-limit` | runtime | Login & action limits (memory store OK for single instance) | — |
| `chart.js` | runtime (static asset) | Dashboard charts (TD-13) | — |
| `typescript`, `tsx`, `@types/node`, `@types/express`, `@types/ejs`, `@types/nodemailer`, `@types/express-session`, `@types/bcrypt` | dev | Build & dev run | — |
| `jest`, `ts-jest`, `@types/jest` | dev | Tests (TD-10) | — |
| `supertest`, `@types/supertest` | dev | HTTP tests | — |
| `mongodb-memory-server` | dev | Real Mongo in tests (downloads a mongod binary on first run) | — |
| `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `eslint-plugin-import-x` | dev | Lint + no-cycle | — |
| `prettier` | dev | Format | — |
| `pino-pretty` | dev | Readable dev logs | — |

Deliberately **not** proposed: `dotenv` (Node `process.loadEnvFile`), `axios`/`node-fetch` (native fetch), `node-cron`/`bullmq`/`agenda` (TD-05), `cors` (same-origin), `nock` (local test server), `husky` (add only if the team wants pre-commit hooks — not justified for a solo start).
