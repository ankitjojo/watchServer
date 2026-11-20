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
  await t.sourceDb.collection('wh_ok').insertOne({ dCreatedAt: new Date() });
  await t.sourceDb.collection('wh_ok').createIndex({ dCreatedAt: -1 }, {}, undefined);
}, 180_000);

afterAll(async () => {
  await t.services.scheduler.stop();
  await mongo.stop();
});

const webhook = async (name: string) =>
  (
    await t.services.webhookMonitors.create(
      {
        name,
        gatewayName: 'G',
        sourceCollection: 'wh_ok',
        timestampKey: 'dCreatedAt',
        checkInterval: { value: 10, unit: 'MINUTE' },
        threshold: { value: 2, unit: 'HOUR' },
        alertMode: 'ONCE_WITH_RECOVERY',
        isEnabled: true,
      },
      actor,
    )
  ).monitor;

const endpoint = (name: string) =>
  t.services.endpointMonitors.create(
    {
      serverName: name,
      url: 'http://127.0.0.1:9/health',
      checkInterval: { value: 5, unit: 'MINUTE' },
      retryCount: 0,
      alertMode: 'ONCE_WITH_RECOVERY',
      isEnabled: true,
    },
    actor,
  );

describe('webhook monitors: delete keeps the record (T1, T12)', () => {
  it('stores who/when on the existing dDeletedAt marker (no bIsDeleted on monitors), hides it from normal reads, and lists it as deleted', async () => {
    const m = await webhook('Hook A');
    expect(m.deletedAt).toBeNull();
    await t.services.webhookMonitors.remove(m.id, actor);
    const doc = await t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).findOne({ _id: new ObjectId(m.id) });
    expect(doc?.['dDeletedAt']).toEqual(expect.any(Date));
    expect(String(doc?.['iDeletedBy'])).toBe(actor.id);
    expect(doc?.['bIsEnabled']).toBe(false);
    expect(doc).not.toHaveProperty('bIsDeleted');

    expect((await t.services.webhookMonitors.list()).some((x) => x.id === m.id)).toBe(false);
    await expect(t.services.webhookMonitors.getById(m.id)).rejects.toMatchObject({
      code: ERROR_CODE.NOT_FOUND,
    });
    const kept = await t.services.webhookMonitors.getByIdIncludingDeleted(m.id);
    expect(kept.deletedAt).toEqual(expect.any(Date));
    const deleted = await t.services.webhookMonitors.listDeleted();
    expect(deleted.map((x) => x.id)).toContain(m.id);
  });

  it('every write on a deleted monitor is NotFound; the name can be reused', async () => {
    const m = await webhook('Hook B');
    await t.services.webhookMonitors.remove(m.id, actor);
    await expect(t.services.webhookMonitors.setEnabled(m.id, true, actor)).rejects.toMatchObject({
      code: ERROR_CODE.NOT_FOUND,
    });
    await expect(t.services.webhookMonitors.remove(m.id, actor)).rejects.toMatchObject({
      code: ERROR_CODE.NOT_FOUND,
    });
    await expect(webhook('Hook B')).resolves.toBeDefined();
  });

  it('lists deleted monitors newest first', async () => {
    const a = await webhook('Hook C');
    const b = await webhook('Hook D');
    await t.services.webhookMonitors.remove(a.id, actor);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.services.webhookMonitors.remove(b.id, actor);
    const ids = (await t.services.webhookMonitors.listDeleted()).map((x) => x.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it('T16: the delete is audited', async () => {
    const m = await webhook('Hook E');
    await t.services.webhookMonitors.remove(m.id, actor);
    expect(
      await t.db
        .collection(COLLECTIONS.AUDIT_LOGS)
        .countDocuments({ eAction: 'DELETE', eEntityType: 'WEBHOOK_MONITOR', iEntityId: new ObjectId(m.id) }),
    ).toBe(1);
  });
});

describe('endpoint monitors: delete keeps the record (T1, T12)', () => {
  it('same rules as webhook monitors', async () => {
    const m = await endpoint('Api A');
    expect(m.deletedAt).toBeNull();
    await t.services.endpointMonitors.remove(m.id, actor);
    const doc = await t.db.collection(COLLECTIONS.ENDPOINT_MONITORS).findOne({ _id: new ObjectId(m.id) });
    expect(doc?.['dDeletedAt']).toEqual(expect.any(Date));
    expect(String(doc?.['iDeletedBy'])).toBe(actor.id);
    expect(doc).not.toHaveProperty('bIsDeleted');
    expect((await t.services.endpointMonitors.list()).some((x) => x.id === m.id)).toBe(false);
    await expect(t.services.endpointMonitors.getById(m.id)).rejects.toMatchObject({
      code: ERROR_CODE.NOT_FOUND,
    });
    expect((await t.services.endpointMonitors.getByIdIncludingDeleted(m.id)).deletedAt).toEqual(
      expect.any(Date),
    );
    expect((await t.services.endpointMonitors.listDeleted()).map((x) => x.id)).toContain(m.id);
    await expect(t.services.endpointMonitors.setEnabled(m.id, false, actor)).rejects.toMatchObject({
      code: ERROR_CODE.NOT_FOUND,
    });
  });
});
