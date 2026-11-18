---
paths:
  - "src/views/**"
  - "src/public/**"
  - "src/modules/**/*.controller.ts"
---

# EJS & browser rules

## Structure
- One layout `views/layouts/main.ejs` (head, nav, flash, content, footer). Pages live in `views/pages/<module>/<page>.ejs`; shared bits in `views/partials/` (statusBadge, pagination, formErrors, flash, emptyState).
- Error pages: `views/errors/{403,404,500}.ejs` — no technical details, show `requestId`.
- Browser JS: `public/js/<feature>.js`, one concern per file, no inline `<script>` or `on*=` attributes (CSP). CSS: `public/css/app.css` (+ page files only if it grows).
- Chart.js served from `/vendor/` (TD-13); no CDN.

## Controller → view contract
- Each page gets ONE typed view-model built in the controller/service, e.g. `WebhookMonitorDetailView { monitor, status, history, charts, can: { edit, run, resend } }`.
- Templates only display and loop. No DB calls, no business decisions, no date math — format values (UTC + "UTC" label, human durations) before rendering via shared formatters.
- Common locals set by middleware: `currentUser { name, role }`, `csrfToken`, `flash`, `requestId`. Never pass config, env, secrets, password hashes, or full DB docs.
- Pass data to browser JS via `data-*` attributes or `<script type="application/json" id="…"><%= JSON.stringify(data) %></script>` (escaped), then `JSON.parse(el.textContent)`.

## Output & forms
- `<%=` for every dynamic value. `<%-` only for `include()`.
- Forms: POST with hidden `_csrf`; on validation error re-render with entered values + per-field messages from Zod `details`.
- HTML5 validation attributes mirror Zod rules for UX only.
- Monitor form shows `repeatInterval` only when alert mode is `REPEAT_EVERY` (progressive enhancement — form still works without JS, server validates).
- Destructive actions (delete, pause) use a POST form + `confirm.js`, never a GET link.

## States & UX
- Every list: empty state with a call-to-action (admins) or explanation (viewers).
- Status uses text + colour (not colour alone): OK / STALE / NO_DATA / DOWN / ERROR / PAUSED.
- Async actions (run now, resend): disable the button while pending, show result inline, show `error.message` + requestId on failure.
- Viewer role: hide admin actions (`can.*`), but the server still enforces.

## Accessibility & responsive
- Semantic HTML: `<table>` with `<th scope>`, `<label for>` on every input, `<button>` for actions, visible focus, one `<h1>` per page.
- Mobile-first CSS; tables scroll horizontally inside a wrapper on small screens.

## Caching
- Static assets: `express.static` with `maxAge: '7d'` in production + versioned filenames or `?v=<build>` query. HTML pages: `Cache-Control: no-store` (authenticated data).
