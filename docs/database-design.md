# payMonitor — Database Design

> Status: **Implemented** (v1). Indexes are created by `src/database/indexes.ts` (`npm run db:indexes`; automatic outside production). No migrations exist yet.
> Requirements: [requirements.md §6](requirements.md). Rules: `.claude/rules/database.md`. Decisions: TD-03, TD-08, TD-09, TD-16.

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
- Allowed operations (whole list): `listCollections({} or { name }, { nameOnly: true, maxTimeMS })`, `find(...).sort(...).limit(1)` with projection, `indexes()`. A check runs only the `find`; `listCollections({ name })` follows only when the find is empty, to tell an empty collection (NO_DATA) from a missing one (the monitor's own MONITOR_ERROR, TD-29). Reading a missing collection creates nothing.
- Every query: projection `{ _id: 1, [key]: 1 }`, `maxTimeMS: SOURCE_QUERY_TIMEOUT_MS`.
- Collection name and key come from admin input → validate: name pattern always; on save the collection must exist in the `listCollections` result (at check time see above); key must match `^[A-Za-z_][A-Za-z0-9_.]{0,63}$` and not start with `$` (prevents operator injection in sort/projection).

### A.3 Timestamp parsing (FR-W2)
`parseSourceTimestamp(value: unknown): Date | null` in `src/utils/timestamp.ts`:
- `Date` → valid if not NaN.
- `string` → ISO-8601 only (`Date.parse` + regex guard).
- `number` → `< 1e11` seconds ×1000, else milliseconds. Reject negative / > now + 1 day (clock-skew guard → `NO_DATA` with reason `INVALID_TIMESTAMP`).
- anything else → `null`.

**Caveat**: sort order on a mixed-type field follows BSON type order, not time. If a collection mixes types, "latest" may be wrong. Today all 5 collections use `Date`, so this is documented, not handled.

---

## Part B — Monitor DB (payMonitor) — read/write

### B.0 Field naming convention (TD-16) — same as the subscription backend

Every stored field (top level **and** nested) starts with a one-letter type prefix, then PascalCase. Verified against `jojo_subscription_backend_2_0` (`sName`, `sEmail`, `bIsActive`, `dCreatedAt`, `eStatus`, `nRetryAttempts`, `oPaymentDetails`, `aFeatureIds`, `iUserId`).

| Prefix | Type | Example |
|--------|------|---------|
| `s` | string | `sName`, `sEmail`, `sPasswordHash` |
| `n` | number (int or float) | `nRetryCount`, `nAgeMs` |
| `b` | boolean | `bIsActive`, `bIsEnabled` |
| `d` | Date | `dCreatedAt`, `dSentAt` |
| `e` | enum value (stored as an UPPER_SNAKE constant) | `eStatus`, `eRole`, `eAlertMode` |
| `o` | embedded object | `oThreshold`, `oState` |
| `a` | array | `aRecipients`, `aAttempts` |
| `i` | ObjectId reference to another document | `iMonitorId`, `iCreatedBy` |

Rules:
- `_id` stays `_id`. Collection names stay snake_case plural (requirements §6).
- Booleans keep the `Is/Has` word after the prefix: `bIsActive`, `bHasDescIndex`.
- Arrays of ObjectIds: `aAffectedMonitorIds`. Number units still go at the end: `nThresholdMs`.
- Every document has `dCreatedAt` and `dUpdatedAt` (UTC `Date`).
- Enum values are the UPPER_SNAKE constants from `src/constants` (e.g. requirements' recipient type `normal`/`master` is stored as `eType: 'NORMAL' | 'MASTER'`; UI shows friendly labels).
- The prefix describes the **stored** type. If a field can be null, the prefix still names the non-null type (`dClosedAt: Date | null`).
- Applies **only to the persistence layer**: stored documents, their `<Entity>Doc` types, mappers, repositories, indexes. Services, forms, API bodies, view-models, query params and logs use camelCase; `<module>.mapper.ts` converts between them (TD-16).

```ts
// webhookMonitors.types.ts
export interface WebhookMonitorDoc {            // stored shape: prefixed
  _id: ObjectId; sName: string; sGatewayName: string; oThreshold: StoredDuration; bIsEnabled: boolean; /* … */
}
export interface WebhookMonitor {               // domain shape: camelCase, used by services/controllers/views/API
  id: string; name: string; gatewayName: string; threshold: Duration; isEnabled: boolean; /* … */
}
// webhookMonitors.mapper.ts
export function toWebhookMonitor(doc: WebhookMonitorDoc): WebhookMonitor { /* sName → name, … */ }
export function toWebhookMonitorDoc(input: CreateWebhookMonitorInput, ctx: { now: Date; userId: ObjectId; daysPerMonth: number }): Omit<WebhookMonitorDoc, '_id'> { /* name → sName, … */ }
```

Collections beyond requirements §6 added by this design: `scheduler_locks` (TD-05) and `sessions` (TD-11).

### B.1 Collections

Shared shape used for every duration (`oCheckInterval`, `oThreshold`, `oRepeatInterval`):
`{ nValue: number, eUnit: 'MINUTE'|'HOUR'|'DAY'|'WEEK'|'MONTH', nMs: number }` (TD-08).

#### `users` (§3)
| Field | Type | Notes |
|-------|------|-------|
| sName | string | |
| sEmail | string | lower-cased, trimmed |
| sPasswordHash | string | bcrypt cost 12, never returned to views/API |
| eRole | `ADMIN` \| `VIEWER` | |
| bIsActive | boolean | |
| dLastLoginAt | Date \| null | |
Indexes: `{ sEmail: 1 }` unique.

#### `recipients` (FR-R1..R3)
| Field | Type |
|-------|------|
| sName | string |
| sEmail | string (lower-cased) |
| bIsActive | boolean |
| eType | `NORMAL` \| `MASTER` |
Indexes: `{ sEmail: 1 }` unique; `{ bIsActive: 1, eType: 1 }`.
Invariant "≥ 1 MASTER exists" is enforced in the service (a master cannot be deleted or deactivated; `eType` cannot be changed from MASTER).

#### `webhook_monitors` (FR-W1)
| Field | Type |
|-------|------|
| sName | string (unique among non-deleted) |
| sGatewayName | string |
| sSourceCollection | string |
| sTimestampKey | string (the Source DB field name, e.g. `dCreatedAt`) |
| oCheckInterval | duration, units `MINUTE`\|`HOUR` |
| oThreshold | duration, units `MINUTE`..`MONTH` |
| eAlertMode | `ONCE_WITH_RECOVERY`\|`EVERY_CHECK`\|`REPEAT_EVERY` |
| oRepeatInterval | duration (units `MINUTE`\|`HOUR`\|`DAY`), absent unless `REPEAT_EVERY` |
| bIsEnabled | boolean |
| bHasDescIndexAtSave | boolean (for the warning badge) |
| oState | `{ eLastResult, eCurrentStatus, dLastCheckAt, dNextCheckAt, iLastCheckId, iOpenIncidentId, nLastAgeMs, nLastResponseTimeMs }`. `eLastResult` is the last result including `ERROR`; `eCurrentStatus` stays unchanged during a source outage (FR-A4a) and is `ERROR` for the monitor's own per-collection error (TD-29). `dLastAlertAt` / `nReminderCount` live on `incidents` (TD-21). Written only through dotted `$set` on `oState.*`. |
| dDeletedAt | Date \| null (always stored, `null` while active) |
| iCreatedBy / iUpdatedBy | ObjectId (users) |
Indexes: `{ sName: 1 }` unique with `partialFilterExpression: { dDeletedAt: { $type: 'null' } }` (MongoDB rejects `{ field: null }` in a partial filter, so documents must store an explicit `null`); `{ bIsEnabled: 1, dDeletedAt: 1 }`.

#### `endpoint_monitors` (FR-E1)
Same shape minus `sGatewayName`, `sSourceCollection`, `sTimestampKey`, `bHasDescIndexAtSave`; plus `sServerName`, `sUrl`, `nRetryCount` (0..`ENDPOINT_MAX_RETRY_COUNT`). No `sName`; `sServerName` is the unique display name.
Indexes: `{ sServerName: 1 }` unique partial on `dDeletedAt: { $type: 'null' }`; `{ bIsEnabled: 1, dDeletedAt: 1 }`.

#### `checks` (FR-H1): append-only, high volume
| Field | Type |
|-------|------|
| iMonitorId | ObjectId |
| eMonitorType | `WEBHOOK`\|`ENDPOINT` |
| eTrigger | `SCHEDULE`\|`MANUAL` |
| dStartedAt / dFinishedAt | Date |
| eResult | `OK`\|`STALE`\|`NO_DATA`\|`DOWN`\|`ERROR` |
| oWebhook? | `{ iLastDocId?, dLastDocTimestamp?, nAgeMs?, nThresholdMs, eReason? }` |
| oEndpoint? | `{ aAttempts: [{ nAttempt, nStatusCode?, nResponseTimeMs, sErrorCode?, sErrorMessage? }] }` |
| oError? | `{ sCode, sMessage }` (sanitized; no stack, no URI with credentials) |
`oWebhook.iLastDocId` holds the Source DB document's `_id`. It is usually an ObjectId, but the Source DB doesn't guarantee that, so the document type is `ObjectId | string`.
Indexes: `{ iMonitorId: 1, dStartedAt: -1 }` (history + charts); `{ dStartedAt: -1 }` (global views).
Growth estimate: 20 monitors × 1/min ≈ 29k docs/day ≈ 10.5M/year. Retention = keep everything (FR-H3), see §B.5.

#### `incidents` (FR-A3, FR-A4a)
| Field | Type |
|-------|------|
| iMonitorId | ObjectId \| null (null for source outages) |
| eKind | `MONITOR`\|`SOURCE_ERROR` |
| dOpenedAt | Date |
| dClosedAt | Date \| null |
| eOpeningResult | check result |
| aAffectedMonitorIds | ObjectId[] (source outages) |
| iLastCheckId | ObjectId |
| dLastAlertAt | Date \| null (time of the last email for this incident; reminder timing, TD-21) |
| nReminderCount | number (reminders sent so far) |
| eCloseReason | `RECOVERED` \| `MONITOR_DELETED` (set when closed; TD-22) |
Indexes: `{ iMonitorId: 1, dOpenedAt: -1 }`; `{ iMonitorId: 1 }` unique partial on `{ eKind: 'MONITOR', dClosedAt: { $type: 'null' } }` → **at most one open incident per monitor**; `{ eKind: 1 }` unique partial on `{ eKind: 'SOURCE_ERROR', dClosedAt: { $type: 'null' } }` → at most one open source outage.

#### `alerts` (FR-A1..A6)
| Field | Type |
|-------|------|
| sDedupeKey | string (TD-09) |
| eType | alert type |
| iMonitorId / iIncidentId / iCheckId | ObjectId \| null |
| oMonitorSnapshot | `{ eMonitorType, sName, sGatewayName?, sSourceCollection?, sTimestampKey?, sUrl? (masked), nThresholdMs?, nCheckIntervalMs?, eAlertMode?, nRepeatIntervalMs? }`, or `null` for grouped source-outage alerts |
| aAffectedMonitors? | `[{ iMonitorId, sName, eMonitorType }]`: source-outage alerts only (FR-A4a); `iMonitorId` is `null` on those alerts |
| aRecipients | `[{ sName, sEmail, eType }]` resolved at creation |
| sSubject / sTextBody / sHtmlBody | string (rendered at creation, so what was sent is what's stored) |
| eStatus | `PENDING`\|`RETRYING`\|`SENT`\|`FAILED` |
| aAttempts | `[{ dAt, bIsSuccess, sErrorCode?, sErrorMessage? }]` |
| nRetryIndex | number: backoff steps used so far; reset to 0 by a manual resend (D13) |
| dNextAttemptAt | Date \| null (when the dispatcher may send it; the grouped outage mail uses `incident.dOpenedAt + SOURCE_ERROR_GROUP_WINDOW_MS`) |
| dLockedUntil | Date \| null (dispatcher claim) |
| sClaimId | string \| null (token of the current claim; outcome writes match it, TD-32; absent on older documents) |
| dSentAt / sMessageId / sFailureReason | |
Indexes: `{ sDedupeKey: 1 }` unique; `{ eStatus: 1, dNextAttemptAt: 1 }` (dispatcher); `{ iMonitorId: 1, dCreatedAt: -1 }`; `{ dCreatedAt: -1 }`.

#### `audit_logs` (FR-H2)
| Field | Type |
|-------|------|
| iActorUserId | ObjectId |
| sActorEmail | string |
| eAction | `CREATE`\|`UPDATE`\|`DELETE`\|`PAUSE`\|`RESUME`\|`RESEND`\|`LOGIN`… |
| eEntityType | `USER`\|`RECIPIENT`\|`WEBHOOK_MONITOR`\|`ENDPOINT_MONITOR` |
| iEntityId | ObjectId |
| oBefore / oAfter | opaque snapshots of the **domain** object (camelCase, passwords/hashes/CSRF stripped). This is the one documented exception to prefixed names (TD-16): they are payload, not queryable schema. |
| dAt | Date (audit logs are append-only: no `dCreatedAt`/`dUpdatedAt`) |
Indexes: `{ eEntityType: 1, iEntityId: 1, dAt: -1 }`; `{ dAt: -1 }`.

#### `scheduler_locks` (TD-05)
`_id: 'scheduler'`, `sOwnerId` (hostname+pid+uuid), `dExpiresAt`. Acquire/renew with `findOneAndUpdate({ _id, $or: [{ sOwnerId }, { dExpiresAt: { $lt: now } }] }, ..., { upsert: true })`. A duplicate key error on upsert means someone else holds the lock.

#### `sessions`
Owned by `connect-mongo`, which controls its field names and TTL. The prefix convention does not apply.

### B.2 Concurrency & atomicity
| Risk | Control |
|------|---------|
| Scheduled and manual run of same monitor overlap | In-process per-monitor in-flight set (single instance); manual run returns "already running". |
| Two dispatch loops send the same alert | Atomic claim via `dLockedUntil` in `findOneAndUpdate`; lease lock. |
| Crash between "alert inserted" and "state updated" | `sDedupeKey` makes re-creation a no-op; next check recomputes from `incidents` (source of truth for the open incident). |
| Two open incidents for one monitor | Unique partial index (B.1 incidents). |
| Admin edits monitor while check running | Runner works on the snapshot it loaded; state update uses `$set` on `oState.*` only, never overwrites config fields. |
| Last admin demoted concurrently | Service checks count then updates with a conditional filter; accept the tiny race (rare admin op). |
Transactions are **not** required by this design (open question A1).

### B.3 Pagination & projection
- History/alert lists: keyset pagination on `(dStartedAt|dCreatedAt, _id)` descending; page size default 50, max 200.
- Lists project only displayed fields; never load `sTextBody`/`sHtmlBody` in list views.
- Chart series: aggregate server-side, cap points (≤ 500) by bucketing for 7d/30d ranges.

### B.4 Schema evolution
- No migration framework initially. Index creation in `src/database/indexes.ts`, run at every startup in every environment (idempotent; a failure stops startup, TD-31) and on demand via `npm run db:indexes`.
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
