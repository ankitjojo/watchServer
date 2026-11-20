import { ObjectId } from 'mongodb';
import { toUser, toUserCredentials } from '../../src/modules/users/users.mapper.js';
import type { UsersRepository } from '../../src/modules/users/users.repository.js';
import type { UserDoc } from '../../src/modules/users/users.types.js';

/** In-memory repository for service unit tests. Mirrors the partial unique email index (non-deleted only). */
export function createFakeUsersRepo(): UsersRepository & { docs: UserDoc[] } {
  const docs: UserDoc[] = [];
  const live = (): UserDoc[] => docs.filter((d) => !d.bIsDeleted);
  const find = (id: string): UserDoc | undefined => docs.find((d) => d._id.toHexString() === id);
  const dup = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
  const emailTaken = (email: string, except?: UserDoc): boolean =>
    live().some((d) => d !== except && d.sEmail === email);

  return {
    docs,
    insert(doc) {
      if (!doc.bIsDeleted && emailTaken(doc.sEmail)) return dup();
      const stored = { ...doc, _id: new ObjectId() };
      docs.push(stored);
      return Promise.resolve(toUser(stored));
    },
    findById(id) {
      const doc = find(id);
      return Promise.resolve(doc && !doc.bIsDeleted ? toUser(doc) : null);
    },
    findByIdIncludingDeleted(id) {
      const doc = find(id);
      return Promise.resolve(doc ? toUser(doc) : null);
    },
    findCredentialsByEmail(email) {
      const doc = live().find((d) => d.sEmail === email);
      return Promise.resolve(doc ? toUserCredentials(doc) : null);
    },
    list: () => Promise.resolve(live().map(toUser)),
    listDeleted: () => Promise.resolve(docs.filter((d) => d.bIsDeleted).map(toUser)),
    countAll: () => Promise.resolve(docs.length),
    countActiveAdmins: () => Promise.resolve(live().filter((d) => d.eRole === 'ADMIN' && d.bIsActive).length),
    update(id, set) {
      const doc = find(id);
      if (!doc || doc.bIsDeleted) return Promise.resolve(null);
      if (set.sEmail && emailTaken(set.sEmail, doc)) return dup();
      Object.assign(doc, set);
      return Promise.resolve(toUser(doc));
    },
    softDelete(id, at, deletedBy) {
      const doc = find(id);
      if (!doc || doc.bIsDeleted) return Promise.resolve(null);
      Object.assign(doc, { bIsDeleted: true, dDeletedAt: at, iDeletedBy: deletedBy, bIsActive: false });
      return Promise.resolve(toUser(doc));
    },
    restore(id, at) {
      const doc = find(id);
      if (!doc?.bIsDeleted) return Promise.resolve(null);
      if (emailTaken(doc.sEmail)) return dup();
      Object.assign(doc, { bIsDeleted: false, dDeletedAt: null, iDeletedBy: null, dUpdatedAt: at });
      return Promise.resolve(toUser(doc));
    },
    touchLastLogin(id, at) {
      const doc = find(id);
      if (doc) doc.dLastLoginAt = at;
      return Promise.resolve();
    },
  };
}
