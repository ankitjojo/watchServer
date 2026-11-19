# payMonitor — Security

> Status: **Implemented** (v1). Where each control lives in the code and which test proves it: `docs/implementation_plans/paymonitor-v1-implementation.md` Appendix J. Rules for Claude: `.claude/rules/security.md`.
> Threat focus: an internal admin tool that (1) holds read access to the **payment** database, (2) makes outbound HTTP requests to admin-supplied URLs, (3) sends email to a managed list.

---

## 1. Assets & threats

| Asset | Threat | Primary controls |
|-------|--------|------------------|
| Source DB (payments data) | Write/destructive access via payMonitor; data exfiltration through the UI | `read`-role DB user; `sourceData` module exposes only `latest timestamp` + collection names; projection limited to `_id` + timestamp key — **document bodies (which contain webhook payloads/headers) never reach payMonitor** |
| Dashboard admin session | Credential stuffing, session theft, CSRF | bcrypt, login rate limit, httpOnly/secure cookies, session regeneration, CSRF tokens |
| Recipient list / users | Unauthorized changes | Role guard on server, audit log |
| Outbound prober | SSRF to cloud metadata / internal admin panels | Admin-only creation, scheme allow-list, metadata IP block, no body returned to UI |
| Alert email | Phishing-like content via monitor names; header injection | Escape names in HTML email; Nodemailer handles headers; subject built from validated, length-limited fields |
| Secrets (.env) | Leak in logs, errors, docs, git | Pino redaction, `.gitignore`, config module, generic error responses |

## 2. Controls (where and how)

### 2.1 HTTP headers — `helmet` (app-wide)
- CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'`. No inline scripts/styles → pass data to browser JS via `data-*` attributes or a `<script type="application/json">` block rendered with escaped JSON.
- `hsts` only when served over HTTPS (config flag), `referrerPolicy: same-origin`.

### 2.2 CORS
Not enabled. All browser calls are same-origin. Do not add `cors()`; if an external consumer ever appears, add an explicit origin allow-list for that route only.

### 2.3 Authentication
- Email + password, bcrypt cost 12, constant-time compare via bcrypt. Same error message for unknown email and wrong password.
- Inactive users rejected at login **and** on every request (session middleware reloads the user; deactivation takes effect immediately).
- `req.session.regenerate()` on login; `destroy()` on logout.
- Password policy **[Recommendation — not in requirements, confirm before implementing]**: min 12 chars; reject > 72 bytes (bcrypt silently truncates beyond 72 bytes).
- Seed admin from env only when `users` is empty; log that it happened (never the password).

### 2.4 Authorization
- `requireAuth` on everything except `/login`, `/healthz`, `/readyz`, static assets.
- `requireRole('ADMIN')` declared in routes for every mutating route and every route that triggers I/O to Source DB/SMTP/endpoints (see api-standards route map). Views hide admin buttons for viewers, but **the server is the control**.
- Business protections in services: last active admin, master recipients.

### 2.5 Sessions & cookies
`express-session` + `connect-mongo`: cookie `httpOnly`, `sameSite: 'lax'`, `secure` in production, name `pm.sid`, `maxAge` 8 h rolling; `SESSION_SECRET` ≥ 32 chars validated at startup.

### 2.6 CSRF
Session-backed synchronizer token (TD-11). Token in a hidden `_csrf` field for forms and `x-csrf-token` header for `/api/v1` calls (read from a `<meta name="csrf-token">`). Required on every POST/PUT/PATCH/DELETE including logout.

### 2.7 XSS
EJS `<%=` everywhere for dynamic values (monitor names, gateway names, URLs, error messages are all admin-controlled but still untrusted). `<%-` only for `include()` of our own partials. Email HTML templates escape all interpolations with a shared `escapeHtml`. Links built from monitor URLs are shown as text, not clickable `href`, unless scheme is http(s).

### 2.8 NoSQL injection
- Zod schemas reject objects where strings are expected (`{ "$gt": "" }` in email field → 400).
- Never pass `req.body`/`req.query` objects directly into filters; build filters from parsed fields.
- Admin-supplied `sTimestampKey` used in `sort`/`projection` → regex `^[A-Za-z_][A-Za-z0-9_.]{0,63}$`, no `$` (see database-design A.2). `sSourceCollection` must be in the live `listCollections` result.

### 2.9 SSRF (endpoint monitors)
- Allowed schemes: `http`, `https`. Reject credentials in URL (`user:pass@`).
- Block link-local/metadata ranges after DNS resolution on every attempt (`169.254.0.0/16`, `fd00:ec2::254`, `100.100.100.200`, `fe80::/10`), including on redirects (manual redirect loop, TD-12). Matching uses `net.BlockList`, so IPv4-mapped IPv6 spellings (`::ffff:a9fe:a9fe`) are blocked too. The probe uses `node:http(s)` with a vetting `lookup` hook: the addresses checked are the addresses the socket connects to, so DNS rebinding cannot bypass the check (review M3).
- Private/loopback ranges **allowed** by default because monitoring internal servers is a requirement (open question A3); creation is admin-only and audited.
- Never return the response body to the UI or email — only status code, timing, error class.

### 2.10 Secrets & config
- Only `src/config` reads `process.env`. Startup fails on missing/invalid secrets with the variable **name**, never the value.
- `.env` is git-ignored; `.env.example` holds placeholders.
- Source/Monitor URIs are never logged; when needed, log host only.

### 2.11 Least privilege
| Principal | Privilege |
|-----------|-----------|
| Source DB user | `read` on source DB |
| Monitor DB user | `readWrite` on payMonitor DB |
| SMTP account | Send-only account dedicated to alerts |
| OS user | Non-root; no write outside app dir/logs |

### 2.12 Rate limiting & abuse
See api-standards §6. Also cap concurrency of manual runs per user.

### 2.13 Dependencies
`npm audit --omit=dev` in the quality gate; review advisories before upgrades; lockfile committed; no packages without a stated purpose (testing-strategy §Dependencies).

### 2.14 Logging & retention of sensitive data
- Redact: `password`, `sPassword`, `sPasswordHash`, `*.authorization`, `cookie`, `set-cookie`, `_csrf`, `SMTP_PASS`, URIs, URL query values.
- Email addresses: allowed in audit logs and alert records (needed for FR-H2/FR-A1), not in general request logs.
- Retention: keep everything (FR-H3); audit log is append-only from the app.

## 3. Not applicable (and why)
- **File uploads**: none in requirements.
- **Inbound webhook signature verification / replay protection**: payMonitor receives no webhooks.
- **Payment data handling**: payMonitor never reads document bodies from the Source DB (only `_id` + timestamp).
