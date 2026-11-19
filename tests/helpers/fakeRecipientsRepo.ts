import { ObjectId } from 'mongodb';
import { toRecipient } from '../../src/modules/recipients/recipients.mapper.js';
import type { RecipientsRepository } from '../../src/modules/recipients/recipients.repository.js';
import type { RecipientDoc } from '../../src/modules/recipients/recipients.types.js';

/** In-memory repository for service unit tests. Mirrors the unique-email index. */
export function createFakeRecipientsRepo(): RecipientsRepository & { docs: RecipientDoc[] } {
  const docs: RecipientDoc[] = [];
  const find = (id: string): RecipientDoc | undefined => docs.find((d) => d._id.toHexString() === id);
  const dup = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

  return {
    docs,
    insert(doc) {
      if (docs.some((d) => d.sEmail === doc.sEmail)) return dup();
      const stored = { ...doc, _id: new ObjectId() };
      docs.push(stored);
      return Promise.resolve(toRecipient(stored));
    },
    findById(id) {
      const doc = find(id);
      return Promise.resolve(doc ? toRecipient(doc) : null);
    },
    findByEmail(email) {
      const doc = docs.find((d) => d.sEmail === email);
      return Promise.resolve(doc ? toRecipient(doc) : null);
    },
    list: () => Promise.resolve(docs.map(toRecipient)),
    findAudience(audience) {
      const matching = docs.filter((d) =>
        audience === 'MASTERS_ONLY' ? d.eType === 'MASTER' : d.eType === 'MASTER' || d.bIsActive,
      );
      return Promise.resolve(matching.map(toRecipient));
    },
    countMasters: () => Promise.resolve(docs.filter((d) => d.eType === 'MASTER').length),
    update(id, set) {
      const doc = find(id);
      if (!doc) return Promise.resolve(null);
      if (set.sEmail && docs.some((d) => d !== doc && d.sEmail === set.sEmail)) return dup();
      Object.assign(doc, set);
      return Promise.resolve(toRecipient(doc));
    },
    delete(id) {
      const index = docs.findIndex((d) => d._id.toHexString() === id);
      if (index === -1) return Promise.resolve(false);
      docs.splice(index, 1);
      return Promise.resolve(true);
    },
  };
}
