# Plan: redesign the dashboard with Tabler UI

> Status: IN PROGRESS, paused 2026-11-19 11:36 IST (see `ui-tabler-redesign-STATUS.md`). Dependencies approved by the user.
> Scope: views, CSS and browser JS only. No route, controller, service, repository, schema, auth or API change.

## 1. What exists today (analysis)

| Area | Where | Notes |
|------|-------|-------|
| Entry / app | `src/server.ts` → `src/runtime.ts` → `src/app.ts` | EJS view engine, views `src/views`, static `/public` → `src/public`, `/vendor/chart.js` → `node_modules/chart.js/dist` |
| Layout | `src/views/layouts/main.ejs` | One layout. `renderPage()` (`src/utils/renderPage.ts`) renders the page, then wraps it as `body`. Per-page scripts via `locals.scripts`. |
| Nav | `partials/nav.ejs` | Top bar: Overview, Webhook monitors, Endpoint monitors, Alerts; admin only: Recipients, Users; user name + role; Sign out (POST + CSRF) |
| Partials | `flash`, `statusBadge`, `pagination` (keyset "Older"), `alertsTable`, `fieldError`, `emptyState`, `monitorExtras` (actions, history, incidents, alerts, chart) | |
| Pages | `dashboard/overview`, `webhookMonitors/{list,form,detail}`, `endpointMonitors/{list,form,detail}`, `alerts/list`, `recipients/{list,form}`, `users/{list,form}`, `auth/login`, `errors/{403,404,500}` | |
| Overview data | `dashboard.service.ts` | Cards: total, OK, failing, paused, open incidents, emails failed; outage banner; monitor table (type, status, last/next check, metric) |
| Browser JS | `api.js` (fetch + CSRF), `confirm.js` (`data-confirm` → `window.confirm`), `monitorForm.js`, `monitorActions.js`, `alertActions.js`, `charts.js` (Chart.js) | Hooks: `data-action`, `data-range`, `data-confirm`, `data-resend`, `data-endpoint`, `data-config`, `data-show-for`, ids `monitor-form`, `monitor-actions`, `chart-*`, `validate-*` |
| CSS | `src/public/css/app.css` (330 lines, own design) | |
| Constraints | CSP `script-src 'self'; style-src 'self'` (no inline script/style), escaping rules, tests that assert headings/classes (`pages.test.ts`, `monitorActions.test.ts`, acceptance 03/09) | |

## 2. Not possible / not done (and why)

- **Revenue, user, subscription and transaction statistics**: payMonitor has none of this data. It may only read `_id` + timestamp from the Source DB (non-negotiable 1), so these widgets would be fake. They are not added. The existing six cards, the outage banner and the monitor table stay, restyled.
- **Notifications area**: no notification feature exists; not added.
- **Searchable dropdowns / date pickers**: Tabler uses extra libraries (Tom Select, Litepicker) for these. Native `<select>` and `<input type="date">` are kept; no extra dependency.
- **Client-side sort/search on paginated tables** (alerts log, check history): those are server-side keyset pages with server filters; sorting one page in the browser would mislead. Their existing server filters and "Older" paging stay. Client-side search + sort is added only to the small unpaginated lists (monitors, recipients, users, overview table).

## 3. Design

- **Assets** (pinned, ≥ 2 weeks old): `@tabler/core@1.7.3` (CSS + JS bundle incl. Bootstrap 5 + Popper), `@tabler/icons-webfont@3.50.0`. Served locally like Chart.js: `/vendor/tabler` → `node_modules/@tabler/core/dist`, `/vendor/tabler-icons` → `node_modules/@tabler/icons-webfont/dist`. No CDN, no build step. `app.css` shrinks to a few payMonitor-specific rules.
- **Layout** (`layouts/main.ejs` stays the single layout; split into partials): `partials/head.ejs`, `sidebar.ejs` (vertical Tabler navbar, collapsible on mobile, active item from a new `activeNav` value computed in the layout from the request path), `header.ejs` (page title + breadcrumb, theme toggle, user dropdown with Sign out form), `footer.ejs`, `scripts.ejs`. Login and error pages use a minimal centred layout variant inside the same file.
- **Theme**: light/dark via `data-bs-theme`, toggle stored in `localStorage` by an external `theme.js` loaded in `<head>` (no inline script, CSP intact).
- **Components**: Tabler cards for stats, `table table-vcenter card-table`, status badges mapped to Tabler colours, Bootstrap modal replacing `window.confirm` (`confirm.js` keeps the `data-confirm` contract), alerts for flash, button loading state on submit.
- **Preserved**: every form field name/id, `data-*` hook, CSRF field, route, query parameter, EJS condition/loop, escaping (`<%=`), admin-only rendering. Test-visible markers (`<h1>`, `<h2>History</h2>`, `stat-label`, script tags) are kept; any test change is listed.

## 4. Checklist (resume here; details in `ui-tabler-redesign-STATUS.md`)

- [x] Analysis + this plan
- [x] Dependency approval (user, 2026-11-19: npm deps served locally; real metrics only)
- [x] Install pinned packages (`@tabler/core@1.7.3`, `@tabler/icons-webfont@3.50.0`), mount static routes in `src/app.ts`
- [x] Layout partials (head, sidebar, header, userMenu, footer, scripts, confirmModal) + theme toggle (`ui.js`)
- [x] Overview page
- [x] Monitor lists, details (actions, history, incidents, alerts, chart), forms
- [~] Alerts log, recipients, users, login, error pages: alerts log, recipients list and users list done; **recipients form, users form, login, errors 403/404/500 not done**
- [~] Modal confirm, flash alerts, loading states, client-side search/sort on small lists: code written (`confirm.js`, `ui.js`, `flash.ejs`); **not verified in a browser**
- [ ] Responsive check (mobile sidebar), dark mode check
- [ ] Gates + manual run (`npm run dev`), no console errors, no 404 assets (only `npm run typecheck` run so far: passes)
- [ ] Docs: project-structure, ejs-frontend rule, security (CSP unchanged), TD-34 entry, progress log
