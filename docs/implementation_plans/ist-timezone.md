# Plan: show times in IST (dashboard + emails)

> Request (2026-11-21): the dashboard and the alert emails show times in **IST** (India Standard Time, `Asia/Kolkata`, UTC+05:30) instead of UTC.
> Status: **DONE** 2026-11-21. Deviation: no "Deleted on (UTC)" suffix, column is "Deleted on" because each value carries its own IST label; no HTTP test for alerts-filter day bounds (unit test on `dayBounds` only).

## 1. What already exists (so the change is small)

- The display zone is already a config value: `TIMEZONE` (`src/config/env.schema.ts:95`, default `UTC`) → `config.display.timeZone`. It is already passed to every controller (`src/app.ts`), the dashboard service, and every email template (`EmailContext.timeZone`, `src/compositionRoot.ts`).
- All server-side formatting goes through **one** function: `formatUtc(date, timeZone)` (`src/utils/time.ts`, 56 call sites). It already converts to the given zone. It appends the **raw zone name**, so `Asia/Kolkata` would print `2026-11-21 15:35:09 Asia/Kolkata`, not `IST`.
- Storage and logic stay **UTC** (architecture: "all logic in UTC"). Only **display and day-range inputs** change. No DB fields, no migration. Old documents are unaffected.

So setting `TIMEZONE=Asia/Kolkata` already converts most server-rendered times and all emails. The rest of this plan covers what that setting does **not** reach.

## 2. Gaps if we only change `TIMEZONE`

| # | Where | Problem today |
|---|-------|---------------|
| G1 | `src/utils/time.ts` `formatUtc` | Label is the IANA name (`Asia/Kolkata`), not `IST`. |
| G2 | Hard-coded `"UTC"` labels: `*.view.ts` deleted columns (`'Deleted on (UTC)'` in webhook, endpoint, recipients, users), `views/pages/{webhook,endpoint}Monitors/detail.ejs:17` banner, `views/partials/monitorExtras.ejs:13,29,30` (chart aria label, From/To labels), `views/pages/alerts/list.ejs:23,24` (From/To labels) | They would still say UTC while the values are IST. |
| G3 | `detail.ejs:17` banner: `Deleted on <%= monitor.deletedOn %> UTC` | `deletedOn` already ends with the zone, so today it prints **"… UTC UTC"** (existing bug). Fixed by dropping the literal. |
| G4 | Day filters are UTC midnights: `src/modules/alerts/alerts.pages.controller.ts:29-30`, `src/modules/monitors/monitorDetail.ts:15-16`, `src/public/js/charts.js:76` (`T00:00:00Z` / `T23:59:59Z`) | Picking "21 Nov" would mean 05:30 IST 21 Nov → 05:29 IST 22 Nov. Must mean the IST day. |
| G5 | `src/public/js/charts.js:16-19, 62, 84` | Chart labels slice the UTC ISO string; axis title and caption say "UTC". |
| G6 | `src/public/js/monitorForm.js:37` | "newest document: <ISO> UTC" in the Validate-key message (raw ISO from `/source/collections` API). |
| G7 | JSON APIs (`monitorActions.view.ts` `startedAt`/`finishedAt`, chart points `t`, `sourceData.controller.ts` `latestTimestamp`) | Return ISO UTC. **Keep as-is** (machine format, API contract, api-standards). Only what the browser *shows* changes (G5, G6). `startedAtUtc` is already formatted with the zone; the field name stays for compatibility. |
| G8 | Logs, `.eml` outbox file names, cursors, DB | Stay UTC. Not user-facing display. No change. |

## 3. Changes (smallest complete set)

| Step | File(s) | Change |
|------|---------|--------|
| C1 | `src/config/env.schema.ts:95`, `.env.example:64` | Default `TIMEZONE` → `Asia/Kolkata`. Env can still override. |
| C2 | `src/utils/time.ts` | Label: print the short zone name (`IST`) instead of the IANA name, e.g. from `Intl.DateTimeFormat('en-IN', { timeZone, timeZoneName: 'short' })` → `IST`; `UTC` stays `UTC`. Keep the function name `formatUtc` (56 call sites; rename is churn) and fix its doc comment. Also export a tiny `zoneLabel(timeZone)` for G2. |
| C3 | `src/app.ts` | Put `timeZoneLabel` (`IST`) and `timeZone` into `res.locals` once, so views don't hard-code the zone. |
| C4 | 4 × `*.view.ts` deleted columns | `'Deleted on (UTC)'` → `` `Deleted on (${label})` `` (built with `zoneLabel`). |
| C5 | `detail.ejs` (×2), `monitorExtras.ejs`, `alerts/list.ejs` | Replace literal `UTC` with `<%= timeZoneLabel %>`; drop the trailing literal in the banner (G3). |
| C6 | `src/utils/time.ts` + `alerts.pages.controller.ts`, `monitorDetail.ts` | One helper `dayBoundsInZone('YYYY-MM-DD', timeZone)` → `{ start, end }` as UTC `Date`s for that local day. Use it for `from`/`to` instead of `T00:00Z`/`T23:59Z`. Needs `timeZone` passed to the alerts page controller (already has it) and to `monitorDetail` parsing. |
| C7 | `monitorExtras.ejs` + `charts.js` | Pass `data-time-zone` on the chart element. `label()` formats with `Intl.DateTimeFormat('en-GB', { timeZone, … })`; axis/caption say `Time (IST)`. Custom range: send the plain `from`/`to` days and let the server apply C6 (drop the `Z` suffixes). |
| C8 | `monitorForm.js:37` | Format `latestTimestamp` with `Intl` + the page's time zone (`data-time-zone` on the form) instead of appending `UTC`. |
| C9 | Emails | **No template code change**: they already use `ctx.timeZone` through `formatUtc`; C1 + C2 make them IST. Check that no template has a literal "UTC" (grep found none). |

Not changed: stored data, logs, JSON field formats, scheduler/policy logic, `Clock`.

## 4. Tests

| Test | File | Change |
|------|------|--------|
| T1 | `tests/unit/utils/misc.test.ts` | Keep the UTC cases; add `Asia/Kolkata`: `2026-11-18T14:05:09Z` → `2026-11-18 19:35:09 IST`; date-line case (`18:40Z` → next day IST). |
| T2 | new cases in the same file | `dayBoundsInZone('2026-11-21','Asia/Kolkata')` → `2026-11-20T18:30:00.000Z` … `2026-11-21T18:29:59.999Z`; UTC unchanged. |
| T3 | `tests/unit/config/env.schema.test.ts:39` | Default becomes `Asia/Kolkata`. |
| T4 | `tests/unit/notifications/templates.test.ts` | Add one email built with `timeZone: 'Asia/Kolkata'` that shows `IST` and no `UTC`. Existing UTC cases stay (explicit zone). |
| T5 | HTTP: `pages.test.ts`, `deletedRecords.test.ts` | With the test app on IST: list/detail/alerts pages show `IST`, no stray `UTC`; the deleted banner has the zone once (G3); alerts `from`/`to` filter uses IST day bounds (alert at 20:00 UTC on 20 Nov appears under 21 Nov). |
| T6 | Tests that build config without `TIMEZONE` and assert `UTC` text (`dashboard.service.test.ts`, acceptance 02/03, deletedRecords `/UTC/`) | Either pin `TIMEZONE: 'UTC'` in the test config or update the expected strings. Decide per file; prefer pinning (keeps them about their own feature). |

Gates after: typecheck, lint, format:check, `npm test`, `npm run test:acceptance`, build.

## 5. Docs

- `docs/requirements.md`: FR-D7 "UTC, labelled UTC" → "IST (`TIMEZONE`, default `Asia/Kolkata`), labelled IST"; §5.1 `TIMEZONE` default.
- `docs/architecture.md:124`: display default `Asia/Kolkata`; logic/storage still UTC.
- `docs/api-standards.md:37-38`: `from`/`to` plain days are in the display zone.
- `docs/technical-decisions.md`: new **TD-38** (display IST, store UTC, day filters in display zone, JSON stays ISO UTC).
- `docs/implementation_progress.md`: checklist below + log entry.

## 6. Open questions (answer before coding)

1. **Label**: `IST` (recommended) or `Asia/Kolkata` or `IST (UTC+05:30)`?
2. **How fixed**: change the **default** of `TIMEZONE` to `Asia/Kolkata` (recommended; env can still switch back), or hard-code IST and remove the setting?
3. Your `.env` may already set `TIMEZONE=UTC` (I can't read it). If so, you need to change it there too. OK?
4. Date filters (`From`/`To`): IST days (recommended) or keep UTC days?

## 7. Checklist

- [x] Questions in §6: not answered; recommended defaults used (IST label, default changed, IST days)
- [x] C1 config default · C2 label + `zoneLabel` · C3 `res.locals`
- [x] C4 deleted columns · C5 views (+ G3 double-label fix)
- [x] C6 day bounds helper + 2 call sites · C7 charts · C8 monitorForm
- [x] C9 email check
- [x] T1–T6
- [x] Docs §5 + TD-38
- [x] Gates run, real results reported
