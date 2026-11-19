# payMonitor

payMonitor watches the **JOJO Subscription Backend 2.0** from the outside and emails the right people when something looks wrong:

- **Webhook monitors**: a payment gateway stopped sending webhooks (no new document in its collection within a time limit you set).
- **Endpoint monitors**: a server endpoint does not return HTTP `200`.

It has a web dashboard (admin and viewer roles) and a built-in scheduler. Every alert is **stored first** and then emailed, so no alert is lost to a crash. payMonitor **only reads** the source database.

What it must do is written in [docs/requirements.md](docs/requirements.md). How it is built: [docs/architecture.md](docs/architecture.md).

## Prerequisites

- Node.js 22 (`node -v`) and npm
- Nothing else for the sandbox. For real use: a MongoDB for payMonitor's own data, a **read-only** MongoDB user for the source database, and an SMTP account.

```bash
npm ci
```

## Try it in 2 minutes (sandbox, no MongoDB / SMTP / Docker needed)

```bash
npm run sandbox
```

This starts two throwaway in-memory MongoDBs (data kept in `.sandbox/`), seeds fake webhook collections, runs fake endpoints, and starts the app. The first run downloads a MongoDB binary.

- Dashboard: http://localhost:3000, login `admin@sandbox.local` / `sandbox-admin-pass` (sandbox-only values)
- "Sent" emails are written to `.sandbox/outbox/*.eml` (nothing is ever sent for real)
- Make things happen from a second terminal:

```bash
npm run sandbox:ctl -- help
npm run sandbox:ctl -- insert-webhook razor_pay_webhook_data   # a gateway "recovers"
npm run sandbox:ctl -- source-down                              # the source DB goes away
npm run sandbox:ctl -- endpoint-status 500                      # /switch starts failing
npm run sandbox:ctl -- mail-down                                # SMTP goes away
npm run sandbox:ctl -- outbox                                   # list the emails "sent"
```

A step-by-step manual test for every acceptance criterion: [runbook](docs/implementation_plans/paymonitor-v1-implementation.md#6-manual-acceptance-runbook).

## Run it for real

1. `cp .env.example .env` and fill it in (every variable is documented in the file; secrets never go in git).
2. payMonitor creates its own indexes at every startup and refuses to start if that fails (TD-31). `npm run db:indexes` does the same on demand. Neither ever touches the source database.
3. `npm run dev` for development, or `npm run build && npm start` for production-like runs.

**Production must run behind HTTPS.** The session cookie is `Secure`, so over plain HTTP the browser never keeps it and login appears to loop. Terminate TLS at a reverse proxy, send `X-Forwarded-Proto: https`, and set `TRUST_PROXY` to the number of proxy hops (for example `1`). Check `/readyz` from your uptime monitor: it also tells you if payMonitor's own database is down (when it cannot store alerts).

On first start the first admin and the first master recipient are created from `SEED_ADMIN_*` and `MASTER_ALERT_*`.

**The source database user must have the `read` role only.** payMonitor only ever calls `find` (on `_id` and the timestamp field), `listCollections` and `indexes` (plus `ping` for `/readyz`). Add a descending index on each monitored timestamp field; payMonitor warns when one is missing but cannot create it.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run with auto-reload and readable logs |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled app |
| `npm run sandbox` / `npm run sandbox:ctl` | Local try-out environment and its control CLI |
| `npm run db:indexes` | Create payMonitor's own MongoDB indexes |
| `npm run typecheck` · `lint` · `format:check` | Quality checks |
| `npm test` | Unit and integration tests (uses in-memory MongoDB) |
| `npm run test:acceptance` | One test per acceptance criterion in requirements section 9 |
| `npm run test:all` | Everything |

Tests never touch a real database or send real email.

## Project docs

| Topic | File |
|-------|------|
| Requirements | [docs/requirements.md](docs/requirements.md) |
| Architecture, structure | [docs/architecture.md](docs/architecture.md) · [docs/project-structure.md](docs/project-structure.md) |
| Database, API, security | [docs/database-design.md](docs/database-design.md) · [docs/api-standards.md](docs/api-standards.md) · [docs/security.md](docs/security.md) |
| Decisions | [docs/technical-decisions.md](docs/technical-decisions.md) |
| Implementation plan and progress | [docs/implementation_plans/](docs/implementation_plans/) · [docs/implementation_progress.md](docs/implementation_progress.md) |
