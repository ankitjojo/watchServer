import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS } from '../../constants/collections.js';
import { toEndpointMonitor, type EndpointMonitorUpdate } from './endpointMonitors.mapper.js';
import type { EndpointMonitor, EndpointMonitorDoc } from './endpointMonitors.types.js';

export interface EndpointMonitorsRepository {
  insert(doc: Omit<EndpointMonitorDoc, '_id'>): Promise<EndpointMonitor>;
  /** Soft-deleted monitors are invisible everywhere (TD-15). */
  findById(id: string): Promise<EndpointMonitor | null>;
  /** Deleted monitors are readable only through these two explicit calls (soft delete). */
  findByIdIncludingDeleted(id: string): Promise<EndpointMonitor | null>;
  listDeleted(): Promise<EndpointMonitor[]>;
  list(): Promise<EndpointMonitor[]>;
  listEnabled(): Promise<EndpointMonitor[]>;
  update(id: string, update: EndpointMonitorUpdate): Promise<EndpointMonitor | null>;
  /** Writes `oState.*` fields only (never configuration). `set` comes from toStateSet(). */
  updateState(id: string, set: Record<string, unknown>): Promise<void>;
  setEnabled(id: string, isEnabled: boolean, at: Date, userId: ObjectId): Promise<EndpointMonitor | null>;
  softDelete(id: string, at: Date, userId: ObjectId): Promise<EndpointMonitor | null>;
}

const ACTIVE = { dDeletedAt: null } as const;

export function createEndpointMonitorsRepository(db: Db): EndpointMonitorsRepository {
  const monitors = db.collection<EndpointMonitorDoc>(COLLECTIONS.ENDPOINT_MONITORS);

  return {
    async insert(doc) {
      const { insertedId } = await monitors.insertOne(doc as EndpointMonitorDoc);
      return toEndpointMonitor({ ...doc, _id: insertedId });
    },
    async findById(id) {
      const doc = await monitors.findOne({ _id: new ObjectId(id), ...ACTIVE });
      return doc ? toEndpointMonitor(doc) : null;
    },
    async findByIdIncludingDeleted(id) {
      const doc = await monitors.findOne({ _id: new ObjectId(id) });
      return doc ? toEndpointMonitor(doc) : null;
    },
    async listDeleted() {
      const docs = await monitors
        .find({ dDeletedAt: { $type: 'date' } })
        .sort({ dDeletedAt: -1, _id: 1 })
        .toArray();
      return docs.map(toEndpointMonitor);
    },
    async list() {
      const docs = await monitors.find(ACTIVE).sort({ sServerName: 1, _id: 1 }).toArray();
      return docs.map(toEndpointMonitor);
    },
    async listEnabled() {
      const docs = await monitors.find({ bIsEnabled: true, ...ACTIVE }).toArray();
      return docs.map(toEndpointMonitor);
    },
    async update(id, update) {
      const doc = await monitors.findOneAndUpdate(
        { _id: new ObjectId(id), ...ACTIVE },
        { $set: update.$set, ...(update.$unset ? { $unset: update.$unset } : {}) },
        { returnDocument: 'after' },
      );
      return doc ? toEndpointMonitor(doc) : null;
    },
    async updateState(id, set) {
      await monitors.updateOne({ _id: new ObjectId(id), ...ACTIVE }, { $set: set });
    },
    async setEnabled(id, isEnabled, at, userId) {
      const doc = await monitors.findOneAndUpdate(
        { _id: new ObjectId(id), ...ACTIVE },
        { $set: { bIsEnabled: isEnabled, iUpdatedBy: userId, dUpdatedAt: at } },
        { returnDocument: 'after' },
      );
      return doc ? toEndpointMonitor(doc) : null;
    },
    async softDelete(id, at, userId) {
      const doc = await monitors.findOneAndUpdate(
        { _id: new ObjectId(id), ...ACTIVE },
        {
          $set: { dDeletedAt: at, iDeletedBy: userId, bIsEnabled: false, iUpdatedBy: userId, dUpdatedAt: at },
        },
        { returnDocument: 'after' },
      );
      return doc ? toEndpointMonitor(doc) : null;
    },
  };
}
