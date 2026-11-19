# Tabler UI redesign: status at stop

> Stopped: **2026-11-19 11:36 IST**, at the user's request. Branch: **`ui_update`** (last commit `e3d73b3` on `dev`; nothing from this work is committed).
> Plan: [`ui-tabler-redesign.md`](ui-tabler-redesign.md). No tests were run after the redesign started; only `npm run typecheck`.

## 1. Done

**Dependencies (approved by the user, pinned exact)**
- `package.json` / `package-lock.json`: `@tabler/core` `1.7.3`, `@tabler/icons-webfont` `3.50.0`. `npm audit --omit=dev`: 0 vulnerabilities.

**Server side (asset serving only)**
- `src/app.ts`:
  - static mounts `/vendor/tabler/css`, `/vendor/tabler/js` (from `node_modules/@tabler/core/dist`) and `/vendor/tabler-icons` (from `node_modules/@tabler/icons-webfont/dist`)
  - `res.locals.currentPath = req.path` (sidebar active item and breadcrumb only)
  - request logs skip `/vendor/`
- No route, controller, service, repository, schema, auth or API change.

**Layout and partials** (`src/views/`)
- `layouts/main.ejs`: rewritten. Builds the nav model (Overview; Monitors → Webhook/Endpoint; Alerts; Administration → Recipients/Users for admins only), the active-item test and the breadcrumb. Signed-in pages get the full layout; signed-out pages (login) get a centred one.
- New partials:
  - `partials/head.ejs`: meta, CSRF meta, title, `tabler-theme.min.js`, the CSS files
  - `partials/sidebar.ejs`: vertical navbar, nested groups, mobile toggler, mobile user menu and theme toggle
  - `partials/userMenu.ejs`: name, email, role, Sign out POST form
  - `partials/header.ejs`: desktop top bar with theme toggle and user dropdown
  - `partials/footer.ejs`
  - `partials/scripts.ejs`: `tabler.min.js`, `api.js`, `confirm.js`, `ui.js`, then `locals.scripts`
  - `partials/confirmModal.ejs`
  - `partials/monitorHeader.ejs`, `partials/monitorActionsPanel.ejs`, `partials/datagrid.ejs`, `partials/rowActions.ejs`
- Rewritten partials: `flash.ejs` (Tabler alerts, keeps `flash flash-<type>` classes), `statusBadge.ejs` (Tabler `-lt` colours, keeps `badge-<status>`), `fieldError.ejs` (`invalid-feedback`, keeps `field-error`), `emptyState.ejs`, `pagination.ejs` (keeps `rel="next"`), `monitorExtras.ejs`, `alertsTable.ejs` (keeps `row-failed`, `<td>TYPE</td>`, `data-resend*`).
- Deleted: `partials/nav.ejs` (replaced by sidebar/header; `git rm`, staged).

**Browser JS / CSS** (`src/public/`)
- `js/confirm.js`: same `data-confirm` contract, now a Bootstrap modal with `window.confirm` fallback.
- `js/ui.js` (new): theme toggle (`tabler-theme` in localStorage), submit loading state, client-side search and sort for tables with `data-table-tools` (unpaginated lists only).
- `css/app.css`: rewritten to a small file. Chart colour variables `--accent/--bad/--muted` are mapped to Tabler tokens; it keeps `.muted`, `.field-error`, `.sr-only`, `stat-value/label`, `row-failed`, `badge-master`, and the `[hidden]` rule.

**Pages rewritten**
- `pages/dashboard/overview.ejs`: 6 real stat cards (no new metrics), outage alert, searchable/sortable monitor table.
- `pages/webhookMonitors/{list,form,detail}.ejs`, `pages/endpointMonitors/{list,form,detail}.ejs`
- `pages/alerts/list.ejs`
- `pages/recipients/list.ejs`, `pages/users/list.ejs`

All field `name`s, `id`s, `value`s, `data-*` hooks, CSRF fields, admin-only conditions and `<%=` escaping were kept.

## 2. In progress / half-done

- **Not yet converted (still old markup, unstyled under Tabler):** `pages/recipients/form.ejs`, `pages/users/form.ejs`, `pages/auth/login.ejs`, `errors/403.ejs`, `errors/404.ejs`, `errors/500.ejs`. They still render and submit, but use old classes (`card narrow`, `checkbox`, `form-actions`, bare `<label>`/`<input>`).
- No file was mid-edit at the stop; the last write (recipients/users lists) completed.
- **Comments mention `TD-34`, but that entry is not written yet:** `src/app.ts` and `src/public/css/app.css` refer to it, and it must be added to `docs/technical-decisions.md`.

## 3. Remaining (plan checklist order)

1. Convert `recipients/form`, `users/form`, `auth/login`, `errors/{403,404,500}`.
2. Loading/confirm check across all forms, and dark-mode check of the Chart.js colours.
3. Responsive check: mobile sidebar toggle, tables scroll, header hidden < lg.
4. Run all gates (typecheck, lint, format:check, `npm test`, `npm run test:acceptance`, build). Fix any test that asserted old markup; list each change.
5. Manual run (`npm run dev`): every page as admin and viewer, no console errors, no 404 assets (`/vendor/tabler/*`, `/vendor/tabler-icons/fonts/*`), CSP still clean.
6. Docs:
   - `docs/project-structure.md`: new partials, `ui.js`, vendor mounts
   - `.claude/rules/ejs-frontend.md`: layout parts, `ui.js`
   - `docs/security.md`: CSP unchanged, local assets only
   - `docs/technical-decisions.md`: TD-34 (Tabler UI, pinned, served from node_modules)
   - `docs/implementation_progress.md`: log entry
   - `README.md`, if needed

## 4. Known risks

- **Tests not run since the redesign started.** These suites assert markup and may fail:
  - `tests/integration/http/pages.test.ts` (`<h1`, `>Label</span>`, `<h2>History</h2>`, `<h2>Incidents</h2>`, `<h2>Alerts and emails</h2>`, `<option value="X" selected>`, `<td>TEST</td>`, `badge-*`, `<script src="..." defer></script>`, no inline script)
  - `tests/integration/http/monitorActions.test.ts` (`id="monitor-actions"`, `data-action=`, `<script src="/public/js/monitorActions.js" defer></script>`, no `on*=`)
  - `tests/acceptance/03-recovered.test.ts`: regex `<h2>Incidents<\/h2>[\s\S]*?<tbody>`
  - `tests/acceptance/09-smtp-down.test.ts`: `stat-value">1</span><span class="stat-label">Emails failed`
  - Recipients/users/endpoint tests: `badge-master`, `badge-paused`, `value="..."`
  
  The markup was written to keep all of these, but that is unverified.
- **Pre-existing, unrelated to the UI:** `tests/integration/server/runtime.test.ts` "stops checks, releases the lease, closes the databases, then exits with the code" failed in the last full run (`MongoClientClosedError` during shutdown). It is recorded in `docs/implementation_progress.md` and still unfixed.
- **Untested at runtime:** the sidebar dropdown groups (`data-bs-auto-close="false"`), Tabler JS being loaded with `defer`, and the `window.tabler.Modal` lookup in `confirm.js` (falls back to `window.confirm`).
- **Possible visual issues** (not checked in a browser): the dark sidebar contrast and the icon font sub-files loading.

## 5. Current state of the app

- `npm run typecheck`: **passes** (no errors), 2026-11-19 11:36 IST.
- Lint, format, tests, build and run: **not checked** (stopped on request). The templates are EJS and are not covered by typecheck, so a rendering error would only show up in tests or at runtime.

## 6. Prompt to resume

```
Resume the Tabler UI redesign from docs/implementation_plans/ui-tabler-redesign-STATUS.md.
Read that file and docs/implementation_plans/ui-tabler-redesign.md first; don't redo what is marked done.
Do section 3 "Remaining" in order: convert recipients/form, users/form, auth/login and errors/403/404/500;
then run all gates once (typecheck, lint, format:check, npm test, npm run test:acceptance, build);
fix only what fails, listing every test you change and why; then add TD-34 and the doc updates in item 6.
Don't commit or switch branches. End with: files created/modified, gate results, remaining issues.
```
