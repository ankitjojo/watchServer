import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { ERROR_CODE } from '../../../src/errors/errorCodes.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;
let actor: { id: string; email: string };

beforeAll(async () => {
  mongo = await startTestMongo();
  t = await startTestApp({ mongo });
  const admin = (await t.services.users.list()).find((u) => u.role === 'ADMIN');
  actor = { id: admin?.id ?? '', email: admin?.email ?? '' };
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

let n = 0;
const make = (over: Partial<{ email: string; role: 'ADMIN' | 'VIEWER'; isActive: boolean }> = {}) => {
  n += 1;
  return t.services.users.create({
    name: `User ${n}`,
    email: over.email ?? `user${n}@test.local`,
    role: over.role ?? 'VIEWER',
    password: 'a-long-password-123',
    isActive: over.isActive ?? true,
  });
};
const raw = (id: string) => t.db.collection(COLLECTIONS.USERS).findOne({ _id: new ObjectId(id) });

describe('users soft delete (T1, T5, T11, T15, T16, T18)', () => {
  it('T1: delete keeps the document, marked deleted and inactive, with who/when', async () => {
    const user = await make();
    await t.services.users.remove(user.id, actor);
    const doc = await raw(user.id);
    expect(doc).toMatchObject({ bIsDeleted: true, bIsActive: false });
    expect(doc?.['dDeletedAt']).toEqual(expect.any(Date));
    expect(String(doc?.['iDeletedBy'])).toBe(actor.id);
  });

  it('T1: new users store the explicit not-deleted markers', async () => {
    const user = await make();
    expect(await raw(user.id)).toMatchObject({ bIsDeleted: false, dDeletedAt: null, iDeletedBy: null });
  });

  it('T5: a deleted user cannot log in, has no session user, is not an admin and cannot be edited', async () => {
    const admin = await make({ role: 'ADMIN' });
    const before = await t.services.users.authenticate(admin.email, 'a-long-password-123');
    expect(before?.id).toBe(admin.id);
    const admins = await t.db
      .collection(COLLECTIONS.USERS)
      .countDocuments({ eRole: 'ADMIN', bIsDeleted: false });
    await t.services.users.remove(admin.id, actor);
    expect(await t.services.users.authenticate(admin.email, 'a-long-password-123')).toBeNull();
    expect(await t.services.users.getActiveById(admin.id)).toBeNull();
    await expect(t.services.users.getById(admin.id)).rejects.toMatchObject({ code: ERROR_CODE.NOT_FOUND });
    await expect(t.services.users.remove(admin.id, actor)).rejects.toMatchObject({
      code: ERROR_CODE.NOT_FOUND,
    });
    expect((await t.services.users.list()).some((u) => u.id === admin.id)).toBe(false);
    // The last active admin guard counts only non-deleted admins.
    expect(admins).toBeGreaterThan(1);
  });

  it('T5: deleted users still count for the first-admin seed (never re-seeds an admin)', async () => {
    const before = await t.services.users.countAll();
    const user = await make();
    await t.services.users.remove(user.id, actor);
    expect(await t.services.users.countAll()).toBe(before + 1);
  });

  it('T11: a deleted email can be used again (any case/padding is normalised by the form); two active users still conflict', async () => {
    const user = await make({ email: 'reuse@test.local' });
    await expect(make({ email: 'reuse@test.local' })).rejects.toMatchObject({ code: ERROR_CODE.CONFLICT });
    await t.services.users.remove(user.id, actor);
    await expect(make({ email: 'reuse@test.local' })).resolves.toMatchObject({ email: 'reuse@test.local' });
  });

  it('T15: an old document without the new fields still loads, lists and authenticates', async () => {
    const user = await make({ email: 'legacy@test.local' });
    await t.db
      .collection(COLLECTIONS.USERS)
      .updateOne(
        { _id: new ObjectId(user.id) },
        { $unset: { bIsDeleted: '', dDeletedAt: '', iDeletedBy: '' } },
      );
    expect((await t.services.users.getById(user.id)).deletedAt).toBeNull();
    expect((await t.services.users.list()).some((u) => u.id === user.id)).toBe(true);
    expect((await t.services.users.authenticate('legacy@test.local', 'a-long-password-123'))?.id).toBe(
      user.id,
    );
    expect(await t.services.users.getActiveById(user.id)).not.toBeNull();
    // ... and it can still be deleted.
    await t.services.users.remove(user.id, actor);
    expect(await raw(user.id)).toMatchObject({ bIsDeleted: true });
  });

  it('T16: delete writes an audit entry without the password hash', async () => {
    const user = await make();
    await t.services.users.remove(user.id, actor);
    const entry = await t.db
      .collection(COLLECTIONS.AUDIT_LOGS)
      .findOne({ eAction: 'DELETE', eEntityType: 'USER', iEntityId: new ObjectId(user.id) });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry)).not.toMatch(/passwordHash|sPasswordHash|\$2[aby]\$/i);
    expect(String(entry?.['iActorUserId'])).toBe(actor.id);
  });

  it('lists deleted users newest first, with the deletion time', async () => {
    const a = await make();
    const b = await make();
    await t.services.users.remove(a.id, actor);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.services.users.remove(b.id, actor);
    const deleted = await t.services.users.listDeleted();
    const ids = deleted.map((u) => u.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(deleted.find((u) => u.id === a.id)?.deletedAt).toEqual(expect.any(Date));
  });

  it('T18: restoring a user whose email is now used by an active user fails with a clear error', async () => {
    const old = await make({ email: 'again@test.local' });
    await t.services.users.remove(old.id, actor);
    await make({ email: 'again@test.local' });
    await expect(t.services.users.restore(old.id, actor)).rejects.toMatchObject({
      code: ERROR_CODE.EMAIL_IN_USE,
    });
    expect(await raw(old.id)).toMatchObject({ bIsDeleted: true });
  });

  it('restoring a user whose email is free clears the markers (Restore design, no UI yet)', async () => {
    const user = await make({ email: 'free@test.local' });
    await t.services.users.remove(user.id, actor);
    const back = await t.services.users.restore(user.id, actor);
    expect(back.deletedAt).toBeNull();
    expect(await raw(user.id)).toMatchObject({ bIsDeleted: false, dDeletedAt: null, iDeletedBy: null });
  });
});
