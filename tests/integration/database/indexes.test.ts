import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { ensureMonitorDbIndexes } from '../../../src/database/indexes.js';
import { isDuplicateKeyError } from '../../../src/errors/mongoErrors.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';

let mongo: TestMongo;
let db: Db;

beforeAll(async () => {
  mongo = await startTestMongo();
  db = mongo.newDb('indexes');
  await ensureMonitorDbIndexes(db);
}, 180_000);

afterAll(async () => {
  await mongo.stop();
}, 60_000);

async function rejects(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch (err) {
    return isDuplicateKeyError(err);
  }
}

describe('ensureMonitorDbIndexes', () => {
  it('is idempotent', async () => {
    await expect(ensureMonitorDbIndexes(db)).resolves.toBeUndefined();
  });

  it('makes user and recipient emails unique only among non-deleted records (TD-36)', async () => {
    for (const name of [COLLECTIONS.USERS, COLLECTIONS.RECIPIENTS]) {
      const col = db.collection(name);
      await col.insertOne({ sEmail: 'a@x.com', bIsDeleted: false });
      expect(await rejects(col.insertOne({ sEmail: 'a@x.com', bIsDeleted: false }))).toBe(true);
      await col.updateOne({ sEmail: 'a@x.com' }, { $set: { bIsDeleted: true } });
      await expect(col.insertOne({ sEmail: 'a@x.com', bIsDeleted: false })).resolves.toBeDefined();
      // Two deleted records may share an email.
      await col.updateOne({ sEmail: 'a@x.com', bIsDeleted: false }, { $set: { bIsDeleted: true } });
      await expect(col.insertOne({ sEmail: 'a@x.com', bIsDeleted: true })).resolves.toBeDefined();
    }
  });

  it('creates only the partial email index and never drops the legacy plain one at startup', async () => {
    const legacyDb = mongo.newDb('legacy');
    await legacyDb.collection(COLLECTIONS.USERS).createIndex({ sEmail: 1 }, { unique: true }, undefined);
    await ensureMonitorDbIndexes(legacyDb);
    const names = (await legacyDb.collection(COLLECTIONS.USERS).indexes()).map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['sEmail_1', 'sEmail_1_active_unique']));
    const fresh = (await db.collection(COLLECTIONS.USERS).indexes()).map((i) => i.name);
    expect(fresh).toContain('sEmail_1_active_unique');
    expect(fresh).not.toContain('sEmail_1');
  });

  it('makes monitor names unique only among non-deleted monitors', async () => {
    const monitors = db.collection(COLLECTIONS.WEBHOOK_MONITORS);
    await monitors.insertOne({ sName: 'Razorpay', dDeletedAt: null });
    expect(await rejects(monitors.insertOne({ sName: 'Razorpay', dDeletedAt: null }))).toBe(true);
    await monitors.updateOne({ sName: 'Razorpay' }, { $set: { dDeletedAt: new Date() } });
    await expect(monitors.insertOne({ sName: 'Razorpay', dDeletedAt: null })).resolves.toBeDefined();

    const endpoints = db.collection(COLLECTIONS.ENDPOINT_MONITORS);
    await endpoints.insertOne({ sServerName: 'API', dDeletedAt: null });
    expect(await rejects(endpoints.insertOne({ sServerName: 'API', dDeletedAt: null }))).toBe(true);
  });

  it('allows only one open incident per monitor', async () => {
    const incidents = db.collection(COLLECTIONS.INCIDENTS);
    const monitorId = new ObjectId();
    await incidents.insertOne({ iMonitorId: monitorId, eKind: 'MONITOR', dClosedAt: null });
    expect(
      await rejects(incidents.insertOne({ iMonitorId: monitorId, eKind: 'MONITOR', dClosedAt: null })),
    ).toBe(true);
    await incidents.updateOne({ iMonitorId: monitorId }, { $set: { dClosedAt: new Date() } });
    await expect(
      incidents.insertOne({ iMonitorId: monitorId, eKind: 'MONITOR', dClosedAt: null }),
    ).resolves.toBeDefined();
  });

  it('allows only one open source outage', async () => {
    const incidents = db.collection(COLLECTIONS.INCIDENTS);
    await incidents.insertOne({ iMonitorId: null, eKind: 'SOURCE_ERROR', dClosedAt: null });
    expect(
      await rejects(incidents.insertOne({ iMonitorId: null, eKind: 'SOURCE_ERROR', dClosedAt: null })),
    ).toBe(true);
  });

  it('makes alert dedupe keys unique (TD-09)', async () => {
    const alerts = db.collection(COLLECTIONS.ALERTS);
    await alerts.insertOne({ sDedupeKey: 'incident:1:open' });
    expect(await rejects(alerts.insertOne({ sDedupeKey: 'incident:1:open' }))).toBe(true);
  });
});
