# Security rules (always loaded)

Threat model and control details: `docs/security.md`.

- The Source DB is payments data: read-only, `_id` + timestamp only, through `modules/sourceData`. No exceptions.
- Server-side role checks on every mutating or I/O-triggering route. Hiding a button is not access control.
- Escape all dynamic EJS output with `<%=`; `<%-` only for our own `include()`s. Escape all values in email HTML.
- CSRF token on every state-changing request (forms `_csrf`, fetch `x-csrf-token`).
- Never build Mongo filters from raw request objects; parse with Zod first. Validate `sTimestampKey` / `sSourceCollection` per `.claude/rules/database.md`.
- Endpoint monitors: http/https only, no credentials in URL, block metadata IPs (also on redirects), never surface response bodies.
- Secrets live only in env, read only in `src/config`. Never print, log, commit, or write them into docs, tests, fixtures, or error messages. Log URIs as host only; mask URL query values.
- Passwords: bcrypt, never returned/logged; strip `sPasswordHash` from audit `oBefore/oAfter`.
- No CORS, no inline scripts (CSP `script-src 'self'`), no CDN scripts.
- Adding a dependency or security middleware requires a stated purpose and user approval (see `docs/testing-strategy.md` §6).
