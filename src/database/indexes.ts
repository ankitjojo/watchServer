import type { Collection, Db, IndexSpecification, IndexOptions } from 'mongodb';
import { COLLECTIONS } from '../constants/collections.js';

// Partial indexes use $type null: MongoDB rejects `{ field: null }` in partialFilterExpression.
// Documents must therefore store `dDeletedAt` / `dClosedAt` as an explicit null, never omit them.
const NOT_DELETED = { dDeletedAt: { $type: 'null' } } as const;

function ensure(collection: Collection, spec: IndexSpecification, options?: IndexOptions): Promise<string> {
  return collection.createIndex(spec, options, undefined);
}

/** Creates every Monitor DB index (database-design B.1). Idempotent. Never touches the Source DB. */
export async function ensureMonitorDbIndexes(db: Db): Promise<void> {
  await ensure(db.collection(COLLECTIONS.USERS), { sEmail: 1 }, { unique: true });

  const recipients = db.collection(COLLECTIONS.RECIPIENTS);
  await ensure(recipients, { sEmail: 1 }, { unique: true });
  await ensure(recipients, { bIsActive: 1, eType: 1 });

  const webhookMonitors = db.collection(COLLECTIONS.WEBHOOK_MONITORS);
  await ensure(webhookMonitors, { sName: 1 }, { unique: true, partialFilterExpression: NOT_DELETED });
  await ensure(webhookMonitors, { bIsEnabled: 1, dDeletedAt: 1 });

  const endpointMonitors = db.collection(COLLECTIONS.ENDPOINT_MONITORS);
  await ensure(endpointMonitors, { sServerName: 1 }, { unique: true, partialFilterExpression: NOT_DELETED });
  await ensure(endpointMonitors, { bIsEnabled: 1, dDeletedAt: 1 });

  const checks = db.collection(COLLECTIONS.CHECKS);
  await ensure(checks, { iMonitorId: 1, dStartedAt: -1 });
  await ensure(checks, { dStartedAt: -1 });

  const incidents = db.collection(COLLECTIONS.INCIDENTS);
  await ensure(incidents, { iMonitorId: 1, dOpenedAt: -1 });
  // At most one open incident per monitor, and at most one open source outage.
  await ensure(
    incidents,
    { iMonitorId: 1 },
    { unique: true, partialFilterExpression: { eKind: 'MONITOR', dClosedAt: { $type: 'null' } } },
  );
  await ensure(
    incidents,
    { eKind: 1 },
    { unique: true, partialFilterExpression: { eKind: 'SOURCE_ERROR', dClosedAt: { $type: 'null' } } },
  );

  const alerts = db.collection(COLLECTIONS.ALERTS);
  await ensure(alerts, { sDedupeKey: 1 }, { unique: true });
  await ensure(alerts, { eStatus: 1, dNextAttemptAt: 1 });
  await ensure(alerts, { iMonitorId: 1, dCreatedAt: -1 });
  await ensure(alerts, { dCreatedAt: -1 });

  const audit = db.collection(COLLECTIONS.AUDIT_LOGS);
  await ensure(audit, { eEntityType: 1, iEntityId: 1, dAt: -1 });
  await ensure(audit, { dAt: -1 });
}
