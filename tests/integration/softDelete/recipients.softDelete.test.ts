import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { ERROR_CODE } from '../../../src/errors/errorCodes.js';
import { createLogger } from '../../../src/logger/index.js';
import { seedMasterRecipient } from '../../../src/modules/recipients/recipients.seed.js';
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
const make = (over: { email?: string; type?: 'NORMAL' | 'MASTER'; isActive?: boolean } = {}) => {
  n += 1;
  return t.services.recipients.create({
    name: `Rec ${n}`,
    email: over.email ?? `rec${n}@test.local`,
    type: over.type ?? 'NORMAL',
    isActive: over.isActive ?? true,
  });
};
const raw = (id: string) => t.db.collection(COLLECTIONS.RECIPIENTS).findOne({ _id: new ObjectId(id) });
const audienceEmails = async (): Promise<string[]> =>
  (await t.services.recipients.resolveAlertRecipients('ALL')).map((r) => r.email);

describe('recipients soft delete (T1, T4, T11, T15, T16, T18)', () => {
  it('T1: delete keeps the document, marked deleted and inactive, with who/when', async () => {
    const r = await make();
    await t.services.recipients.remove(r.id, actor);
    const doc = await raw(r.id);
    expect(doc).toMatchObject({ bIsDeleted: true, bIsActive: false });
    expect(doc?.['dDeletedAt']).toEqual(expect.any(Date));
    expect(String(doc?.['iDeletedBy'])).toBe(actor.id);
    expect((await t.services.recipients.list()).some((x) => x.id === r.id)).toBe(false);
    await expect(t.services.recipients.getById(r.id)).rejects.toMatchObject({ code: ERROR_CODE.NOT_FOUND });
    await expect(
      t.services.recipients.update(
        r.id,
        { name: 'x', email: r.email, type: 'NORMAL', isActive: true },
        actor,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODE.NOT_FOUND });
  });

  it('T4: a deleted recipient is no longer in any new alert audience (the one place recipients are resolved)', async () => {
    const r = await make({ email: 'audience@test.local' });
    expect(await audienceEmails()).toContain('audience@test.local');
    await t.services.recipients.remove(r.id, actor);
    expect(await audienceEmails()).not.toContain('audience@test.local');
    // The audience a past alert already stored is plain data copied at creation (FR-A5): unaffected.
    expect(r.email).toBe('audience@test.local');
  });

  it('T6: a master still cannot be deleted', async () => {
    const m = await make({ type: 'MASTER' });
    await expect(t.services.recipients.remove(m.id, actor)).rejects.toMatchObject({
      code: ERROR_CODE.MASTER_PROTECTED,
    });
    expect(await raw(m.id)).toMatchObject({ bIsDeleted: false });
  });

  it('T11: a deleted email can be used again; two active recipients still conflict', async () => {
    const r = await make({ email: 'reuse-r@test.local' });
    await expect(make({ email: 'reuse-r@test.local' })).rejects.toMatchObject({ code: ERROR_CODE.CONFLICT });
    await t.services.recipients.remove(r.id, actor);
    await expect(make({ email: 'reuse-r@test.local' })).resolves.toBeDefined();
  });

  it('T15: an old document without the new fields still loads, lists and receives alerts', async () => {
    const r = await make({ email: 'legacy-r@test.local' });
    await t.db
      .collection(COLLECTIONS.RECIPIENTS)
      .updateOne({ _id: new ObjectId(r.id) }, { $unset: { bIsDeleted: '', dDeletedAt: '', iDeletedBy: '' } });
    expect((await t.services.recipients.getById(r.id)).deletedAt).toBeNull();
    expect(await audienceEmails()).toContain('legacy-r@test.local');
    await t.services.recipients.remove(r.id, actor);
    expect(await raw(r.id)).toMatchObject({ bIsDeleted: true });
  });

  it('T16: delete writes an audit entry', async () => {
    const r = await make();
    await t.services.recipients.remove(r.id, actor);
    const entry = await t.db
      .collection(COLLECTIONS.AUDIT_LOGS)
      .findOne({ eAction: 'DELETE', eEntityType: 'RECIPIENT', iEntityId: new ObjectId(r.id) });
    expect(entry?.['oBefore']).toMatchObject({ email: r.email });
  });

  it('lists deleted recipients, newest first', async () => {
    const a = await make();
    const b = await make();
    await t.services.recipients.remove(a.id, actor);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.services.recipients.remove(b.id, actor);
    const ids = (await t.services.recipients.listDeleted()).map((x) => x.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it('T18: restoring a recipient whose email is now used by an active one fails with a clear error', async () => {
    const old = await make({ email: 'again-r@test.local' });
    await t.services.recipients.remove(old.id, actor);
    await make({ email: 'again-r@test.local' });
    await expect(t.services.recipients.restore(old.id, actor)).rejects.toMatchObject({
      code: ERROR_CODE.EMAIL_IN_USE,
    });
    expect(await raw(old.id)).toMatchObject({ bIsDeleted: true });
  });

  it('seed: when the env master email belongs to a deleted recipient, the seed restores it as master', async () => {
    await t.db.collection(COLLECTIONS.RECIPIENTS).deleteMany({ eType: 'MASTER' });
    const now = new Date();
    await t.db.collection(COLLECTIONS.RECIPIENTS).insertOne({
      sName: 'Old master',
      sEmail: 'seed-master@test.local',
      bIsActive: false,
      eType: 'NORMAL',
      bIsDeleted: true,
      dDeletedAt: now,
      iDeletedBy: new ObjectId(),
      dCreatedAt: now,
      dUpdatedAt: now,
    });
    await seedMasterRecipient({
      recipients: t.services.recipients,
      seed: { master: { email: 'Seed-Master@test.local ', name: 'Seed' } },
      logger: createLogger({ level: 'silent' }),
    });
    expect(await t.services.recipients.countMasters()).toBe(1);
    const doc = await t.db.collection(COLLECTIONS.RECIPIENTS).findOne({ sEmail: 'seed-master@test.local' });
    expect(doc).toMatchObject({ eType: 'MASTER', bIsActive: true, bIsDeleted: false, dDeletedAt: null });
  });
});
