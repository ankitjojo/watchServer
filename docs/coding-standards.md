# payMonitor — Coding Standards

> Applies to all code in `src/` and `tests/`. Short enforceable versions live in `.claude/rules/typescript.md` and `.claude/rules/code-quality.md`.
> Related: [architecture.md](architecture.md) (layers), [api-standards.md](api-standards.md), [security.md](security.md).

---

## 1. TypeScript configuration (`tsconfig.json`)

Mirrors the source backend's strictness, plus checks it left commented out:

```jsonc
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "rootDir": "./src",
    "outDir": "./dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```
Tests use a `tsconfig.test.json` extending this with `rootDir: "."` and `include: ["src", "tests"]`.

## 2. TypeScript rules

| Rule | Example |
|------|---------|
| No `any`. Untrusted values are `unknown` and narrowed with Zod. | `const body = createWebhookMonitorSchema.parse(req.body);` |
| Exported functions declare return types. | `export async function getLatestTimestamp(...): Promise<LatestDocResult>` |
| No `!` non-null assertions; no `as` casts on untrusted data. `as const` is fine. | ❌ `doc!.dCreatedAt as Date` ✅ narrow with `instanceof Date` / schema |
| No `@ts-ignore`. `@ts-expect-error` only with a reason comment and a linked issue. | |
| Derive types from Zod schemas instead of writing them twice. | `type CreateWebhookMonitorInput = z.infer<typeof createWebhookMonitorSchema>;` |
| Use discriminated unions for results/states. | see §3 |
| Relative imports end in `.js` (ESM/nodenext). Type-only imports use `import type`. | `import type { Clock } from '../../types/clock.js';` |
| `noUncheckedIndexedAccess` is on: handle `undefined` from array/record access. | `const [latest] = docs; if (!latest) return { kind: 'NO_DATA' };` |
| `exactOptionalPropertyTypes` is on: don't assign `undefined` to optional props; omit them. | |

## 3. Constants & domain values

Domain values are `as const` objects + derived union types in `src/constants/` — **not** TS `enum` (no runtime reverse mapping, works with Zod `z.enum`).

```ts
// src/constants/checkResult.ts
export const CHECK_RESULT = {
  OK: 'OK', STALE: 'STALE', NO_DATA: 'NO_DATA', DOWN: 'DOWN', ERROR: 'ERROR',
} as const;
export type CheckResult = (typeof CHECK_RESULT)[keyof typeof CHECK_RESULT];
export const checkResultSchema = z.enum(Object.values(CHECK_RESULT) as [CheckResult, ...CheckResult[]]);
```

Values that MUST be centralized (they appear in requirements):
- Check results: `OK STALE NO_DATA DOWN ERROR` (+ display-only `PAUSED`)
- Alert types: `WEBHOOK_STALE WEBHOOK_NO_DATA ENDPOINT_DOWN RECOVERED MONITOR_ERROR TEST`
- Alert/email statuses: `PENDING RETRYING SENT FAILED`
- Alert modes: `ONCE_WITH_RECOVERY EVERY_CHECK REPEAT_EVERY`
- Roles: `ADMIN VIEWER` · Recipient types: `NORMAL MASTER`
- Duration units (stored as `eUnit`): interval `MINUTE HOUR`; threshold `MINUTE HOUR DAY WEEK MONTH`; repeat `MINUTE HOUR DAY`
- Check triggers: `SCHEDULE MANUAL`
- Monitor DB collection names (single `COLLECTIONS` object)

Do **not** centralize: one-off log messages, local loop variables, test strings.
Tunable numbers (timeouts, backoffs) are **config** (`src/config`, requirements §5.1), never constants.
Source DB names (`dCreatedAt`, collection names) are data typed by admins — never hard-code them in logic.

## 4. Naming

| Thing | Convention | Example |
|-------|------------|---------|
| Folders | camelCase | `webhookMonitors/` |
| Files | `<feature>.<role>.ts` camelCase | `webhookMonitors.service.ts`, `staleness.evaluator.ts` |
| Views | camelCase `.ejs` under `pages/<module>/` | `pages/webhookMonitors/detail.ejs` |
| Classes / types / interfaces | PascalCase, no `I` prefix | `AppError`, `WebhookMonitor` |
| Functions / variables | camelCase, verb-first functions | `evaluateStaleness`, `findDueAlerts` |
| Constant objects | UPPER_SNAKE | `ALERT_TYPE` |
| Env vars | UPPER_SNAKE | `ENDPOINT_TIMEOUT_MS` (unit suffix for numbers: `_MS`, `_MIN`) |
| Mongo collections | snake_case plural | `webhook_monitors` (requirements §6) |
| Mongo document fields + `<Entity>Doc` types (persistence layer only) | type prefix + PascalCase, same as subscription DB (TD-16, database-design §B.0) | `sName`, `bIsActive`, `dCreatedAt`, `eStatus`, `nRetryCount`, `oThreshold`, `aRecipients`, `iMonitorId` |
| Domain types, form fields, JSON request/response fields, view-models | camelCase; `_id` exposed as `id` | `name`, `isActive`, `createdAt`, `threshold.value` |
| Doc type vs domain type names | `<Entity>Doc` vs `<Entity>` | `WebhookMonitorDoc` / `WebhookMonitor` |
| Local boolean variables | `is/has/should` prefix | `isStale`, `hasDescIndex` |
| Durations in code | unit suffix | `thresholdMs`, `retryDelayMs` |

## 5. Function & module shape

- One responsibility per function; aim ≤ 40 lines. Extract pure logic (evaluators, policies) from I/O code.
- ≤ 3 positional parameters; beyond that pass an options object.
- Early returns over nested `if`s.
- Inject time: functions that compare to "now" take a `Clock` or `now: Date` — never call `new Date()` inside policies.
- Services receive dependencies via a factory (`createAlertsService({ alertsRepo, recipientsService, mailer, clock, logger })`). No DI container.
- Comments explain *why* (constraint, requirement ID, trade-off), e.g. `// FR-A4a: source outage must not flip monitors to STALE`.

## 6. Async & resources

- Every promise is awaited, returned, or explicitly handled (`void` only for fire-and-forget with its own `.catch` that logs).
- Timers created by the scheduler/dispatcher are tracked and cleared on shutdown.
- HTTP probe responses: always consume/cancel the body.
- Never `await` inside a loop over monitors at boot when order doesn't matter — but cap concurrency (e.g. 5) to protect the Source DB.

<a id="errors"></a>
## 7. Errors (summary — full rules in `.claude/rules/error-handling-logging.md`)

```ts
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,          // e.g. 'VALIDATION_FAILED', 'NOT_FOUND', 'FORBIDDEN', 'CONFLICT'
    message: string,                   // safe for clients
    readonly httpStatus: number,
    readonly details?: unknown,        // safe, structured (e.g. Zod issues)
    options?: { cause?: unknown },
  ) { super(message, options); }
}
```
Subclasses: `ValidationError` (400), `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409), `ExternalServiceError` (502). Anything else is a 500 with a generic message.

## 8. Formatting & linting

- Prettier: `singleQuote: true`, `semi: true`, `printWidth: 110`, `trailingComma: 'all'`.
- ESLint flat config: `@eslint/js` recommended + `typescript-eslint` `strictTypeChecked` + `eslint-config-prettier`. Key rules: `no-floating-promises`, `no-misused-promises`, `no-explicit-any`, `no-non-null-assertion`, `consistent-type-imports`, `no-console` (error; logger only).
- Import cycle check: `eslint-plugin-import-x` `no-cycle` (see testing-strategy quality gates).
