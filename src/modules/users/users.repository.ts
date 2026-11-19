import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS } from '../../constants/collections.js';
import { toUser, toUserCredentials } from './users.mapper.js';
import type { User, UserCredentials, UserDoc } from './users.types.js';

export interface UsersRepository {
  insert(doc: Omit<UserDoc, '_id'>): Promise<User>;
  findById(id: string): Promise<User | null>;
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
  list(): Promise<User[]>;
  countAll(): Promise<number>;
  countActiveAdmins(): Promise<number>;
  update(id: string, set: Partial<UserDoc>): Promise<User | null>;
  delete(id: string): Promise<boolean>;
  touchLastLogin(id: string, at: Date): Promise<void>;
}

export function createUsersRepository(db: Db): UsersRepository {
  const users = db.collection<UserDoc>(COLLECTIONS.USERS);

  return {
    async insert(doc) {
      const { insertedId } = await users.insertOne(doc as UserDoc);
      return toUser({ ...doc, _id: insertedId });
    },
    async findById(id) {
      const doc = await users.findOne({ _id: new ObjectId(id) });
      return doc ? toUser(doc) : null;
    },
    async findCredentialsByEmail(email) {
      const doc = await users.findOne({ sEmail: email });
      return doc ? toUserCredentials(doc) : null;
    },
    async list() {
      const docs = await users.find({}).sort({ sName: 1, _id: 1 }).toArray();
      return docs.map(toUser);
    },
    countAll: () => users.countDocuments({}),
    countActiveAdmins: () => users.countDocuments({ eRole: 'ADMIN', bIsActive: true }),
    async update(id, set) {
      const doc = await users.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: set },
        { returnDocument: 'after' },
      );
      return doc ? toUser(doc) : null;
    },
    async delete(id) {
      const result = await users.deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    },
    async touchLastLogin(id, at) {
      await users.updateOne({ _id: new ObjectId(id) }, { $set: { dLastLoginAt: at } });
    },
  };
}
