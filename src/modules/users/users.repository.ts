import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS } from '../../constants/collections.js';
import { toUser, toUserCredentials } from './users.mapper.js';
import type { User, UserCredentials, UserDoc } from './users.types.js';

export interface UsersRepository {
  insert(doc: Omit<UserDoc, '_id'>): Promise<User>;
  /** Deleted users are invisible to every method except the explicitly named ones below (TD-36). */
  findById(id: string): Promise<User | null>;
  findByIdIncludingDeleted(id: string): Promise<User | null>;
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
  list(): Promise<User[]>;
  /** Newest deletion first. */
  listDeleted(): Promise<User[]>;
  /** Counts deleted users too: "no users exist yet" means never created, so the seed never re-runs. */
  countAll(): Promise<number>;
  countActiveAdmins(): Promise<number>;
  update(id: string, set: Partial<UserDoc>): Promise<User | null>;
  /** Marks deleted and inactive; the document is kept. Null when it does not exist or is already deleted. */
  softDelete(id: string, at: Date, deletedBy: ObjectId): Promise<User | null>;
  /** Clears the deleted markers. A duplicate-key error means an active user has the email. */
  restore(id: string, at: Date): Promise<User | null>;
  touchLastLogin(id: string, at: Date): Promise<void>;
}

// Old documents have no bIsDeleted field: "not true" keeps them visible.
const NOT_DELETED = { bIsDeleted: { $ne: true } } as const;

export function createUsersRepository(db: Db): UsersRepository {
  const users = db.collection<UserDoc>(COLLECTIONS.USERS);

  return {
    async insert(doc) {
      const { insertedId } = await users.insertOne(doc as UserDoc);
      return toUser({ ...doc, _id: insertedId });
    },
    async findById(id) {
      const doc = await users.findOne({ _id: new ObjectId(id), ...NOT_DELETED });
      return doc ? toUser(doc) : null;
    },
    async findByIdIncludingDeleted(id) {
      const doc = await users.findOne({ _id: new ObjectId(id) });
      return doc ? toUser(doc) : null;
    },
    async findCredentialsByEmail(email) {
      const doc = await users.findOne({ sEmail: email, ...NOT_DELETED });
      return doc ? toUserCredentials(doc) : null;
    },
    async list() {
      const docs = await users.find(NOT_DELETED).sort({ sName: 1, _id: 1 }).toArray();
      return docs.map(toUser);
    },
    async listDeleted() {
      const docs = await users.find({ bIsDeleted: true }).sort({ dDeletedAt: -1, _id: 1 }).toArray();
      return docs.map(toUser);
    },
    countAll: () => users.countDocuments({}),
    countActiveAdmins: () => users.countDocuments({ eRole: 'ADMIN', bIsActive: true, ...NOT_DELETED }),
    async update(id, set) {
      const doc = await users.findOneAndUpdate(
        { _id: new ObjectId(id), ...NOT_DELETED },
        { $set: set },
        { returnDocument: 'after' },
      );
      return doc ? toUser(doc) : null;
    },
    async softDelete(id, at, deletedBy) {
      const doc = await users.findOneAndUpdate(
        { _id: new ObjectId(id), ...NOT_DELETED },
        {
          $set: { bIsDeleted: true, dDeletedAt: at, iDeletedBy: deletedBy, bIsActive: false, dUpdatedAt: at },
        },
        { returnDocument: 'after' },
      );
      return doc ? toUser(doc) : null;
    },
    async restore(id, at) {
      const doc = await users.findOneAndUpdate(
        { _id: new ObjectId(id), bIsDeleted: true },
        { $set: { bIsDeleted: false, dDeletedAt: null, iDeletedBy: null, dUpdatedAt: at } },
        { returnDocument: 'after' },
      );
      return doc ? toUser(doc) : null;
    },
    async touchLastLogin(id, at) {
      await users.updateOne({ _id: new ObjectId(id), ...NOT_DELETED }, { $set: { dLastLoginAt: at } });
    },
  };
}
