import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS } from '../../constants/collections.js';
import { toWebhookMonitor, type WebhookMonitorUpdate } from './webhookMonitors.mapper.js';
import type { WebhookMonitor, WebhookMonitorDoc } from './webhookMonitors.types.js';

export interface WebhookMonitorsRepository {
  insert(doc: Omit<WebhookMonitorDoc, '_id'>): Promise<WebhookMonitor>;
  /** Soft-deleted monitors are invisible everywhere (TD-15). */
  findById(id: string): Promise<WebhookMonitor | null>;
  list(): Promise<WebhookMonitor[]>;
  listEnabled(): Promise<WebhookMonitor[]>;
  update(id: string, update: WebhookMonitorUpdate): Promise<WebhookMonitor | null>;
  /** Writes `oState.*` fields only (never configuration). `set` comes from toStateSet(). */
  updateState(id: string, set: Record<string, unknown>): Promise<void>;
  setEnabled(id: string, isEnabled: boolean, at: Date, userId: ObjectId): Promise<WebhookMonitor | null>;
  softDelete(id: string, at: Date, userId: ObjectId): Promise<WebhookMonitor | null>;
}

const ACTIVE = { dDeletedAt: null } as const;

export function createWebhookMonitorsRepository(db: Db): WebhookMonitorsRepository {
  const monitors = db.collection<WebhookMonitorDoc>(COLLECTIONS.WEBHOOK_MONITORS);

  return {
    async insert(doc) {
      const { insertedId } = await monitors.insertOne(doc as WebhookMonitorDoc);
      return toWebhookMonitor({ ...doc, _id: insertedId });
    },
    async findById(id) {
      const doc = await monitors.findOne({ _id: new ObjectId(id), ...ACTIVE });
      return doc ? toWebhookMonitor(doc) : null;
    },
    async list() {
      const docs = await monitors.find(ACTIVE).sort({ sName: 1, _id: 1 }).toArray();
      return docs.map(toWebhookMonitor);
    },
    async listEnabled() {
      const docs = await monitors.find({ bIsEnabled: true, ...ACTIVE }).toArray();
      return docs.map(toWebhookMonitor);
    },
    async update(id, update) {
      const doc = await monitors.findOneAndUpdate(
        { _id: new ObjectId(id), ...ACTIVE },
        { $set: update.$set, ...(update.$unset ? { $unset: update.$unset } : {}) },
        { returnDocument: 'after' },
      );
      return doc ? toWebhookMonitor(doc) : null;
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
      return doc ? toWebhookMonitor(doc) : null;
    },
    async softDelete(id, at, userId) {
      const doc = await monitors.findOneAndUpdate(
        { _id: new ObjectId(id), ...ACTIVE },
        { $set: { dDeletedAt: at, bIsEnabled: false, iUpdatedBy: userId, dUpdatedAt: at } },
        { returnDocument: 'after' },
      );
      return doc ? toWebhookMonitor(doc) : null;
    },
  };
}
