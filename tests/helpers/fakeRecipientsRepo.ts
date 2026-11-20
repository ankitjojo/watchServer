import { ObjectId } from 'mongodb';
import { toRecipient } from '../../src/modules/recipients/recipients.mapper.js';
import type { RecipientsRepository } from '../../src/modules/recipients/recipients.repository.js';
import type { RecipientDoc } from '../../src/modules/recipients/recipients.types.js';

/** In-memory repository for service unit tests. Mirrors the partial unique email index (non-deleted only). */
export function createFakeRecipientsRepo(): RecipientsRepository & { docs: RecipientDoc[] } {
  const docs: RecipientDoc[] = [];
  const live = (): RecipientDoc[] => docs.filter((d) => !d.bIsDeleted);
  const find = (id: string): RecipientDoc | undefined => docs.find((d) => d._id.toHexString() === id);
  const dup = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
  const emailTaken = (email: string, except?: RecipientDoc): boolean =>
    live().some((d) => d !== except && d.sEmail === email);

  return {
    docs,
    insert(doc) {
      if (!doc.bIsDeleted && emailTaken(doc.sEmail)) return dup();
      const stored = { ...doc, _id: new ObjectId() };
      docs.push(stored);
      return Promise.resolve(toRecipient(stored));
    },
    findById(id) {
      const doc = find(id);
      return Promise.resolve(doc && !doc.bIsDeleted ? toRecipient(doc) : null);
    },
    findByIdIncludingDeleted(id) {
      const doc = find(id);
      return Promise.resolve(doc ? toRecipient(doc) : null);
    },
    findByEmail(email) {
      const doc = live().find((d) => d.sEmail === email) ?? docs.find((d) => d.sEmail === email);
      return Promise.resolve(doc ? toRecipient(doc) : null);
    },
    list: () => Promise.resolve(live().map(toRecipient)),
    listDeleted: () => Promise.resolve(docs.filter((d) => d.bIsDeleted).map(toRecipient)),
    findAudience(audience) {
      const matching = live().filter((d) =>
        audience === 'MASTERS_ONLY' ? d.eType === 'MASTER' : d.eType === 'MASTER' || d.bIsActive,
      );
      return Promise.resolve(matching.map(toRecipient));
    },
    countMasters: () => Promise.resolve(live().filter((d) => d.eType === 'MASTER').length),
    update(id, set) {
      const doc = find(id);
      if (!doc || doc.bIsDeleted) return Promise.resolve(null);
      if (set.sEmail && emailTaken(set.sEmail, doc)) return dup();
      Object.assign(doc, set);
      return Promise.resolve(toRecipient(doc));
    },
    softDelete(id, at, deletedBy) {
      const doc = find(id);
      if (!doc || doc.bIsDeleted) return Promise.resolve(null);
      Object.assign(doc, { bIsDeleted: true, dDeletedAt: at, iDeletedBy: deletedBy, bIsActive: false });
      return Promise.resolve(toRecipient(doc));
    },
    restore(id, at, set = {}) {
      const doc = find(id);
      if (!doc?.bIsDeleted) return Promise.resolve(null);
      if (emailTaken(doc.sEmail)) return dup();
      Object.assign(doc, set, { bIsDeleted: false, dDeletedAt: null, iDeletedBy: null, dUpdatedAt: at });
      return Promise.resolve(toRecipient(doc));
    },
  };
}
