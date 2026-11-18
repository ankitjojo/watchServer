# payMonitor — Project Structure

> Status: **Proposed** — no source exists yet; create folders only when the first file needs them (no empty placeholder folders).
> Why these boundaries: [architecture.md](architecture.md). Naming rules: [coding-standards.md](coding-standards.md#naming).

```
paymentMontior/
├── CLAUDE.md                     # Instructions for Claude Code sessions
├── .claude/rules/                # Topic rules (path-scoped where useful)
├── docs/                         # ALL project docs (requirements, standards, plans)
│   ├── requirements.md           # WHAT the system must do (source of truth)
│   ├── implementation_plans/     # One plan per feature before coding it
│   └── *.md                      # Standards & design docs (this folder)
├── src/
│   ├── server.ts                 # Process entry: load config → connect DBs → start scheduler/dispatcher → listen → shutdown hooks
│   ├── app.ts                    # createApp(deps): Express app factory (no listen) — used by tests
│   ├── config/                   # env.schema.ts (Zod) + index.ts exporting frozen `config`
│   ├── database/                 # monitorDb.ts, sourceDb.ts (client lifecycle), indexes.ts (Monitor DB index setup)
│   ├── constants/                # Domain `as const` objects: statuses, alert types, roles, duration units, collection names
│   ├── types/                    # Genuinely shared types only (Duration, Paginated<T>, Clock, Result)
│   ├── errors/                   # AppError + subclasses, error codes
│   ├── logger/                   # Pino instance + redaction config
│   ├── middlewares/              # requestContext, requireAuth, requireRole, csrf, rateLimit, errorHandler, notFound
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── recipients/
│   │   ├── webhookMonitors/
│   │   ├── endpointMonitors/
│   │   ├── checks/
│   │   ├── incidents/
│   │   ├── alerts/
│   │   ├── audit/
│   │   ├── dashboard/
│   │   ├── sourceData/           # ONLY place that reads the Source DB
│   │   └── health/
│   ├── scheduler/                # scheduler.ts, leaseLock.ts
│   ├── notifications/email/      # transport.ts, templates/*.ts (subject/text/html builders)
│   ├── utils/                    # Small pure helpers used by ≥2 modules (duration.ts, time.ts, timestamp.ts)
│   ├── views/
│   │   ├── layouts/main.ejs
│   │   ├── partials/             # head, nav, flash, pagination, statusBadge, formErrors
│   │   ├── pages/<module>/       # e.g. pages/webhookMonitors/list.ejs, form.ejs, detail.ejs
│   │   └── errors/               # 403, 404, 500
│   └── public/
│       ├── css/app.css
│       └── js/                   # One file per page feature (charts.js, confirm.js, monitorForm.js)
├── tests/
│   ├── unit/                     # Mirrors src/ paths; pure functions, services with fakes
│   ├── integration/              # Repositories + HTTP via supertest + mongodb-memory-server
│   └── helpers/                  # Factories, fake clock, fake mail transport, test HTTP server
├── scripts/                      # One-off operational scripts (e.g. ensure-indexes) — never destructive by default
├── package.json  tsconfig.json  tsconfig.build.json  jest.config.js  eslint.config.js  .prettierrc
├── .env.example                  # Every variable from requirements §6 / §5.1 with safe placeholders
└── .gitignore
```

## Module folder template

Create only the files a module actually needs:

```
modules/webhookMonitors/
├── webhookMonitors.routes.ts       # Router: pages + /api/v1 endpoints, role guards
├── webhookMonitors.controller.ts   # HTTP in/out only
├── webhookMonitors.service.ts      # Business rules, audit, scheduler upsert
├── webhookMonitors.repository.ts   # webhook_monitors collection access
├── webhookMonitors.schemas.ts      # Zod: create/update body, list query, params
├── webhookMonitors.types.ts        # Document + domain types for this module
├── webhookMonitors.runner.ts       # Executes one check (called by scheduler)
└── staleness.evaluator.ts          # Pure: evaluateStaleness()
```

## Decisions on the example structure from the setup prompt

| Prompt suggestion | Adopted? | Reason |
|-------------------|----------|--------|
| `enums/` | No | Domain values use `as const` objects in `constants/` (see coding-standards). One place, no duplication. |
| `interfaces/` | No | Types live with their owning module; shared ones in `types/`. A separate interfaces folder splits related definitions. |
| `helpers/` | No | Merged into `utils/` — two folders for "misc" invites dumping. |
| `requirements.md` at root | No | Lives at `docs/requirements.md` (user decision: all docs in `docs/`). |
| `errors/`, `logger/`, `scheduler/`, `notifications/` | Added | Real cross-cutting concerns in this project. |
