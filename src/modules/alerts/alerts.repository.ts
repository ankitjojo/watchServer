import { ObjectId, type Db, type Filter } from 'mongodb';
import { COLLECTIONS } from '../../constants/collections.js';
import type { Paginated } from '../../types/paginated.js';
import { decodeCursor, encodeCursor } from '../../utils/cursor.js';
import { toAlert, toAlertToSend } from './alerts.mapper.js';
import type { Alert, AlertDoc, AlertListFilter, AlertRecipientView, AlertToSend } from './alerts.types.js';

export interface AttemptRecord {
  dAt: Date;
  bIsSuccess: boolean;
  sErrorCode?: string;
  sErrorMessage?: string;
}

export interface AlertsRepository {
  /** TD-09: a duplicate key is not an error; it returns the existing alert with `created: false`. */
  insert(doc: Omit<AlertDoc, '_id'>): Promise<{ created: boolean; alert: Alert }>;
  findById(id: string): Promise<Alert | null>;
  findByDedupeKey(key: string): Promise<Alert | null>;
  /** Source-outage alerts keep their affected monitors on the document. */
  findAffectedMonitors(
    id: string,
  ): Promise<{ monitorId: string; name: string; monitorType: 'WEBHOOK' | 'ENDPOINT' }[]>;
  /** Atomically takes one due PENDING/RETRYING alert and locks it under `claimId` (FR-A1, architecture 5.3). */
  claimNext(now: Date, lockedUntil: Date, claimId: string): Promise<AlertToSend | null>;
  /**
   * The outcome writes below are fenced on the claim (review M6): they return false and change
   * nothing when another dispatcher has claimed the alert since.
   */
  markSent(
    id: string,
    claimId: string,
    input: { at: Date; messageId: string; attempt: AttemptRecord },
  ): Promise<boolean>;
  markRetry(
    id: string,
    claimId: string,
    input: { at: Date; nextAttemptAt: Date; retryIndex: number; attempt: AttemptRecord },
  ): Promise<boolean>;
  markFailed(
    id: string,
    claimId: string,
    input: { at: Date; reason: string; attempt: AttemptRecord },
  ): Promise<boolean>;
  /** FAILED -> PENDING (FR-A2). Conditional: returns null if the alert is not FAILED any more. */
  requeueFailed(id: string, now: Date, recipients?: AlertRecipientView[]): Promise<Alert | null>;
  /**
   * Review M2: atomically adds a monitor to a not-yet-sent grouped outage alert (PENDING, not claimed,
   * not already listed). Returns the full list after the change, or null when nothing was added.
   */
  addAffectedToPending(
    id: string,
    now: Date,
    monitor: { monitorId: string; name: string; monitorType: 'WEBHOOK' | 'ENDPOINT' },
  ): Promise<{ monitorId: string; name: string; monitorType: 'WEBHOOK' | 'ENDPOINT' }[] | null>;
  /**
   * Re-renders a not-yet-sent grouped alert. Written only while it is PENDING, not claimed, and still
   * lists exactly `affectedCount` monitors, so a render made from an older list can never win (M2).
   */
  updatePendingContent(
    id: string,
    now: Date,
    content: { subject: string; textBody: string; htmlBody: string; affectedCount: number },
  ): Promise<boolean>;
  /** Makes a PENDING alert due now (so the outage mail precedes its recovery mail). */
  expedite(id: string, now: Date): Promise<void>;
  listForMonitor(monitorId: string, limit: number): Promise<Alert[]>;
  list(filter: AlertListFilter, page: { cursor?: string; limit: number }): Promise<Paginated<Alert>>;
  countFailed(): Promise<number>;
}

// Lists never load bodies (database rules).
const NO_BODIES = { sTextBody: 0, sHtmlBody: 0 } as const;

function listFilter(filter: AlertListFilter): Filter<AlertDoc> {
  return {
    ...(filter.monitorId ? { iMonitorId: new ObjectId(filter.monitorId) } : {}),
    ...(filter.type ? { eType: filter.type } : {}),
    ...(filter.status ? { eStatus: filter.status } : {}),
    ...(filter.from || filter.to
      ? {
          dCreatedAt: {
            ...(filter.from ? { $gte: filter.from } : {}),
            ...(filter.to ? { $lte: filter.to } : {}),
          },
        }
      : {}),
  };
}

export function createAlertsRepository(db: Db): AlertsRepository {
  const alerts = db.collection<AlertDoc>(COLLECTIONS.ALERTS);
  const oid = (id: string): ObjectId => new ObjectId(id);

  return {
    async insert(doc) {
      try {
        const { insertedId } = await alerts.insertOne(doc as AlertDoc);
        return { created: true, alert: toAlert({ ...doc, _id: insertedId }) };
      } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err && err.code === 11000) {
          const existing = await alerts.findOne({ sDedupeKey: doc.sDedupeKey }, { projection: NO_BODIES });
          if (existing) return { created: false, alert: toAlert(existing) };
        }
        throw err;
      }
    },

    async findById(id) {
      const doc = await alerts.findOne({ _id: oid(id) }, { projection: NO_BODIES });
      return doc ? toAlert(doc) : null;
    },

    async findByDedupeKey(key) {
      const doc = await alerts.findOne({ sDedupeKey: key }, { projection: NO_BODIES });
      return doc ? toAlert(doc) : null;
    },

    async findAffectedMonitors(id) {
      const doc = await alerts.findOne({ _id: oid(id) }, { projection: { aAffectedMonitors: 1 } });
      return (doc?.aAffectedMonitors ?? []).map((m) => ({
        monitorId: m.iMonitorId.toHexString(),
        name: m.sName,
        monitorType: m.eMonitorType,
      }));
    },

    async claimNext(now, lockedUntil, claimId) {
      const doc = await alerts.findOneAndUpdate(
        {
          eStatus: { $in: ['PENDING', 'RETRYING'] },
          dNextAttemptAt: { $lte: now },
          $or: [{ dLockedUntil: null }, { dLockedUntil: { $lt: now } }],
        },
        { $set: { dLockedUntil: lockedUntil, sClaimId: claimId } },
        { sort: { dNextAttemptAt: 1, _id: 1 }, returnDocument: 'after' },
      );
      return doc ? toAlertToSend(doc) : null;
    },

    async markSent(id, claimId, input) {
      const result = await alerts.updateOne(
        { _id: oid(id), sClaimId: claimId },
        {
          $set: {
            eStatus: 'SENT',
            dSentAt: input.at,
            sMessageId: input.messageId,
            dNextAttemptAt: null,
            dLockedUntil: null,
            sClaimId: null,
            dUpdatedAt: input.at,
          },
          $push: { aAttempts: input.attempt },
        },
      );
      return result.matchedCount === 1;
    },

    async markRetry(id, claimId, input) {
      const result = await alerts.updateOne(
        { _id: oid(id), sClaimId: claimId },
        {
          $set: {
            eStatus: 'RETRYING',
            nRetryIndex: input.retryIndex,
            dNextAttemptAt: input.nextAttemptAt,
            dLockedUntil: null,
            sClaimId: null,
            dUpdatedAt: input.at,
          },
          $push: { aAttempts: input.attempt },
        },
      );
      return result.matchedCount === 1;
    },

    async markFailed(id, claimId, input) {
      const result = await alerts.updateOne(
        { _id: oid(id), sClaimId: claimId },
        {
          $set: {
            eStatus: 'FAILED',
            sFailureReason: input.reason,
            dNextAttemptAt: null,
            dLockedUntil: null,
            sClaimId: null,
            dUpdatedAt: input.at,
          },
          $push: { aAttempts: input.attempt },
        },
      );
      return result.matchedCount === 1;
    },

    async requeueFailed(id, now, recipients) {
      const doc = await alerts.findOneAndUpdate(
        { _id: oid(id), eStatus: 'FAILED' },
        {
          $set: {
            eStatus: 'PENDING',
            nRetryIndex: 0,
            dNextAttemptAt: now,
            dLockedUntil: null,
            dUpdatedAt: now,
            ...(recipients
              ? { aRecipients: recipients.map((r) => ({ sName: r.name, sEmail: r.email, eType: r.type })) }
              : {}),
          },
          $unset: { sFailureReason: '' },
        },
        { returnDocument: 'after', projection: NO_BODIES },
      );
      return doc ? toAlert(doc) : null;
    },

    async addAffectedToPending(id, now, monitor) {
      const doc = await alerts.findOneAndUpdate(
        {
          _id: oid(id),
          eStatus: 'PENDING',
          $or: [{ dLockedUntil: null }, { dLockedUntil: { $lt: now } }],
          'aAffectedMonitors.iMonitorId': { $ne: oid(monitor.monitorId) },
        },
        {
          $push: {
            aAffectedMonitors: {
              iMonitorId: oid(monitor.monitorId),
              sName: monitor.name,
              eMonitorType: monitor.monitorType,
            },
          },
          $set: { dUpdatedAt: now },
        },
        { returnDocument: 'after', projection: { aAffectedMonitors: 1 } },
      );
      if (!doc) return null;
      return (doc.aAffectedMonitors ?? []).map((m) => ({
        monitorId: m.iMonitorId.toHexString(),
        name: m.sName,
        monitorType: m.eMonitorType,
      }));
    },

    async updatePendingContent(id, now, content) {
      const result = await alerts.updateOne(
        {
          _id: oid(id),
          eStatus: 'PENDING',
          $or: [{ dLockedUntil: null }, { dLockedUntil: { $lt: now } }],
          aAffectedMonitors: { $size: content.affectedCount },
        },
        {
          $set: {
            sSubject: content.subject,
            sTextBody: content.textBody,
            sHtmlBody: content.htmlBody,
            dUpdatedAt: now,
          },
        },
      );
      return result.modifiedCount === 1;
    },

    async expedite(id, now) {
      await alerts.updateOne(
        { _id: oid(id), eStatus: 'PENDING', dNextAttemptAt: { $gt: now } },
        { $set: { dNextAttemptAt: now, dUpdatedAt: now } },
      );
    },

    async listForMonitor(monitorId, limit) {
      const docs = await alerts
        .find({ iMonitorId: oid(monitorId) }, { projection: NO_BODIES })
        .sort({ dCreatedAt: -1, _id: -1 })
        .limit(limit)
        .toArray();
      return docs.map(toAlert);
    },

    async list(filter, page) {
      const base = listFilter(filter);
      let query: Filter<AlertDoc> = base;
      if (page.cursor) {
        const cursor = decodeCursor(page.cursor);
        // A date-range filter and the cursor both constrain dCreatedAt: combine them with $and.
        query = {
          $and: [
            base,
            {
              $or: [
                { dCreatedAt: { $lt: cursor.t } },
                { dCreatedAt: cursor.t, _id: { $lt: oid(cursor.id) } },
              ],
            },
          ],
        };
      }
      const docs = await alerts
        .find(query, { projection: NO_BODIES })
        .sort({ dCreatedAt: -1, _id: -1 })
        .limit(page.limit + 1)
        .toArray();
      const last = docs[page.limit - 1];
      return {
        items: docs.slice(0, page.limit).map(toAlert),
        ...(docs.length > page.limit && last
          ? { nextCursor: encodeCursor({ t: last.dCreatedAt, id: last._id.toHexString() }) }
          : {}),
      };
    },

    countFailed: () => alerts.countDocuments({ eStatus: 'FAILED' }),
  };
}
