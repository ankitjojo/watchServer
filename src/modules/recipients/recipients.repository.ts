import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS } from '../../constants/collections.js';
import { toRecipient } from './recipients.mapper.js';
import type { Recipient, RecipientAudience, RecipientDoc } from './recipients.types.js';

export interface RecipientsRepository {
  insert(doc: Omit<RecipientDoc, '_id'>): Promise<Recipient>;
  /** Deleted recipients are invisible to every method except the explicitly named ones below (TD-36). */
  findById(id: string): Promise<Recipient | null>;
  findByIdIncludingDeleted(id: string): Promise<Recipient | null>;
  /** An active recipient wins over a deleted one with the same email. Used by the master seed and restore. */
  findByEmail(email: string): Promise<Recipient | null>;
  /** Masters first, then by name. */
  list(): Promise<Recipient[]>;
  /** Newest deletion first. */
  listDeleted(): Promise<Recipient[]>;
  /** FR-A5: active normal recipients plus every master. Masters only for MONITOR_ERROR. */
  findAudience(audience: RecipientAudience): Promise<Recipient[]>;
  countMasters(): Promise<number>;
  update(id: string, set: Partial<RecipientDoc>): Promise<Recipient | null>;
  /** Marks deleted and inactive; the document is kept. Null when it does not exist or is already deleted. */
  softDelete(id: string, at: Date, deletedBy: ObjectId): Promise<Recipient | null>;
  /** Clears the deleted markers (plus `set`). A duplicate-key error means an active recipient has the email. */
  restore(id: string, at: Date, set?: Partial<RecipientDoc>): Promise<Recipient | null>;
}

// Old documents have no bIsDeleted field: "not true" keeps them visible.
const NOT_DELETED = { bIsDeleted: { $ne: true } } as const;

export function createRecipientsRepository(db: Db): RecipientsRepository {
  const recipients = db.collection<RecipientDoc>(COLLECTIONS.RECIPIENTS);

  return {
    async insert(doc) {
      const { insertedId } = await recipients.insertOne(doc as RecipientDoc);
      return toRecipient({ ...doc, _id: insertedId });
    },
    async findById(id) {
      const doc = await recipients.findOne({ _id: new ObjectId(id), ...NOT_DELETED });
      return doc ? toRecipient(doc) : null;
    },
    async findByIdIncludingDeleted(id) {
      const doc = await recipients.findOne({ _id: new ObjectId(id) });
      return doc ? toRecipient(doc) : null;
    },
    async findByEmail(email) {
      // bIsDeleted ascending: missing/false (active) sorts before true (deleted).
      const doc = await recipients.findOne({ sEmail: email }, { sort: { bIsDeleted: 1 } });
      return doc ? toRecipient(doc) : null;
    },
    async list() {
      // 'NORMAL' sorts after 'MASTER' ascending, so masters come first.
      const docs = await recipients.find(NOT_DELETED).sort({ eType: 1, sName: 1, _id: 1 }).toArray();
      return docs.map(toRecipient);
    },
    async listDeleted() {
      const docs = await recipients.find({ bIsDeleted: true }).sort({ dDeletedAt: -1, _id: 1 }).toArray();
      return docs.map(toRecipient);
    },
    async findAudience(audience) {
      const filter =
        audience === 'MASTERS_ONLY'
          ? { eType: 'MASTER' as const, ...NOT_DELETED }
          : { $or: [{ eType: 'MASTER' as const }, { bIsActive: true }], ...NOT_DELETED };
      const docs = await recipients.find(filter).sort({ eType: 1, sEmail: 1 }).toArray();
      return docs.map(toRecipient);
    },
    countMasters: () => recipients.countDocuments({ eType: 'MASTER', ...NOT_DELETED }),
    async update(id, set) {
      const doc = await recipients.findOneAndUpdate(
        { _id: new ObjectId(id), ...NOT_DELETED },
        { $set: set },
        { returnDocument: 'after' },
      );
      return doc ? toRecipient(doc) : null;
    },
    async softDelete(id, at, deletedBy) {
      const doc = await recipients.findOneAndUpdate(
        { _id: new ObjectId(id), ...NOT_DELETED },
        {
          $set: { bIsDeleted: true, dDeletedAt: at, iDeletedBy: deletedBy, bIsActive: false, dUpdatedAt: at },
        },
        { returnDocument: 'after' },
      );
      return doc ? toRecipient(doc) : null;
    },
    async restore(id, at, set = {}) {
      const doc = await recipients.findOneAndUpdate(
        { _id: new ObjectId(id), bIsDeleted: true },
        { $set: { ...set, bIsDeleted: false, dDeletedAt: null, iDeletedBy: null, dUpdatedAt: at } },
        { returnDocument: 'after' },
      );
      return doc ? toRecipient(doc) : null;
    },
  };
}
