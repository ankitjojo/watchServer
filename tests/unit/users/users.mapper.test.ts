import { ObjectId } from 'mongodb';
import {
  toUser,
  toUserCredentials,
  toUserDoc,
  toUserUpdate,
} from '../../../src/modules/users/users.mapper.js';

const now = new Date('2026-11-18T10:00:00Z');
const input = {
  name: 'Ann',
  email: 'ann@x.test',
  role: 'ADMIN' as const,
  password: 'ignored',
  isActive: true,
};

describe('users.mapper (TD-16)', () => {
  it('maps input -> doc -> domain without losing a field', () => {
    const doc = { ...toUserDoc(input, { now, passwordHash: 'HASH' }), _id: new ObjectId() };
    expect(doc).toMatchObject({
      sName: 'Ann',
      sEmail: 'ann@x.test',
      eRole: 'ADMIN',
      bIsActive: true,
      dLastLoginAt: null,
      dCreatedAt: now,
      dUpdatedAt: now,
      sPasswordHash: 'HASH',
    });
    expect(toUser(doc)).toEqual({
      id: doc._id.toHexString(),
      name: 'Ann',
      email: 'ann@x.test',
      role: 'ADMIN',
      isActive: true,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  });

  it('keeps the hash out of the domain user but available to authentication', () => {
    const doc = { ...toUserDoc(input, { now, passwordHash: 'HASH' }), _id: new ObjectId() };
    expect(JSON.stringify(toUser(doc))).not.toContain('HASH');
    expect(toUserCredentials(doc).passwordHash).toBe('HASH');
  });

  it('maps an old document that lacks dLastLoginAt', () => {
    const full = {
      ...toUserDoc(input, { now, passwordHash: 'H' }),
      _id: new ObjectId(),
    };
    const rest: Partial<typeof full> = { ...full };
    delete rest.dLastLoginAt;
    expect(toUser(rest as never).lastLoginAt).toBeNull();
  });

  it('only sets the hash in an update when the password changes', () => {
    const update = { name: 'Ann', email: 'ann@x.test', role: 'VIEWER' as const, isActive: false };
    expect(toUserUpdate(update, { now })).toEqual({
      sName: 'Ann',
      sEmail: 'ann@x.test',
      eRole: 'VIEWER',
      bIsActive: false,
      dUpdatedAt: now,
    });
    expect(toUserUpdate(update, { now, passwordHash: 'NEW' })).toMatchObject({ sPasswordHash: 'NEW' });
  });
});
