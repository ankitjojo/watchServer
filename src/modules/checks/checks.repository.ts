import { ObjectId, type Db, type Filter } from 'mongodb';
import { COLLECTIONS } from '../../constants/collections.js';
import type { Paginated } from '../../types/paginated.js';
import { decodeCursor, encodeCursor } from '../../utils/cursor.js';
import { toCheck } from './checks.mapper.js';
import type { Check, CheckDoc, CheckListFilter, SeriesPoint } from './checks.types.js';

export interface ChecksRepository {
  insert(doc: Omit<CheckDoc, '_id'>): Promise<Check>;
  /** Keyset pagination on (dStartedAt desc, _id desc). Stable while new checks arrive. */
  listForMonitor(
    filter: CheckListFilter,
    page: { cursor?: string; limit: number },
  ): Promise<Paginated<Check>>;
  /** At most `maxPoints` points: raw when few, bucketed on the server otherwise (database-design B.3). */
  series(input: {
    monitorId: string;
    monitorType: 'WEBHOOK' | 'ENDPOINT';
    from: Date;
    to: Date;
    maxPoints: number;
  }): Promise<SeriesPoint[]>;
}

function rangeFilter(filter: CheckListFilter): Filter<CheckDoc> {
  return {
    iMonitorId: new ObjectId(filter.monitorId),
    ...(filter.from || filter.to
      ? {
          dStartedAt: {
            ...(filter.from ? { $gte: filter.from } : {}),
            ...(filter.to ? { $lte: filter.to } : {}),
          },
        }
      : {}),
    ...(filter.result ? { eResult: filter.result } : {}),
  };
}

export function createChecksRepository(db: Db): ChecksRepository {
  const checks = db.collection<CheckDoc>(COLLECTIONS.CHECKS);

  return {
    async insert(doc) {
      const { insertedId } = await checks.insertOne(doc as CheckDoc);
      return toCheck({ ...doc, _id: insertedId });
    },

    async listForMonitor(filter, page) {
      const base = rangeFilter(filter);
      const query: Filter<CheckDoc> = { ...base };
      if (page.cursor) {
        const cursor = decodeCursor(page.cursor);
        query.$or = [
          { dStartedAt: { $lt: cursor.t } },
          { dStartedAt: cursor.t, _id: { $lt: new ObjectId(cursor.id) } },
        ];
        // $or on dStartedAt must not clash with the range filter: combine both with $and.
        if (base.dStartedAt) {
          delete query.dStartedAt;
          query.$and = [{ dStartedAt: base.dStartedAt }, { $or: query.$or }];
          delete query.$or;
        }
      }
      const docs = await checks
        .find(query)
        .sort({ dStartedAt: -1, _id: -1 })
        .limit(page.limit + 1)
        .toArray();
      const items = docs.slice(0, page.limit).map(toCheck);
      const last = docs[page.limit - 1];
      const hasMore = docs.length > page.limit;
      return {
        items,
        ...(hasMore && last
          ? { nextCursor: encodeCursor({ t: last.dStartedAt, id: last._id.toHexString() }) }
          : {}),
      };
    },

    async series({ monitorId, monitorType, from, to, maxPoints }) {
      const match = { iMonitorId: new ObjectId(monitorId), dStartedAt: { $gte: from, $lte: to } };
      const total = await checks.countDocuments(match);
      const valueExpr =
        monitorType === 'WEBHOOK'
          ? '$oWebhook.nAgeMs'
          : {
              $getField: { field: 'nResponseTimeMs', input: { $arrayElemAt: ['$oEndpoint.aAttempts', -1] } },
            };

      if (total <= maxPoints) {
        const docs = await checks
          .aggregate<{ t: Date; value: number | null; result: string }>([
            { $match: match },
            { $sort: { dStartedAt: 1 } },
            {
              $project: {
                _id: 0,
                t: '$dStartedAt',
                value: { $ifNull: [valueExpr, null] },
                result: '$eResult',
              },
            },
          ])
          .toArray();
        return docs.map((d) => ({
          t: d.t,
          value: d.value,
          ...(monitorType === 'ENDPOINT' ? { isUp: d.result === 'OK' } : {}),
        }));
      }

      // Too many points for a chart: group into equal time buckets (peak value; "down" if any check failed).
      const bucketMs = Math.ceil((to.getTime() - from.getTime() + 1) / maxPoints);
      const docs = await checks
        .aggregate<{ t: Date; value: number | null; allUp: boolean }>([
          { $match: match },
          {
            $group: {
              _id: { $floor: { $divide: [{ $subtract: ['$dStartedAt', from] }, bucketMs] } },
              value: { $max: valueExpr },
              allUp: { $min: { $cond: [{ $eq: ['$eResult', 'OK'] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
          {
            $project: {
              _id: 0,
              t: { $add: [from, { $multiply: ['$_id', bucketMs] }] },
              value: { $ifNull: ['$value', null] },
              allUp: { $eq: ['$allUp', 1] },
            },
          },
        ])
        .toArray();
      return docs.map((d) => ({
        t: d.t,
        value: d.value,
        ...(monitorType === 'ENDPOINT' ? { isUp: d.allUp } : {}),
      }));
    },
  };
}
