import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS } from '../../constants/collections.js';
import type { IncidentCloseReason } from '../../constants/incidentCloseReason.js';
import { toIncident } from './incidents.mapper.js';
import type { Incident, IncidentDoc } from './incidents.types.js';

export interface IncidentsRepository {
  insert(doc: Omit<IncidentDoc, '_id'>): Promise<Incident>;
  findOpenForMonitor(monitorId: string): Promise<Incident | null>;
  findOpenSourceError(): Promise<Incident | null>;
  findById(id: string): Promise<Incident | null>;
  /** Sets the last-alert time (and the reminder counter when given). */
  markAlerted(id: string, at: Date, reminderCount?: number): Promise<void>;
  /** Conditional on the incident still being open; returns null if it was already closed. */
  close(id: string, at: Date, reason: IncidentCloseReason): Promise<Incident | null>;
  addAffectedMonitor(id: string, monitorId: string, at: Date): Promise<Incident | null>;
  listForMonitor(monitorId: string, limit: number): Promise<Incident[]>;
  countOpen(): Promise<number>;
}

export function createIncidentsRepository(db: Db): IncidentsRepository {
  const incidents = db.collection<IncidentDoc>(COLLECTIONS.INCIDENTS);
  const open = { dClosedAt: null } as const;

  return {
    async insert(doc) {
      const { insertedId } = await incidents.insertOne(doc as IncidentDoc);
      return toIncident({ ...doc, _id: insertedId });
    },
    async findOpenForMonitor(monitorId) {
      const doc = await incidents.findOne({ iMonitorId: new ObjectId(monitorId), eKind: 'MONITOR', ...open });
      return doc ? toIncident(doc) : null;
    },
    async findOpenSourceError() {
      const doc = await incidents.findOne({ eKind: 'SOURCE_ERROR', ...open });
      return doc ? toIncident(doc) : null;
    },
    async findById(id) {
      const doc = await incidents.findOne({ _id: new ObjectId(id) });
      return doc ? toIncident(doc) : null;
    },
    async markAlerted(id, at, reminderCount) {
      await incidents.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            dLastAlertAt: at,
            dUpdatedAt: at,
            ...(reminderCount === undefined ? {} : { nReminderCount: reminderCount }),
          },
        },
      );
    },
    async close(id, at, reason) {
      const doc = await incidents.findOneAndUpdate(
        { _id: new ObjectId(id), ...open },
        { $set: { dClosedAt: at, eCloseReason: reason, dUpdatedAt: at } },
        { returnDocument: 'after' },
      );
      return doc ? toIncident(doc) : null;
    },
    async addAffectedMonitor(id, monitorId, at) {
      const doc = await incidents.findOneAndUpdate(
        { _id: new ObjectId(id), ...open },
        { $addToSet: { aAffectedMonitorIds: new ObjectId(monitorId) }, $set: { dUpdatedAt: at } },
        { returnDocument: 'after' },
      );
      return doc ? toIncident(doc) : null;
    },
    async listForMonitor(monitorId, limit) {
      const docs = await incidents
        .find({ iMonitorId: new ObjectId(monitorId), eKind: 'MONITOR' })
        .sort({ dOpenedAt: -1, _id: -1 })
        .limit(limit)
        .toArray();
      return docs.map(toIncident);
    },
    async countOpen() {
      return incidents.countDocuments(open);
    },
  };
}
