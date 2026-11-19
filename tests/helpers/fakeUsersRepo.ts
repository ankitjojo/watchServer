import { ObjectId } from 'mongodb';
import { toUser, toUserCredentials } from '../../src/modules/users/users.mapper.js';
import type { UsersRepository } from '../../src/modules/users/users.repository.js';
import type { UserDoc } from '../../src/modules/users/users.types.js';

/** In-memory repository for service unit tests. Mirrors the unique-email index. */
export function createFakeUsersRepo(): UsersRepository & { docs: UserDoc[] } {
  const docs: UserDoc[] = [];
  const find = (id: string): UserDoc | undefined => docs.find((d) => d._id.toHexString() === id);

  return {
    docs,
    insert(doc) {
      if (docs.some((d) => d.sEmail === doc.sEmail)) {
        return Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
      }
      const stored = { ...doc, _id: new ObjectId() };
      docs.push(stored);
      return Promise.resolve(toUser(stored));
    },
    findById: (id) => Promise.resolve(find(id) ? toUser(find(id) as UserDoc) : null),
    findCredentialsByEmail(email) {
      const doc = docs.find((d) => d.sEmail === email);
      return Promise.resolve(doc ? toUserCredentials(doc) : null);
    },
    list: () => Promise.resolve(docs.map(toUser)),
    countAll: () => Promise.resolve(docs.length),
    countActiveAdmins: () => Promise.resolve(docs.filter((d) => d.eRole === 'ADMIN' && d.bIsActive).length),
    update(id, set) {
      const doc = find(id);
      if (!doc) return Promise.resolve(null);
      if (set.sEmail && docs.some((d) => d !== doc && d.sEmail === set.sEmail)) {
        return Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
      }
      Object.assign(doc, set);
      return Promise.resolve(toUser(doc));
    },
    delete(id) {
      const index = docs.findIndex((d) => d._id.toHexString() === id);
      if (index === -1) return Promise.resolve(false);
      docs.splice(index, 1);
      return Promise.resolve(true);
    },
    touchLastLogin(id, at) {
      const doc = find(id);
      if (doc) doc.dLastLoginAt = at;
      return Promise.resolve();
    },
  };
}
