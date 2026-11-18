---
paths:
  - "src/**/*.ts"
---

# Error handling, logging & operations

## Error model
- Throw `AppError` subclasses from `src/errors` (`ValidationError` 400, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404, `ConflictError` 409, `ExternalServiceError` 502). Wrap causes: `new ExternalServiceError('Source DB unavailable', { cause: err })`.
- One central Express error handler (`middlewares/errorHandler.ts`): `AppError` → its status + safe message; Zod error → 400 with `details`; anything else → 500 `INTERNAL_ERROR` generic message. Logs once with `requestId`. JSON for `/api/v1`, error page for pages.
- Express 5 forwards rejected async handlers — don't add try/catch just to call `next(err)`.
- No empty `catch`. A catch must handle (fallback with a log), translate (rethrow as AppError), or record (e.g. check result `ERROR`).
- Background work (scheduler, dispatcher) never throws to the event loop: catch per monitor/alert, log, record outcome, continue (FR-S4).
- Report truthfully: "queued" ≠ "sent"; a check that errored is `ERROR`, not `OK`.

## Logging (Pino)
- Import the shared logger from `src/logger`; never `console.*` (ESLint `no-console`).
- Levels: `fatal` startup failure/lease lost permanently · `error` unexpected exception, alert `FAILED` · `warn` check `STALE/NO_DATA/DOWN/ERROR`, email retry, skipped run · `info` startup/shutdown, monitor CRUD, alert `SENT` · `debug` per-check details (dev only).
- Structured fields, stable event names: `logger.warn({ event: 'check.result', monitorId, monitorType, result, ageMs, durationMs }, 'Webhook monitor stale')`.
- Context: `requestId` (from `x-request-id` or `randomUUID()`, echoed in response header) on request logs via `pino-http` child logger; `monitorId`/`checkId`/`alertId` on background logs.
- Redaction config (in `src/logger`): `req.headers.cookie`, `req.headers.authorization`, `res.headers["set-cookie"]`, `*.password`, `*.sPassword`, `*.sPasswordHash`, `*._csrf`, `*.smtpPass`, `*.uri`. Mask URL query values before logging endpoint URLs. Don't log email bodies or recipient lists at info.

## Operations
- Config validated at startup with Zod → on failure log variable NAMES and exit(1).
- `/healthz`: process alive (no I/O). `/readyz`: Monitor DB ping, Source DB ping (timeout 2 s), scheduler state (`leader|standby|stopped`). No secrets or hostnames in output.
- Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting connections → stop scheduler timers → await in-flight checks (max 15 s) → stop dispatcher → release lease → close Mongo clients → flush logger → exit. Second signal forces exit.
- `process.on('unhandledRejection')` / `uncaughtException`: log `fatal` and start graceful shutdown (exit non-zero); the process manager restarts.
- Clear every timer/interval/listener you create; keep handles in the owning component's `stop()`.
