# Plan: product name from the environment (`APP_NAME`)

> Status: **IMPLEMENTED** (2026-11-19, not committed). Branch: `dev`.
> Goal: every place a **person sees** the product name ("payMonitor") comes from one env variable, so renaming the product is a `.env` change plus a restart, with no code change.

## 1. Decisions (asked and answered, 2026-11-19)

| # | Question | Answer |
|---|----------|--------|
| 1 | What does the variable control? | **Visible text only**: UI, email templates (subject, body, footer) and human log messages. Technical identifiers, comments and docs stay as they are. |
| 2 | Email subject prefix | **Follows `APP_NAME`**: `[<APP_NAME>] <TYPE> – <monitor name>`. No separate variable. |
| 3 | Branch | **`dev`**. The unfinished Tabler work on `ui_update` gets the same treatment when it resumes (see §6). |

## 2. The new setting

| Env var | Default | Rules | Config path |
|---------|---------|-------|-------------|
| `APP_NAME` | `payMonitor` | Trimmed, 1–40 characters, no control characters (so it can never break an email header or a log line). Validated at startup; an invalid value stops the server with the variable name (requirements §5.1). | `config.appName` |

- Read **only** in `src/config` (`env.schema.ts` + `loadConfig.ts`), like every other setting.
- The default keeps today's output **byte for byte identical**, so existing behaviour, stored data and tests are unchanged unless `APP_NAME` is set.

## 3. What changes (dev, every visible occurrence)

| # | File:line (today) | Visible to | Change |
|---|-------------------|------------|--------|
| 1 | `src/views/layouts/main.ejs:7` `<title>… payMonitor</title>` | Browser tab | `<%= appName %>` |
| 2 | `src/views/partials/nav.ejs:2` brand link `payMonitor` | Every page | `<%= appName %>` |
| 3 | `src/views/pages/webhookMonitors/detail.ejs:17` "…payMonitor cannot create it." | Monitor page | `<%= appName %>` |
| 4 | `src/notifications/email/templates/layout.ts:22` subject `[payMonitor] …` (FR-A6) | Email subject | `[${ctx.appName}] …`. `subjectLine` gets the context. |
| 5 | `layout.ts:43` text footer `-- Sent by payMonitor` | Email (text) | `-- Sent by ${ctx.appName}` |
| 6 | `layout.ts:55` HTML footer "Sent by payMonitor" | Email (HTML) | `escapeHtml(ctx.appName)` |
| 7 | `templates/monitorCheckError.ts:37` "…so payMonitor cannot tell…" | Email body | Uses `ctx.appName` |
| 8 | `src/modules/webhookMonitors/webhookMonitors.service.ts:78` warning "…payMonitor cannot create it." | Save warning (UI) | Service gets `appName` as a dependency |
| 9 | `src/runtime.ts:188` log message `'payMonitor started'` | Operator logs | `` `${config.appName} started` `` (the `event` name stays `app.started`) |

**How the value reaches each place:**
- **Views:** `src/app.ts` sets `res.locals.appName = config.appName` once, next to the existing `flash` locals middleware. `renderPage()` already passes `res.locals` to the layout and pages, and error pages use the same path.
- **Emails:** `EmailContext` (`templates/types.ts`) gets `appName`. `alerts.service.ts:104` builds the context from a new `settings.appName`, which `compositionRoot.ts:162` passes in. Then `subjectLine(ctx, type, name)` and `renderEmail(ctx, parts)` take the context. Every template already receives `ctx`.
- **Services:** `createWebhookMonitorsService({ …, appName })` is wired in `compositionRoot.ts`.
- **Logs:** `runtime.ts` already has `config`.

Escaping is unchanged: the name goes through `<%=` in views and `escapeHtml` in email HTML, like any other value (security rules).

## 4. Not changed (and why)

| Item | Where | Why it stays |
|------|-------|--------------|
| MongoDB `appName` `payMonitor` / `payMonitor-source-reader` | `src/database/monitorDb.ts:16`, `sourceDb.ts:22` | Technical: DB admins and monitoring identify connections by it (decision 1). |
| Log field `service: 'payMonitor'` | `src/logger/index.ts:33` | Log searches and alerts filter on it (decision 1). |
| Default DB name `paymonitor` | `src/config/env.schema.ts:48` | Renaming would point the app at an empty database. `MONGO_DB_NAME` already exists for that. |
| JS global `window.payMonitorApi` | `src/public/js/*.js` | Internal browser API, never shown. |
| bcrypt timing string `payMonitor-timing-equaliser` | `src/modules/users/users.service.ts:148` | Internal constant, never shown. |
| Session cookie `pm.sid`, `package.json` name, sandbox banner | | Technical or dev-only. |
| Code comments, docs, `CLAUDE.md`, rule files | | Decision 1. Docs describe the product. |
| **Sender display name** | `.env` `MAIL_FROM="payMonitor <…>"` | **Already configurable** separately. Change it together with `APP_NAME` (documented in `.env.example`). |

## 5. Backward compatibility and behaviour

- **Unset `APP_NAME`:** everything looks exactly as today.
- **Already-stored alerts keep the old name.** Subject and body are rendered and stored when the alert is created (FR-A1, "what was sent is what's stored"), so a renamed product only affects alerts created after the restart. **Resend** sends the stored email, with the old name. This is intended and documented, not a bug.
- Mail filters keyed on `[payMonitor]` stop matching after a rename (decision 2). This goes into the `.env.example` comment and the README.
- No database, index, route, API or permission change.

## 6. Follow-up for the Tabler branch (`ui_update`)

When the redesign resumes, the brand also appears in `partials/head.ejs` (title), `partials/sidebar.ejs` (brand), `layouts/main.ejs` (login brand) and `partials/footer.ejs`. They use the same `res.locals.appName`; no extra design needed. Add this as an item in `ui-tabler-redesign-STATUS.md` when this change is merged.

## 7. Tests

| Test | File | Proves |
|------|------|--------|
| Default and validation | `tests/unit/config/env.schema.test.ts` | Unset → `payMonitor`; `APP_NAME=Acme Watch` is accepted; empty-after-trim, more than 40 characters and a value with a newline are each rejected, naming `APP_NAME` but not the value. |
| Emails use the name | `tests/unit/notifications/templates.test.ts` | With `appName: 'Acme Watch'`: subject `[Acme Watch] WEBHOOK_STALE – …`, text and HTML footers, the MONITOR_CHECK_ERROR body; HTML-escaped (`<b>` name stays text). |
| Pages use the name | `tests/integration/http/pages.test.ts` | App started with `APP_NAME=Acme Watch`: `<title>` and nav brand show it, and no visible `payMonitor` remains on the overview and login pages. |
| Service warning | `tests/integration/http/webhookMonitors.test.ts` | The no-index warning shows the configured name. |
| Existing suites unchanged | the 37 `[payMonitor] …` subject assertions in 12 files | They still pass with the default. Only `tests/unit/notifications/templates.test.ts:8` needs `appName` added to its `EmailContext` literal (type change). |

## 8. Docs to update in the same change

- `docs/requirements.md`:
  - FR-A6: subject format `[<APP_NAME>] <TYPE> – <monitor name>` (default `payMonitor`)
  - §5.1 table: add `APP_NAME`
- `.env.example`: `APP_NAME=payMonitor`, with a note to change `MAIL_FROM`'s display name too, and that mail filters key on the subject prefix
- `README.md`: one line under "Run it for real"
- `docs/technical-decisions.md`: new **TD-35**, "Product name from APP_NAME (visible text only)". TD-34 is reserved by the paused Tabler work on `ui_update`.
- `docs/implementation_progress.md`: log entry with the real gate results

## 9. Checklist (resume here)

- [x] Scope analysis and questions answered (this plan)
- [x] Config: `APP_NAME` in `env.schema.ts` + `config.appName` in `loadConfig.ts` (+ env tests)
- [x] Views: `res.locals.appName` in `app.ts`; `main.ejs`, `nav.ejs`, `webhookMonitors/detail.ejs`
- [x] Emails: `EmailContext.appName`; `subjectLine` / `renderEmail` take the context; `monitorCheckError.ts`; `alerts.service.ts` + `compositionRoot.ts` wiring (+ template tests)
- [x] Service: `webhookMonitors.service.ts` warning text via an `appName` dependency (+ HTTP test)
- [x] Log: `runtime.ts` startup message
- [x] Grep check: no visible `payMonitor` left in `src/views`, `src/notifications`, or user/log message strings in `src/modules` and `src/runtime.ts`
- [x] Docs (§8) (`docs/implementation_progress.md` entry is added after the gates)
- [x] All gates once: typecheck, lint, format:check, `npm test`, `npm run test:acceptance`, build

## 10. Progress log

- 2026-11-19: started on `dev` (clean tree). Item 1 (config) in progress.
- 2026-11-19: item 1 (config) done. Files: `src/config/env.schema.ts`, `src/config/loadConfig.ts`, `tests/unit/config/env.schema.test.ts`. `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/config`: 22 passed (5 new tests failed first); typecheck clean. Item 2 (views) in progress.
- 2026-11-19: item 2 (views) done. Files: `src/app.ts` (`res.locals.appName` set first in the chain so early errors like CSRF can still render), `src/views/layouts/main.ejs`, `src/views/partials/nav.ejs`, `src/views/pages/webhookMonitors/detail.ejs`, `tests/integration/http/pages.test.ts`. `npx jest tests/integration/http/pages.test.ts auth.test.ts csrf.test.ts`: 38 passed (custom-name test failed first). The detail-page warning text is covered together with item 4. Item 3 (emails) in progress.
- 2026-11-19: item 3 (emails) done. Files: `src/notifications/email/templates/{types,layout,index-callers: recovered,monitorCheckError,webhookStale,webhookNoData,test,endpointDown,monitorError}.ts` (`subjectLine(ctx, …)`, `renderEmail(ctx, …)`), `src/modules/alerts/alerts.service.ts`, `src/compositionRoot.ts`, `tests/unit/notifications/templates.test.ts`. `npx jest tests/unit/notifications`: 59 passed (17 new tests failed first); `npx jest tests/integration/alerts tests/integration/http/monitorActions.test.ts alertsApi.test.ts`: 73 passed; typecheck clean; no `payMonitor` left under `src/notifications`. Item 4 (service warning) in progress.
- 2026-11-19: item 4 (service warning) done. Files: `src/modules/webhookMonitors/webhookMonitors.service.ts` (new `appName` dependency), `src/compositionRoot.ts`, `tests/integration/http/webhookMonitors.test.ts` (covers both the save message and the detail-page text). `npx jest tests/integration/http/webhookMonitors.test.ts tests/unit/webhookMonitors`: 63 passed (new test failed first); typecheck clean. Item 5 (log) in progress.
- 2026-11-19 (resumed after usage limit): `src/runtime.ts` was verified untouched, so item 5 starts from the test. Adding a message-capturing test in `tests/integration/server/runtime.test.ts`, then changing `runtime.ts:188`.
- 2026-11-19: item 5 (log) done. Files: `src/runtime.ts` (`` `${config.appName} started` ``; event `app.started` unchanged), `tests/integration/server/runtime.test.ts` (log capture now also keeps `msg`; new test waits for the scheduler to be active before shutdown, like the other startup tests). `NODE_OPTIONS=--experimental-vm-modules npx jest tests/integration/server/runtime.test.ts -t "startup log message" --forceExit`: 1 passed (twice); with the old hard-coded text temporarily restored it failed (`Expected: "Acme Watch started", Received: "payMonitor started"`), then the fix was restored and re-diffed. Note: without the wait, the same test failed with the already-known `MongoClientClosedError` at shutdown (see `docs/implementation_progress.md`, unfixed). Item 6 (grep check) in progress.
- 2026-11-19: item 6 (grep check) done. `grep -rnI payMonitor src/views src/notifications`: no matches. In `src/modules`, `src/runtime.ts`, `src/app.ts`, `src/utils`, `src/middlewares`, `src/errors` outside comments: only `src/modules/users/users.service.ts:148` (internal bcrypt timing constant, listed as unchanged in plan §4). Item 7 (docs) in progress.
- 2026-11-19: item 7 (docs) done. Files: `docs/requirements.md` (FR-A6, §5.1 `APP_NAME` row), `.env.example` (`APP_NAME` with rename notes), `README.md` (Renaming the product), `docs/technical-decisions.md` (TD-35). Item 8 (all gates) in progress; the `docs/implementation_progress.md` entry follows with the real results.
- 2026-11-19: item 8 (all gates) done. First run: lint failed (`no-control-regex` on my `APP_NAME` regex, fixed by reusing `boundedString(1, 40)` in `src/config/env.schema.ts`) and the new runtime test failed under load with `MongoClientClosedError`; root cause found (see below), the test now waits for the sessions index before shutdown (`tests/integration/server/runtime.test.ts`). Second run: typecheck exit 0, lint exit 0, format:check exit 0, `npm test` 50 suites / 670 tests passed, `npm run test:acceptance` 14 suites / 47 tests passed, build exit 0.
- 2026-11-19: **open finding, not fixed (outside this plan):** `MongoClientClosedError` at shutdown. connect-mongo creates the sessions TTL index in the background (`store.collectionP`, public) and `src/runtime.ts` never awaits it, so closing the Monitor DB client before it finishes leaves an unhandled rejection. It made `runtime.test.ts` "stops checks, releases the lease, closes the databases, then exits with the code" fail in the earlier gate run (it passed in the last one, so it is a timing flake, not fixed). Proposed fix: in `startRuntime`, create the store, `await store.collectionP` before `listen`, so startup waits for (and fails fast on) the session index. Needs the user's go-ahead.
