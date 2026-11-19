---
paths:
  - "src/modules/**/*.routes.ts"
  - "src/modules/**/*.controller.ts"
  - "src/modules/**/*.schemas.ts"
  - "src/middlewares/**"
  - "src/app.ts"
---

# API & route rules

Contracts, route map, status codes: `docs/api-standards.md`.

- Every route declares: auth (`requireAuth`), role (`requireRole('ADMIN')` for any mutation or any action that hits Source DB/SMTP/endpoints), CSRF for non-GET, and a Zod `defineValidation({ params, query, body })` handler.
- Forms, JSON request/response bodies and query params are camelCase (`name`, `threshold.value`). Never send stored prefixed names or raw documents to clients/views; use the module mapper (TD-16). `_id` → `id`.
- Validated input is read through the route group's `defineValidation` object (`v.read(res)`), never from raw `req.body`/`req.query`.
- Zod schemas: `.strict()` objects, bounded strings/numbers, `z.coerce` for form numbers, cross-field rules in `superRefine`, shared `objectIdSchema` for ids.
- JSON API under `/api/v1` uses the envelope `{ success, data, meta? }` / `{ success:false, error:{ code, message, details?, requestId } }`. Error codes come from `src/errors`.
- Pages: POST → 303 redirect on success; re-render the form with field errors (status 400) on validation failure, keeping entered values.
- Use 202 + "queued" wording for anything not finished synchronously (e.g. resend). Never report "sent" before SMTP accepted it.
- Pagination: keyset cursor, whitelisted filters, fixed sort.
- Outbound calls always have a timeout from config. Retry only idempotent operations (GET probes); SMTP retries go through the alerts dispatcher only.
- Before adding a route, check `docs/api-standards.md` §1. If the route is new, add it there in the same change.
- Don't invent requirement behaviour: if a route's behaviour isn't in `docs/requirements.md`, ask.
