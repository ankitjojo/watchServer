# Plan: "Delete" keeps the record, stops it, and lists it under **Deleted records** (all four screens)

> Status: **Option B approved (2026-11-19); plan revised, awaiting sign-off on the diff + migration script. No feature code written.** Branch: `dev`.
> Request: wherever the UI offers Delete (**Webhook monitors, Endpoint monitors, Recipients, Users**), nothing is really deleted. Every process tied to the record stops and it becomes inactive. Messages stop saying "deleted" as if it were gone. Each of those list pages gets **one** **Deleted records** button in the page header, next to the New button, that opens a full-screen modal listing that page's deleted records in the same table layout as the live list.
> Requirements touched: FR-D2, FR-D4, FR-D6, FR-R1–R3, §3 (users), FR-A5, FR-H2, FR-H3, FR-S1.

## 1. Today (read from the code)

| Screen | Delete today | Stored record after delete | Flash |
|--------|--------------|----------------------------|-------|
| Webhook monitors | **Soft** (`webhookMonitors.repository.ts` `softDelete`: `dDeletedAt`, `bIsEnabled=false`), schedule removed, open incident closed silently (TD-22), audited | Kept | "Monitor deleted. Its history is kept." |
| Endpoint monitors | Same as webhook | Kept | same |
| Recipients | **Hard** (`recipients.repository.ts:58` `deleteOne`), masters refused, audited | **Gone** | "Recipient deleted" |
| Users | **Hard** (`users.repository.ts:49` `deleteOne`), last active admin refused, audited | **Gone** | "User deleted" |

Gaps against the request:
1. Recipients and Users are really deleted.
2. Deleted monitors are invisible (every read filters `dDeletedAt: null`), so their kept history cannot be opened.
3. A monitor check already running at delete time can still open an incident and send an alert (review **L4**).
4. No place in the UI lists deleted records, and the messages say "deleted".

## 2. One rule for all four screens

**Delete = mark deleted (`dDeletedAt`), make inactive, stop everything it drives, keep the document.** Every normal read, count and write ignores deleted records; only the new Deleted records modal (and the read-only monitor detail page) shows them.

| Record | "Stop every process" means |
|--------|----------------------------|
| Webhook / endpoint monitor | `bIsEnabled=false`, scheduler timer removed, open incident closed (`MONITOR_DELETED`, no email), an in-flight check stores its row but creates **no** incident, alert or state change (L4) |
| Recipient | `bIsActive=false`; excluded from every new alert's recipient list (`findAudience`); not editable |
| User | `bIsActive=false`; cannot log in; any open session ends on its next request (`getActiveById` returns null); not counted as an admin; not editable |

Alerts already stored **before** the delete keep their stored recipient list (FR-A5: recipients are worked out when the alert is created) and are still sent. This is unchanged from today.

## 3. Decisions (defaults; correct any you disagree with)

| # | Question | Default |
|---|----------|---------|
| D1 | Button label for the action | Keep **Delete** on every screen; only confirm and flash texts change (D2, D3). |
| D2 | Flash after delete | `<Thing> "<name>" stopped and moved to Deleted records. Its history is kept.` Users: `User <email> can no longer sign in and was moved to Deleted records.` Recipients: `Recipient <email> no longer receives alerts and was moved to Deleted records.` |
| D3 | Confirm text | `Delete <thing> <name>? It moves to Deleted records and stops <running / receiving alerts / signing in>.` |
| D4 | Restore | **Deferred, but designed for now**: fields and rules below mean Restore needs no further migration (§9). |
| D5 | Who sees **Deleted records** | Monitors: every logged-in user, read-only (viewers already read all history). Recipients and Users pages are admin-only today, so only admins see them there. |
| D6 | Which records a button lists | **Only its own page's type** (webhook page → deleted webhook monitors, …). One button per page, never two. |
| D7 | Button + modal | A `<button class="button">` in `.page-head` **beside the New button**: `[ Deleted records (n) ] [ New … ]`, always shown, even at 0. It opens a native `<dialog>` (full screen, `showModal()`): header "Deleted <section> (n)" + × button, body scrolls on its own (sticky table header, horizontal scroll on small screens), page behind does not scroll. Closes with ×, Esc or a backdrop click; the browser returns focus to the button, moves focus into the dialog and keeps Tab inside. One small external file `public/js/navigation.js` (event delegation on `data-deleted-open` / `data-deleted-close`; CSP stays `script-src 'self'`, no inline handlers). Empty: "No deleted records". Replaces the earlier `<details>` dropdown, which floated over the page content. |
| D8 | Modal row | Same columns as the live list of that page, minus Next check and Actions, with Status shown as "Deleted", plus **Deleted on (UTC)** at the end. Monitors: first cell links to the read-only detail page; no action buttons. Recipients/Users: view only, no links or buttons. Newest first. No "Deleted by" column: only the id (`iDeletedBy`) is stored and showing a name would need a new lookup. |
| D9 | Reusing a deleted record's **name/email** | Monitors: name reuse already allowed (partial unique index). Users/Recipients: **allowed (Option B, §5)**. A later Restore of such a record fails with a clear error (409 `EMAIL_IN_USE`). |
| D10 | Alerts page monitor filter | Deleted monitors listed with `(deleted)` so their old alerts stay filterable. |

## 4. Shared design (smallest common change)

Same pattern in each of the four modules, plus one shared partial:

| Layer | Change |
|-------|--------|
| Stored fields | **Users, Recipients: `bIsDeleted: boolean`, `dDeletedAt: Date \| null`, `iDeletedBy: ObjectId \| null`** (TD-16 naming). New documents store `false/null/null` explicitly. **Monitors: keep the existing `dDeletedAt` as the marker** (explicit `null`, existing partial name indexes, no backfill) and **add `iDeletedBy`**; adding `bIsDeleted` there would need a second backfill + index rebuild for no gain (Q4, decided). |
| "Not deleted" filter | Repository layer only, applied by default to every read/count/update: Users/Recipients `{ bIsDeleted: { $ne: true } }` (**a missing field = not deleted**, so old docs load); monitors `{ dDeletedAt: null }` (unchanged). Services, controllers and views never write the filter. Only `listDeleted()` and `findByIdIncludingDeleted()` (explicit names) bypass it. |
| Types + mappers | Domain objects gain `deletedAt: Date \| null` (all four). |
| Repository | One private `notDeleted` filter merged into every existing read/count/update (see above). New `listDeleted()` (`bIsDeleted: true` / monitors `dDeletedAt: {$type:'date'}`, newest first). Users/Recipients `deleteOne` → `softDelete(id, deletedBy)` (atomic `findOneAndUpdate` on the not-deleted filter: `bIsDeleted=true`, `dDeletedAt`, `iDeletedBy`, `bIsActive=false`, `dUpdatedAt`). Monitors: `findByIdIncludingDeleted()` for the read-only detail page only. |
| Service | `remove(actor)` keeps its guards (master protected, last active admin) and audit (`DELETE`, **`oBefore`/`oAfter` with `sPasswordHash` stripped**, existing audit sanitiser); calls `softDelete(id, actor.id)`. The audit entry is written for all four screens. New `listDeleted()`. |
| Controller | `list` also passes `deletedRows`; `remove` new flash (D2). Monitor `detail` resolves deleted ids read-only (`can.edit=false`, no `monitorActions.js`). |
| View | New partial **`partials/deletedRecords.ejs`** (`rows`, `columns`): the button + `<dialog>` + table (same `table-wrap`/`table` classes as the live lists). Each list page puts it in its `.page-head` next to the New button. Monitor detail pages show a "deleted on … no longer runs" banner and no action buttons. |
| CSS / JS | `.deleted-dialog*` (full-screen dialog, own scroll, backdrop, page scroll lock) and `.badge-deleted`, using existing tokens; `public/js/navigation.js` opens/closes (TD-37). |
| Display status | `DISPLAY_STATUS.DELETED` + label "Deleted" (monitors). |

### Per-record specifics

**Monitors (webhook, endpoint)**
- Runners re-read the monitor after storing the check and before alerting; deleted or (for a scheduled run) disabled → keep the check row, skip alerts and state update, log `check.droppedDeleted` (fixes L4).
- `app.ts` alert filter options include deleted monitors with `(deleted)`.

**Recipients**
- Filter `dDeletedAt: null` added to: `findById`, `list`, `findAudience` (**the alert recipient list**), `countMasters`, `update`.
- `findByEmail` (used only by the startup master seed): if the env master email belongs to a deleted recipient, the seed restores it as master (masters cannot be deleted, FR-R3).
- Edit / delete routes on a deleted id → 404.

**Users**
- Filter `dDeletedAt: null` added to: `findById` (so `getActiveById` → **session ends**), `findCredentialsByEmail` (**login refused**, same generic message), `list`, `countActiveAdmins`, `update`.
- `countAll` (first-admin seed) still counts deleted users: "no users exist yet" means never created, so deleting users never re-seeds an admin.
- A deleted user's id stays valid in audit logs and on monitors (`iCreatedBy`/`iUpdatedBy`); that is a benefit of keeping the record.
- Edit / delete routes on a deleted id → 404.

## 5. Email uniqueness for Users and Recipients (Option B, approved)

**Index**: `{ sEmail: 1 }`, `unique: true`, `partialFilterExpression: { bIsDeleted: false }`, name `sEmail_1_active_unique`. Replaces the plain unique `sEmail_1`. A partial index skips documents where the field is **missing**, so the backfill must run first.

**Email comparison**: case-insensitive and trimmed by **normalising to lower-case before saving and querying**. This is what the code already does (`emailSchema` = `trim().toLowerCase()` on every form/API write, auth and seeds lower-case before lookup), so **no collation index** is needed and none is added. The migration reports (counts only, never values) any stored non-normalised email and aborts if two active records collide after normalising.

**Migration** (`scripts/migrate-soft-delete.ts`, `npm run db:migrate-soft-delete`; **written, tested on the memory server, not run for real**):

| Step | Detail |
|------|--------|
| Default mode | **Dry-run** (counts only, no writes; project rule). `--apply` writes. |
| 1 | Pass 1 is read-only: per collection total / missing-flag / duplicate groups / non-normalised counts. Any duplicate among non-deleted docs, compared trimmed + lower-cased → **abort before any write**, exit 1, report counts only. |
| 2 | `updateMany({ bIsDeleted: { $exists: false } }, { $set: { bIsDeleted: false } })`. Only missing fields; nothing else changes. |
| 2b | **Normalise** `sEmail` (trim + lower-case) on non-deleted docs that are not already normalised (the unique index compares exact bytes, so it would not catch case/space variants of them). Cannot create a duplicate: step 1 already aborted on any normalised collision. Dry-run reports the count. |
| 3 | Create `sEmail_1_active_unique` (new name). **MongoDB 7.0.14 (the version our tests run) allows it next to the old unique index on the same key (verified)**, so uniqueness is never off. |
| 4 | Only after step 3 succeeded, drop the old `sEmail_1` (only when it exists). If step 3 throws, nothing is dropped. |
| Re-run | Every step checks state first: second run reports `backfilled=0 exists absent`. |
| Safety | Monitor DB only (never connects to the Source DB); logs counts only; CLI **refuses any non-localhost `MONGO_URI`**. Late old-code inserts without the flag are reported as a warning. |
| If prod MongoDB refuses two indexes on one key (older than 7.0) | Safest order: stop the app → backfill → drop old → create new → start the new app (seconds, no writes possible meanwhile). The script would stop with the driver error and leave the old index; say so and I will adjust. |

**Deploy order (fixed)**:
1. Stop the old app (old code inserts without `bIsDeleted`).
2. Run the migration: dry-run first, read the counts, then `--apply`.
3. Deploy and start the new code.

**`src/database/indexes.ts` at app startup** (to be changed in the feature step): it will create **only** `sEmail_1_active_unique` (partial) for `users` and `recipients`. It will **never drop** `sEmail_1` or any index: today `grep dropIndex` finds no drop anywhere in `src/`, and none will be added. Dropping the legacy index is the migration script's job alone. If the new code starts before the migration, startup still succeeds (the two indexes coexist, the old one keeps guarding), but old documents lacking the flag are outside the new index until the migration backfills them; hence the order above.
**Rollback**: keep the backfilled field (harmless); recreate the old index `createIndex({sEmail:1},{unique:true,name:'sEmail_1'})` on both collections (fails while a deleted record shares an email with an active one: resolve first), then drop `sEmail_1_active_unique`. Steps are also in the script header.
**Approval scope**: local dev DB and test memory server only. Shared/production DB: ask again.

**Restore later** (designed now): `restore(id)` clears the three fields and sets `bIsActive` per the rules of that type, **inside the same unique-index guarantee**: if an active record already uses the email the unique index rejects it (11000) and the service maps that to `409 EMAIL_IN_USE` with a clear message (a pre-check gives the friendlier text). Monitors restore through the scheduler `upsert`. No new migration needed.

## 6. Tests (written first; each fails before its change)

| # | Test | Where |
|---|------|-------|
| T1 | Delete keeps the document on all four screens, with `dDeletedAt` set and inactive; monitor history untouched | HTTP tests per module |
| T2 | Monitor delete: no timer, `nextCheckAt` null, incident closed `MONITOR_DELETED`, no email | `tests/acceptance/12-live-reschedule.test.ts` |
| T3 | In-flight monitor check after delete: check stored, **no** incident/alert/state change (L4) | runner tests |
| T4 | Deleted recipient gets **no** new alert email; alerts stored before the delete keep their list | `tests/acceptance/10-recipients.test.ts` |
| T5 | Deleted user: login refused (generic message), an open session is logged out on the next request, no longer counts as an admin | `tests/integration/http/auth.test.ts`, `users.service.test.ts` |
| T6 | Master recipient and last active admin still cannot be deleted | existing tests, unchanged |
| T7 | Each of the 4 list pages has exactly **one** "Deleted records" button in `.page-head`, before the New button; the modal lists the right rows and columns with UTC "Deleted on"; at 0 it shows "No deleted records" | `tests/integration/http/pages.test.ts` |
| T8 | Monitor pages: viewers see the button and the read-only deleted detail page; nobody sees action buttons on a deleted monitor | `pages.test.ts`, `rbac.test.ts` |
| T9 | Every write route on a deleted id → 404 (monitor edit/delete/pause/resume/run/test email; recipient and user edit/delete) | `rbac.test.ts`, table-driven |
| T10 | Escaping: names/emails in the modal are HTML-escaped; no inline `<script>` or `on*` attributes; no action buttons or forms in any modal | `pages.test.ts` |
| T11 | Email reuse: deleting then creating a user/recipient with the same email (any case, padded) **succeeds**; two active with the same email still 409 | user/recipient HTTP + repo tests |
| T14 | Migration script: dry-run writes nothing, backfill only-missing, duplicate abort leaves DB untouched, index swap order, re-run no-op, no email in logs | `tests/integration/database/migrateSoftDelete.test.ts` (**written, 5 pass**) |
| T15 | Old documents without `bIsDeleted` still load, list, log in and count (treated as not deleted) | repo tests |
| T16 | Delete audit entry exists for all four screens and `sPasswordHash` is absent from `oBefore`/`oAfter` | audit tests |
| T17 | Deleted user: session ends next request; deleted recipient/monitor: no new alerts (T3, T4) | existing T3-T5 |
| T18 | Duplicate-on-restore (service-level, since no Restore UI): restoring a record whose email is used by an active one fails with `EMAIL_IN_USE`; the unique index is the backstop | repo/service tests of the (unrouted) `restore` repository method |
| T12 | Mappers map `deletedAt`; `displayStatus` returns `DELETED` | unit tests |
| T13 | Alerts filter lists deleted monitors as `(deleted)` | `pages.test.ts` |

Existing tests asserting the old flash/confirm texts or a hard delete get updated.

## 7. Docs to update in the same change

- `docs/requirements.md`: FR-D2 (monitors), FR-R1 (recipients), §3 (users): "Delete does not remove the record: it stops it, makes it inactive and lists it under Deleted records (read-only). History is kept." FR-D4: read-only page for deleted monitors.
- `docs/database-design.md`: `users`/`recipients` fields `bIsDeleted`, `dDeletedAt`, `iDeletedBy`, monitors `iDeletedBy`; email index `sEmail_1_active_unique` (partial, replaces `sEmail_1`); "missing = not deleted"; migration section replacing "No migrations exist yet"; normalise-on-write note.
- `docs/architecture.md` §5.1 / §5.4: runners re-check before alerting.
- `docs/technical-decisions.md`: **TD-36 · Soft delete (stop + deactivate, keep the record) with partial unique email index** (D1–D10, fields, repository-level filter, normalise-on-write instead of collation, migration order, restore design). **Required line in the entry** (user, Q4): "Monitors keep `dDeletedAt: null` as the deleted marker (their partial name indexes already use it, no migration) while Users and Recipients use `bIsDeleted: false`, because a partial index cannot filter on a missing field and those documents had no marker before. Only the repository layer knows which marker a collection uses; services, controllers and views never see it."
- `docs/review_opus.md`: **L4** fixed with test lines.
- `docs/implementation_progress.md`: log entry with real gate results.

## 8. Impact and backward compatibility

| Area | Impact |
|------|--------|
| Stored data | Monitors: only new optional `iDeletedBy`. Users/Recipients: new fields; old docs without `bIsDeleted` read as active; one-off migration (above) backfills the flag and swaps the email index. |
| Previously hard-deleted users/recipients | Already gone; they cannot appear in Deleted records. |
| Routes | **None added.** Monitor detail GET also serves deleted ids read-only; all write routes still 404 on deleted ids. |
| Email / alerts | No new type. Deleted recipients drop out of new alerts only. |
| Security | Deleted users lose login and sessions immediately; server-side checks, not just hidden buttons. No inline JS; output stays `<%= %>`. |
| Dependencies / Source DB | None / untouched. |

## 9. Out of scope (named, not built)

- **Restore** (all four): repository/service `restore` for users and recipients already exist and are tested but unrouted (T18); monitors still need a POST route + audit `RESTORE` + scheduler `upsert`. Easy later (POST route + audit `RESTORE` + scheduler `upsert` for monitors).
- Permanent purge (conflicts with FR-H3).
- One combined deleted list across screens, search or paging in the modal; Restore; a "Deleted by" column.

## 10. Open questions

1. ~~Q1~~ **B approved.** 2. ~~Restore~~ **deferred, designed for.** 3. Wording: keep **Delete** (default).
4. ~~Q4~~ **Decided:** monitors keep `dDeletedAt` and only gain `iDeletedBy`; no `bIsDeleted` on monitors.

## 11. Checklist (resume here)

- [x] Option B approved; migration script + its test written (T14) and green on the memory server
- [x] Q4 answered; script now also normalises emails (7 script tests green)
- [x] User reviewed counts, approved `--apply` (local dev DB only)
- [x] Migration applied on local dev DB (2026-11-19): users 1 / recipients 2 backfilled, `sEmail_1_active_unique` created, `sEmail_1` dropped; re-run dry-run = 0 to backfill, 0 to normalise. Backup (mongodump users+recipients) in the session scratchpad `dump/`.
- [x] T1–T13, T15–T18 written, run red (36 fail for missing feature, 0 setup errors) — files: tests/integration/softDelete/{users,recipients,monitors}.softDelete.test.ts, tests/integration/http/deletedRecords.test.ts, tests/unit/softDelete/mappers.test.ts, L4 blocks appended to tests/integration/runners/{webhook,endpoint}Runner.test.ts
- [x] Shared: `DISPLAY_STATUS.DELETED`, `partials/deletedRecords.ejs`, CSS
- [x] Monitors: `findByIdIncludingDeleted`, `listDeleted`, read-only detail, runner re-check (L4), alerts filter
- [x] Recipients: `dDeletedAt`, `softDelete`, filters (incl. `findAudience`), seed restore, `listDeleted`
- [x] Users: `dDeletedAt`, `softDelete`, filters (login, session, admin count), `listDeleted`
- [x] `src/database/indexes.ts`: replace plain `sEmail` unique with `sEmail_1_active_unique` (users + recipients)
- [x] All four list pages: one **Deleted records** button beside New
- [x] Docs (§7) and TD-36
- [x] Targeted tests green, gates run once (2026-11-19): typecheck ok, lint ok, format ok for our files, build ok; `npm test` 723/725 (2 known shutdown-flake failures in runtime.test.ts); acceptance 46/47 (13-source-read-only: pre-existing date-dependent test). See progress log.
- [x] Progress log entry
- [x] Dropdown → full-screen modal (2026-11-20): shared `deletedRecords.ejs` rewritten around `<dialog>`, `navigation.js`, full-column deleted rows in the 4 `*.view.ts`, CSS, tests T7/T8/T10 updated, TD-37
