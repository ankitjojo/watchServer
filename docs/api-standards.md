# payMonitor — API & HTTP Standards

> Status: **Proposed**. Rules for Claude: `.claude/rules/api-development.md`. Security controls: [security.md](security.md).

payMonitor has **two HTTP surfaces**, both served by the same Express app and protected by the same session:

| Surface | Prefix | Consumer | Response |
|---------|--------|----------|----------|
| Pages | `/` | Browser navigation & HTML form posts | EJS HTML, redirects (POST → 303 → GET) |
| JSON API | `/api/v1` | `public/js/*` in our own pages (charts, run-now, pause) | JSON envelope |
| Ops | `/healthz`, `/readyz` | Process manager / load balancer | Minimal JSON, no auth |

There is no public/third-party API and payMonitor **receives no webhooks** — it only reads webhook data from the Source DB. Webhook signature verification and replay protection therefore do not apply.

---

## 1. Route map (derived from requirements)

Role column: `A` = admin only, `V` = admin or viewer.

### Pages
| Method | Path | Role | Req |
|--------|------|------|-----|
| GET | `/login` · POST `/login` · POST `/logout` | public / any | §3 |
| GET | `/` (overview) | V | FR-D1 |
| GET | `/webhook-monitors` · `/webhook-monitors/:id` | V | FR-D2, D4 |
| GET/POST | `/webhook-monitors/new` · `/webhook-monitors/:id/edit` | A | FR-W1 |
| POST | `/webhook-monitors/:id/delete` | A | FR-D2 |
| (same set) | `/endpoint-monitors…` | | FR-E1 |
| GET | `/alerts` | V | FR-D5 |
| GET/POST | `/recipients…` | A | FR-R1 |
| GET/POST | `/users…` | A | §3 |

HTML forms only support GET/POST, so page mutations use `POST /<resource>/:id/<action>`.

### JSON API (`/api/v1`)
| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `/source/collections` | A | Dropdown of Source DB collections (FR-W1) |
| POST | `/source/validate-timestamp-key` | A | Pre-save validation (FR-W2) |
| POST | `/monitors/:type/:id/run` | A | Run check now (FR-D3) |
| POST | `/monitors/:type/:id/pause` · `/resume` | A | FR-D3 |
| POST | `/monitors/:type/:id/test-email` | A | FR-D3 |
| GET | `/monitors/:type/:id/checks?from&to&cursor&limit` | V | History table |
| GET | `/monitors/:type/:id/series?range=24h\|7d\|30d\|custom&from&to` | V | Charts |
| POST | `/alerts/:id/resend` | A | FR-A2 |

`:type` ∈ `webhook | endpoint` (validated with `z.enum`).

## 2. Response contract (JSON API)

```jsonc
// success
{ "success": true, "data": { ... }, "meta": { "nextCursor": "..." } }   // meta optional
// failure
{ "success": false, "error": { "code": "VALIDATION_FAILED", "message": "Threshold must be ≥ 1", "details": [ { "path": ["threshold","value"], "message": "..." } ], "requestId": "…" } }
```
- `code` values come from `src/errors` (`VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `CSRF_INVALID`, `EXTERNAL_SERVICE_ERROR`, `INTERNAL_ERROR`).
- `requestId` always included so users can quote it.
- Never include stack traces, driver messages, hostnames, or URIs.

### Status codes
| Code | When |
|------|------|
| 200 | Read / action completed synchronously (run-now returns the check result) |
| 201 | Created (JSON) |
| 202 | Accepted but not finished — e.g. resend queued. **Say "queued", not "sent".** |
| 303 | Page form success → redirect |
| 400 | Zod validation failure (pages re-render the form with errors + 422-style messages; status 400) |
| 401 / 403 | Not logged in / role insufficient (pages: redirect to `/login` for 401, render 403 page) |
| 404 | Unknown or soft-deleted resource |
| 409 | Unique conflict (duplicate name/email), "already running", last admin/master protection |
| 429 | Rate limited |
| 502 | Source DB/SMTP failure surfaced to an admin action (e.g. collection list) |
| 500 | Unexpected — generic message |

## 3. Validation

- Every route has a Zod schema for `params`, `query`, `body` in `<module>.schemas.ts`. A shared `validate({ params, query, body })` middleware parses and attaches typed values to `res.locals.input` (no mutation of `req.query` — Express 5 makes it a getter).
- Coerce numbers from form strings explicitly (`z.coerce.number().int().positive()`), bound every number and string (`max()`), trim strings, lower-case emails.
- Cross-field rules in `.superRefine` (e.g. `repeatInterval` required iff `alertMode === 'REPEAT_EVERY'` and `repeatInterval.ms ≥ checkInterval.ms`).
- Browser validation is UX only; the server re-validates everything.
- `ObjectId` params: validate with a shared `objectIdSchema` before hitting the DB.

## 4. Pagination, filtering, sorting
- Keyset pagination: `?cursor=<opaque base64 of {t,id}>&limit=50` (max 200). Response `meta.nextCursor` or absent at end.
- Filters are whitelisted per endpoint in the schema (e.g. alerts: `monitorId, type, status, from, to`). Unknown query keys are rejected (`.strict()`).
- Sorting fixed per endpoint (newest first); no client-chosen sort fields → no injection surface.

## 5. Idempotency
- "Run now": in-flight guard → `409 ALREADY_RUNNING` instead of a parallel run.
- Resend: only allowed from `FAILED`; conditional update `{_id, status: 'FAILED'}` → second click gets 409.
- Pause/resume: idempotent (`$set isEnabled`), returns current state.
- Page form double-submit: POST → 303 redirect; create uses unique indexes so duplicates become 409.

## 6. Rate limiting
- `POST /login`: `LOGIN_RATE_LIMIT` (default 5 / 15 min per IP + per email).
- `/api/v1/monitors/:type/:id/run` and `/test-email`: 10 / min per user — they hit the Source DB / SMTP.
- Behind a proxy: set `app.set('trust proxy', <exact hops>)` from config, never `true` blindly.

## 7. Outbound calls (Source DB, monitored endpoints, SMTP)
| Target | Timeout | Retries | Notes |
|--------|---------|---------|-------|
| Source DB query | `SOURCE_QUERY_TIMEOUT_MS` (`maxTimeMS`) + driver `serverSelectionTimeoutMS` 5 s | None per check (next scheduled check is the retry) | Failure → `ERROR` → FR-A4a |
| Endpoint probe | `ENDPOINT_TIMEOUT_MS` per attempt | `retryCount` with `ENDPOINT_RETRY_DELAY_MS` | GET is idempotent → safe to retry |
| SMTP | Nodemailer `connectionTimeout`/`socketTimeout` 15 s [Recommendation] | `EMAIL_RETRY_BACKOFF_MIN` via dispatcher | Sending is not idempotent → only retry on errors before acceptance (connection/timeout/4xx), record every attempt |
No circuit breaker: single SMTP server and per-monitor scheduling already bound load; revisit if SMTP outages cause backlogs.

## 8. Versioning & documentation
- JSON API is internal to our own pages, but prefixed `/api/v1` so a future external consumer doesn't force a break.
- Documentation strategy: route tables in this file + Zod schemas as the contract. OpenAPI generation (`zod-to-openapi`) only if an external consumer appears — not now.
