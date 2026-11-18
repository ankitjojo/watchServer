# payMonitor — Database Design

> Status: **Proposed**. Nothing below exists yet — no collection, index or migration has been created.
> Requirements: [requirements.md §6](requirements.md). Rules: `.claude/rules/database.md`. Decisions: TD-03, TD-04, TD-08, TD-09.

Two MongoDB databases, two clients, two very different rule sets.

---

## Part A — Source DB (JOJO subscription backend) — READ ONLY

### A.1 What we know [Confirmed by reading `jojo_subscription_backend_2_0`]

| Collection | Timestamp written as | `dCreatedAt:-1` index in source `scripts/create_indexes.js` |
|------------|----------------------|------------------------------------------------------------|
| `razor_pay_webhook_data` | `dCreatedAt: new Date()` (BSON Date) | Yes (in script) |
| `apple_pay_webhook_data` | BSON Date | Yes (in script) |
| `google_play_billing_webhook_logs` | BSON Date (migrated docs keep original dates) | Yes (in script) |
| `amazon_pay_webhook_data` | BSON Date | **No** |
| `me_pass_webhooks` | BSON Date | **No** |

"In script" ≠ verified in the live DB. The `hasDescendingIndex` check (FR non-functional §5) is how the app verifies it at runtime.
**Risk**: monitoring `amazon_pay_webhook_data` / `me_pass_webhooks` without an index forces a collection scan + in-memory sort every check. Ask the source backend owners to add `{ dCreatedAt: -1 }`; payMonitor must not create it.

### A.2 Access rules
- Client: separate `MongoClient` from `SOURCE_MONGO_URI`, DB user with built-in `read` role on the source DB only.
- Small pool: `maxPoolSize: 5`, `readPreference: 'secondaryPreferred'` (offload primary; staleness tolerance of seconds is fine) — [Recommendation; confirm source topology].
- Allowed operations (whole list): `listCollections({}, { nameOnly: true })`, `find(...).sort(...).limit(1)` with projection, `indexes()`.
- Every query: projection `{ _id: 1, [key]: 1 }`, `maxTimeMS: SOURCE_QUERY_TIMEOUT_MS`.
- Collection name and key come from admin input → validate: collection must exist in `listCollections` result; key must match `^[A-Za-z_][A-Za-z0-9_.]{0,63}$` and not start with `$` (prevents operator injection in sort/projection).

### A.3 Timestamp parsing (FR-W2)
`parseSourceTimestamp(value: unknown): Date | null` in `src/utils/timestamp.ts`:
- `Date` → valid if not NaN.
- `string` → ISO-8601 only (`Date.parse` + regex guard).
- `number` → `< 1e11` seconds ×1000, else milliseconds. Reject negative / > now + 1 day (clock-skew guard → `NO_DATA` with reason `INVALID_TIMESTAMP`).
- anything else → `null`.

**Caveat**: sort order on a mixed-type field follows BSON type order, not time. If a collection mixes types, "latest" may be wrong. Today all 5 collections use `Date`, so this is documented, not handled.

---

## Part B — Monitor DB (payMonitor) — read/write

Conventions: camelCase fields (TD-04); `_id: ObjectId`; every doc has `createdAt`, `updatedAt` (UTC `Date`); references are `ObjectId` named `<entity>Id`.
Enum-like values are stored as the UPPER_SNAKE constants from `src/constants` (e.g. requirements' recipient type `normal`/`master` is stored as `NORMAL`/`MASTER`; UI shows friendly labels).
Collections beyond requirements §6 added by this design: `scheduler_locks` (TD-05) and `sessions` (TD-11).

### B.1 Collections

#### `users` (§3)
| Field | Type | Notes |
|-------|------|-------|
| name | string | |
| email | string | lower-cased, trimmed |
| passwordHash | string | bcrypt cost 12 — never returned to views/API |
| role | `ADMIN` \| `VIEWER` | |
| isActive | boolean | |
| lastLoginAt | Date \| null | |
Indexes: `{ email: 1 }` unique.

#### `recipients` (FR-R1..R3)
| name | email | isActive | type `NORMAL`\|`MASTER` |
Indexes: `{ email: 1 }` unique; `{ isActive: 1, type: 1 }`.
Invariant "≥ 1 MASTER exists" is enforced in the service (master cannot be deleted/deactivated; type cannot be changed from MASTER).

#### `webhook_monitors` (FR-W1)
| Field | Type |
|-------|------|
| name | string (unique among non-deleted) |
| gatewayName | string |
| sourceCollection | string |
| timestampKey | string |
| checkInterval | `{ value, unit: 'minute'\|'hour', ms }` |
| threshold | `{ value, unit: 'minute'..'month', ms }` |
| alertMode | `ONCE_WITH_RECOVERY`\|`EVERY_CHECK`\|`REPEAT_EVERY` |
| repeatInterval | `{ value, unit, ms }` \| absent (only when `REPEAT_EVERY`) |
| isEnabled | boolean |
| hasDescIndexAtSave | boolean (for the warning badge) |
| state | `{ currentStatus, lastCheckAt, nextCheckAt, lastCheckId, openIncidentId, lastAlertAt, reminderCount }` |
| deletedAt | Date \| null |
| createdBy / updatedBy | ObjectId (users) |
Indexes: `{ name: 1 }` unique with `partialFilterExpression: { deletedAt: null }`; `{ isEnabled: 1, deletedAt: 1 }`.

#### `endpoint_monitors` (FR-E1)
Same shape minus source fields; plus `serverName`, `url`, `retryCount` (0..`ENDPOINT_MAX_RETRY_COUNT`).
Indexes: `{ serverName: 1 }` unique partial on `deletedAt: null`; `{ isEnabled: 1, deletedAt: 1 }`.

#### `checks` (FR-H1) — append-only, high volume
| Field | Type |
|-------|------|
| monitorId | ObjectId |
| monitorType | `WEBHOOK`\|`ENDPOINT` |
| trigger | `SCHEDULE`\|`MANUAL` |
| startedAt / finishedAt | Date |
| result | `OK`\|`STALE`\|`NO_DATA`\|`DOWN`\|`ERROR` |
| webhook? | `{ lastDocId, lastDocTimestamp, ageMs, thresholdMs, reason? }` |
| endpoint? | `{ attempts: [{ n, statusCode?, responseTimeMs, errorCode?, errorMessage? }] }` |
| error? | `{ code, message }` (sanitized; no stack, no URI with credentials) |
Indexes: `{ monitorId: 1, startedAt: -1 }` (history + charts); `{ startedAt: -1 }` (global views).
Growth estimate: 20 monitors × 1/min ≈ 29k docs/day ≈ 10.5M/year. Retention = keep everything (FR-H3) → see §B.5.

#### `incidents` (FR-A3, FR-A4a)
`monitorId` (null for source outages), `kind` (`MONITOR`\|`SOURCE_ERROR`), `openedAt`, `closedAt|null`, `openingResult`, `affectedMonitorIds[]` (source outages), `lastCheckId`.
Indexes: `{ monitorId: 1, openedAt: -1 }`; `{ monitorId: 1, closedAt: 1 }` unique partial on `closedAt: null` → **at most one open incident per monitor**; same for `{ kind: 1 }` partial `{ kind: 'SOURCE_ERROR', closedAt: null }`.

#### `alerts` (FR-A1..A6)
| Field | Type |
|-------|------|
| dedupeKey | string (TD-09) |
| type | alert type |
| monitorId / incidentId / checkId | ObjectId \| null |
| monitorSnapshot | `{ type, name, gatewayName?, sourceCollection?, timestampKey?, url?, thresholdMs?, checkIntervalMs? }` |
| recipients | `[{ name, email, type }]` resolved at creation |
| subject / textBody / htmlBody | string (rendered at creation — what was sent is what's stored) |
| status | `PENDING`\|`RETRYING`\|`SENT`\|`FAILED` |
| attempts | `[{ at, ok, errorCode?, errorMessage? }]` |
| nextAttemptAt | Date \| null |
| lockedUntil | Date \| null (dispatcher claim) |
| sentAt / messageId / failureReason | |
Indexes: `{ dedupeKey: 1 }` unique; `{ status: 1, nextAttemptAt: 1 }` (dispatcher); `{ monitorId: 1, createdAt: -1 }`; `{ createdAt: -1 }`.

#### `audit_logs` (FR-H2)
`actorUserId`, `actorEmail`, `action` (`CREATE|UPDATE|DELETE|PAUSE|RESUME|RESEND|LOGIN`…), `entityType`, `entityId`, `before`, `after` (with `passwordHash` stripped), `at`.
Indexes: `{ entityType: 1, entityId: 1, at: -1 }`; `{ at: -1 }`.

#### `scheduler_locks` (TD-05)
`_id: 'scheduler'`, `ownerId` (hostname+pid+uuid), `expiresAt`. Acquire/renew with `findOneAndUpdate({ _id, $or:[{ownerId}, {expiresAt:{$lt:now}}] }, ..., { upsert: true })` — duplicate key on upsert = someone else holds it.

#### `sessions`
Owned by `connect-mongo` (TTL handled by the library).

### B.2 Concurrency & atomicity
| Risk | Control |
|------|---------|
| Scheduled and manual run of same monitor overlap | In-process per-monitor in-flight set (single instance); manual run waits/returns "already running". |
| Two dispatch loops send the same alert | Atomic claim via `lockedUntil` in `findOneAndUpdate`; lease lock. |
| Crash between "alert inserted" and "state updated" | Dedupe key makes re-creation a no-op; next check recomputes from `incidents` (source of truth for open incident). |
| Two open incidents for one monitor | Unique partial index (B.1 incidents). |
| Admin edits monitor while check running | Runner works on the snapshot it loaded; state update uses `$set` on `state.*` only, never overwrites config fields. |
| Last admin demoted concurrently | Service checks count then updates with a conditional filter; accept tiny race (rare admin op) — documented. |
Transactions are **not** required by this design (open question A1).

### B.3 Pagination & projection
- History/alert lists: keyset pagination on `(startedAt|createdAt, _id)` descending; page size default 50, max 200.
- Lists project only displayed fields; never load `textBody/htmlBody` in list views.
- Chart series: aggregate server-side, cap points (≤ 500) by bucketing for 7d/30d ranges.

### B.4 Schema evolution
- No migration framework initially. Index creation in `src/database/indexes.ts`, run explicitly via `npm run db:indexes` (not silently on every boot in production) — [Recommendation].
- Additive changes only (new optional fields). Renames/removals need a written plan in `docs/implementation_plans/` + a script under `scripts/` that defaults to **dry-run**.
- Repositories tolerate missing optional fields (old docs).

### B.5 Retention, backup, recovery
- FR-H3 says keep everything. `checks` will dominate storage (~10M docs/year at 20 monitors × 1/min). **[Open] Risk — needs a product decision**; options: TTL on `checks` only, or a monthly roll-up collection. Not implemented without approval.
- Backups: ops responsibility (mongodump / Atlas snapshots) — [Open]: who owns it.
- Recovery: app is restart-safe (lease, dedupe keys, dispatcher resume).

### B.6 Sensitive data & access
- Monitor DB user: `readWrite` on the payMonitor DB only.
- Never store SMTP credentials, passwords (only hashes), or source URIs in documents.
- Endpoint URLs may contain tokens in query strings → mask query values in logs and emails (`?token=***`).
- Log query metadata (collection, durationMs, result count), never filter values containing emails.

### B.7 Errors
- Map Mongo duplicate key (`code 11000`) → `ConflictError` with a field-level message.
- Network/timeouts → `ExternalServiceError`; never send raw driver messages to clients (they can include hostnames).
