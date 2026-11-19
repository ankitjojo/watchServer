import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS } from '../../constants/collections.js';
import { toRecipient } from './recipients.mapper.js';
import type { Recipient, RecipientAudience, RecipientDoc } from './recipients.types.js';

export interface RecipientsRepository {
  insert(doc: Omit<RecipientDoc, '_id'>): Promise<Recipient>;
  findById(id: string): Promise<Recipient | null>;
  findByEmail(email: string): Promise<Recipient | null>;
  /** Masters first, then by name. */
  list(): Promise<Recipient[]>;
  /** FR-A5: active normal recipients plus every master. Masters only for MONITOR_ERROR. */
  findAudience(audience: RecipientAudience): Promise<Recipient[]>;
  countMasters(): Promise<number>;
  update(id: string, set: Partial<RecipientDoc>): Promise<Recipient | null>;
  delete(id: string): Promise<boolean>;
}

export function createRecipientsRepository(db: Db): RecipientsRepository {
  const recipients = db.collection<RecipientDoc>(COLLECTIONS.RECIPIENTS);

  return {
    async insert(doc) {
      const { insertedId } = await recipients.insertOne(doc as RecipientDoc);
      return toRecipient({ ...doc, _id: insertedId });
    },
    async findById(id) {
      const doc = await recipients.findOne({ _id: new ObjectId(id) });
      return doc ? toRecipient(doc) : null;
    },
    async findByEmail(email) {
      const doc = await recipients.findOne({ sEmail: email });
      return doc ? toRecipient(doc) : null;
    },
    async list() {
      // 'NORMAL' sorts after 'MASTER' ascending, so masters come first.
      const docs = await recipients.find({}).sort({ eType: 1, sName: 1, _id: 1 }).toArray();
      return docs.map(toRecipient);
    },
    async findAudience(audience) {
      const filter =
        audience === 'MASTERS_ONLY'
          ? { eType: 'MASTER' as const }
          : { $or: [{ eType: 'MASTER' as const }, { bIsActive: true }] };
      const docs = await recipients.find(filter).sort({ eType: 1, sEmail: 1 }).toArray();
      return docs.map(toRecipient);
    },
    countMasters: () => recipients.countDocuments({ eType: 'MASTER' }),
    async update(id, set) {
      const doc = await recipients.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: set },
        { returnDocument: 'after' },
      );
      return doc ? toRecipient(doc) : null;
    },
    async delete(id) {
      const result = await recipients.deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    },
  };
}
