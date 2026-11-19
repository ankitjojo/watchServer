import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { createWebhookRunner } from '../../../src/modules/webhookMonitors/webhookMonitors.runner.js';
import { SourceDataError } from '../../../src/modules/sourceData/sourceData.errors.js';
import { createLogger } from '../../../src/logger/index.js';
import { systemClock } from '../../../src/types/clock.js';
import { createRecordingAlerts, type RecordingAlerts } from '../../helpers/fakeAlerts.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;
let alerts: RecordingAlerts;
let actor: { id: string; email: string };
const HOUR = 3_600_000;

async function createMonitor(
  name: string,
  collection: string,
  thresholdHours = 2,
  extra: Record<string, unknown> = {},
) {
  const { monitor } = await t.services.webhookMonitors.create(
    {
      name,
      gatewayName: 'Gateway',
      sourceCollection: collection,
      timestampKey: 'dCreatedAt',
      checkInterval: { value: 10, unit: 'MINUTE' },
      threshold: { value: thresholdHours, unit: 'HOUR' },
      alertMode: 'ONCE_WITH_RECOVERY',
      isEnabled: true,
      ...extra,
    },
    actor,
  );
  return monitor;
}

beforeAll(async () => {
  mongo = await startTestMongo();
  alerts = createRecordingAlerts();
  t = await startTestApp({ mongo, alerts });
  const admin = (await t.services.users.list()).find((u) => u.role === 'ADMIN');
  actor = { id: admin?.id ?? '', email: admin?.email ?? '' };
  const now = Date.now();
  await t.sourceDb
    .collection('wh_fresh')
    .insertOne({ dCreatedAt: new Date(now - 60_000), payload: 'SECRET' });
  await t.sourceDb.collection('wh_stale').insertOne({ dCreatedAt: new Date(now - 3 * HOUR) });
  await t.sourceDb.createCollection('wh_empty');
  await t.sourceDb.collection('wh_breaks').insertOne({ dCreatedAt: new Date(now - 60_000) });
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(() => {
  alerts.outcomes.length = 0;
  alerts.sourceErrors.length = 0;
  delete alerts.failWith;
  alerts.openIncidentId = null;
});

const run = (id: string, trigger: 'SCHEDULE' | 'MANUAL' = 'SCHEDULE') =>
  t.services.runners.WEBHOOK.run(id, trigger);

describe('webhook runner (FR-W3, FR-H1)', () => {
  it('stores an OK check with every FR-H1 field and updates the monitor state', async () => {
    const monitor = await createMonitor('Fresh', 'wh_fresh');
    const check = await run(monitor.id);
    expect(check).toMatchObject({
      monitorId: monitor.id,
      monitorType: 'WEBHOOK',
      trigger: 'SCHEDULE',
      result: 'OK',
      webhook: { thresholdMs: 2 * HOUR },
    });
    expect(check?.webhook?.lastDocId).toMatch(/^[a-f0-9]{24}$/);
    expect(check?.webhook?.lastDocTimestamp).toBeInstanceOf(Date);
    expect(check?.webhook?.ageMs).toBeGreaterThan(50_000);
    expect(check?.startedAt.getTime()).toBeLessThanOrEqual(check?.finishedAt.getTime() ?? 0);
    expect(JSON.stringify(check)).not.toContain('SECRET');

    const stored = await t.db.collection(COLLECTIONS.CHECKS).findOne({ _id: new ObjectId(check?.id) });
    expect(stored).toMatchObject({ eMonitorType: 'WEBHOOK', eTrigger: 'SCHEDULE', eResult: 'OK' });

    const state = (await t.services.webhookMonitors.getById(monitor.id)).state;
    expect(state).toMatchObject({ lastResult: 'OK', currentStatus: 'OK', lastCheckId: check?.id });
    expect(state.lastCheckAt).toEqual(check?.finishedAt);
    expect(state.lastAgeMs).toBe(check?.webhook?.ageMs);
  });

  it('is STALE when the newest document is older than the threshold', async () => {
    const monitor = await createMonitor('Stale', 'wh_stale', 2);
    const check = await run(monitor.id);
    expect(check?.result).toBe('STALE');
    expect(check?.webhook?.ageMs).toBeGreaterThan(2 * HOUR);
    expect((await t.services.webhookMonitors.getById(monitor.id)).state.currentStatus).toBe('STALE');
  });

  it('is NO_DATA for an empty collection and for an invalid timestamp', async () => {
    const empty = await createMonitor('Empty', 'wh_empty');
    expect(await run(empty.id)).toMatchObject({ result: 'NO_DATA', webhook: { reason: 'EMPTY_COLLECTION' } });
    const breaking = await createMonitor('Breaks', 'wh_breaks');
    await t.sourceDb.collection('wh_breaks').updateMany({}, { $set: { dCreatedAt: 'garbage' } });
    expect(await run(breaking.id)).toMatchObject({ result: 'NO_DATA', webhook: { reason: 'INVALID_DATE' } });
  });

  it('hands the monitor snapshot and the stored check to the alerts module, after storing the check', async () => {
    const monitor = await createMonitor('Snapshot', 'wh_stale', 1, {
      alertMode: 'REPEAT_EVERY',
      repeatInterval: { value: 30, unit: 'MINUTE' },
    });
    alerts.openIncidentId = new ObjectId().toHexString();
    const check = await run(monitor.id);
    expect(alerts.outcomes).toHaveLength(1);
    expect(alerts.outcomes[0]?.monitor).toEqual({
      monitorType: 'WEBHOOK',
      monitorId: monitor.id,
      name: 'Snapshot',
      gatewayName: 'Gateway',
      sourceCollection: 'wh_stale',
      timestampKey: 'dCreatedAt',
      thresholdMs: HOUR,
      checkIntervalMs: 600_000,
      alertMode: 'REPEAT_EVERY',
      repeatIntervalMs: 1_800_000,
    });
    expect(alerts.outcomes[0]?.check.id).toBe(check?.id);
    expect(await t.db.collection(COLLECTIONS.CHECKS).countDocuments({ _id: new ObjectId(check?.id) })).toBe(
      1,
    );
    expect((await t.services.webhookMonitors.getById(monitor.id)).state.openIncidentId).toBe(
      alerts.openIncidentId,
    );
  });

  it('marks a manual run as MANUAL', async () => {
    const monitor = await createMonitor('Manual', 'wh_fresh');
    expect((await run(monitor.id, 'MANUAL'))?.trigger).toBe('MANUAL');
  });

  it('skips a paused monitor on schedule but runs it when asked manually (D14)', async () => {
    const monitor = await createMonitor('Paused', 'wh_fresh', 2, { isEnabled: false });
    expect(await run(monitor.id, 'SCHEDULE')).toBeNull();
    expect(
      await t.db.collection(COLLECTIONS.CHECKS).countDocuments({ iMonitorId: new ObjectId(monitor.id) }),
    ).toBe(0);
    expect(await run(monitor.id, 'MANUAL')).toMatchObject({ result: 'OK', trigger: 'MANUAL' });
  });

  it('returns null for a deleted or unknown monitor and stores nothing', async () => {
    const monitor = await createMonitor('Gone', 'wh_fresh');
    await t.services.webhookMonitors.remove(monitor.id, actor);
    expect(await run(monitor.id)).toBeNull();
    expect(await run(new ObjectId().toHexString())).toBeNull();
    expect(alerts.outcomes).toHaveLength(0);
  });
});

describe('source failures (FR-W3 ERROR, FR-A4a)', () => {
  function failingRunner(error: Error) {
    return createWebhookRunner({
      monitors: t.services.webhookMonitors,
      sourceData: { getLatestTimestamp: () => Promise.reject(error) },
      checks: t.services.checks,
      alerts,
      clock: systemClock,
      logger: createLogger({ level: 'silent' }),
    });
  }

  it('stores ERROR with a safe error, tells alerts about the outage, and leaves STALE/NO_DATA status unchanged', async () => {
    const monitor = await createMonitor('Outage', 'wh_stale', 2);
    await run(monitor.id); // becomes STALE
    alerts.outcomes.length = 0;

    const error = new SourceDataError(
      'UNAVAILABLE',
      'The source database could not read the latest document',
      {
        cause: new Error('connect ECONNREFUSED 10.1.2.3:27017'),
      },
    );
    const check = await failingRunner(error).run(monitor.id, 'SCHEDULE');
    expect(check).toMatchObject({
      result: 'ERROR',
      error: {
        code: 'SOURCE_UNAVAILABLE',
        message: 'The source database could not read the latest document',
      },
    });
    expect(JSON.stringify(check)).not.toMatch(/10\.1\.2\.3|ECONNREFUSED/);
    expect(alerts.outcomes).toHaveLength(0);
    expect(alerts.sourceErrors).toHaveLength(1);
    expect(alerts.sourceErrors[0]?.monitor.monitorId).toBe(monitor.id);

    const state = (await t.services.webhookMonitors.getById(monitor.id)).state;
    expect(state.lastResult).toBe('ERROR');
    expect(state.currentStatus).toBe('STALE');
  });

  it.each([
    ['TIMEOUT', 'SOURCE_TIMEOUT'],
    ['COLLECTION_NOT_FOUND', 'SOURCE_COLLECTION_NOT_FOUND'],
    ['QUERY_FAILED', 'SOURCE_QUERY_FAILED'],
  ] as const)(
    "a per-collection %s is the monitor's own ERROR: normal alert rules, status ERROR, no outage (review H2)",
    async (kind, code) => {
      const monitor = await createMonitor(`Own ${kind}`, 'wh_fresh');
      alerts.outcomes.length = 0;
      alerts.sourceErrors.length = 0;
      const check = await failingRunner(new SourceDataError(kind, 'The source database could not do it')).run(
        monitor.id,
        'SCHEDULE',
      );
      expect(check).toMatchObject({ result: 'ERROR', error: { code } });
      expect(alerts.sourceErrors).toHaveLength(0);
      expect(alerts.outcomes).toHaveLength(1);
      expect(alerts.outcomes[0]?.check.id).toBe(check?.id);
      const state = (await t.services.webhookMonitors.getById(monitor.id)).state;
      expect(state).toMatchObject({ lastResult: 'ERROR', currentStatus: 'ERROR' });
    },
  );

  it("turns an unexpected exception into the monitor's own ERROR with a generic message", async () => {
    const monitor = await createMonitor('Weird', 'wh_fresh');
    alerts.outcomes.length = 0;
    alerts.sourceErrors.length = 0;
    const check = await failingRunner(new Error('secret internal detail')).run(monitor.id, 'SCHEDULE');
    expect(check).toMatchObject({ result: 'ERROR', error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(check)).not.toContain('secret internal detail');
    expect(alerts.sourceErrors).toHaveLength(0);
    expect(alerts.outcomes).toHaveLength(1);
  });

  it('reports ERROR when the Source DB client is really unreachable', async () => {
    const { MongoClient } = await import('mongodb');
    const dead = new MongoClient('mongodb://127.0.0.1:1/x', { serverSelectionTimeoutMS: 300 });
    const down = await startTestApp({ mongo, sourceDb: dead.db('x'), alerts });
    const admin = (await down.services.users.list()).find((u) => u.role === 'ADMIN');
    const monitor = await down.services.webhookMonitors
      .create(
        {
          name: 'Down source',
          gatewayName: 'G',
          sourceCollection: 'x',
          timestampKey: 'dCreatedAt',
          checkInterval: { value: 1, unit: 'MINUTE' },
          threshold: { value: 1, unit: 'HOUR' },
          alertMode: 'ONCE_WITH_RECOVERY',
          isEnabled: true,
        },
        { id: admin?.id ?? '', email: admin?.email ?? '' },
      )
      .catch(() => null);
    // Creating needs the source, so insert directly to focus on the runner.
    expect(monitor).toBeNull();
    const docId = new ObjectId();
    await down.db.collection(COLLECTIONS.WEBHOOK_MONITORS).insertOne({
      _id: docId,
      sName: 'Direct',
      sGatewayName: 'G',
      sSourceCollection: 'wh',
      sTimestampKey: 'dCreatedAt',
      oCheckInterval: { nValue: 1, eUnit: 'MINUTE', nMs: 60_000 },
      oThreshold: { nValue: 1, eUnit: 'HOUR', nMs: HOUR },
      eAlertMode: 'ONCE_WITH_RECOVERY',
      bIsEnabled: true,
      bHasDescIndexAtSave: true,
      oState: {},
      dDeletedAt: null,
      iCreatedBy: docId,
      iUpdatedBy: docId,
      dCreatedAt: new Date(),
      dUpdatedAt: new Date(),
    });
    const check = await down.services.runners.WEBHOOK.run(docId.toHexString(), 'SCHEDULE');
    expect(check).toMatchObject({ result: 'ERROR', error: { code: 'SOURCE_UNAVAILABLE' } });
    expect(check?.error?.message).not.toMatch(/127\.0\.0\.1|mongodb/);
    await dead.close();
  }, 30_000);
});

describe('alerting failures', () => {
  it('still stores the check and updates the state, then rethrows so the scheduler can log it', async () => {
    const monitor = await createMonitor('Alert fails', 'wh_stale', 2);
    alerts.failWith = new Error('alerts database down');
    await expect(run(monitor.id)).rejects.toThrow('alerts database down');
    expect(
      await t.db.collection(COLLECTIONS.CHECKS).countDocuments({ iMonitorId: new ObjectId(monitor.id) }),
    ).toBe(1);
    expect((await t.services.webhookMonitors.getById(monitor.id)).state).toMatchObject({
      lastResult: 'STALE',
      currentStatus: 'STALE',
    });
  });
});
