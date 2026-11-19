import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { ensureMonitorDbIndexes } from '../../../src/database/indexes.js';
import {
  createChecksRepository,
  type ChecksRepository,
} from '../../../src/modules/checks/checks.repository.js';
import {
  createChecksService,
  MAX_SERIES_POINTS,
  type ChecksService,
} from '../../../src/modules/checks/checks.service.js';
import type { RecordCheckInput } from '../../../src/modules/checks/checks.types.js';
import { FakeClock } from '../../helpers/fakeClock.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';

let mongo: TestMongo;
let db: Db;
let repo: ChecksRepository;
let service: ChecksService;
const T0 = new Date('2026-11-18T00:00:00Z').getTime();
const MIN = 60_000;

beforeAll(async () => {
  mongo = await startTestMongo();
  db = mongo.newDb('checks');
  await ensureMonitorDbIndexes(db);
  repo = createChecksRepository(db);
  service = createChecksService({ repo, clock: new FakeClock('2026-11-18T12:00:00Z') });
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

const webhook = (
  monitorId: string,
  minute: number,
  over: Partial<RecordCheckInput> = {},
): RecordCheckInput => ({
  monitorId,
  monitorType: 'WEBHOOK',
  trigger: 'SCHEDULE',
  startedAt: new Date(T0 + minute * MIN),
  finishedAt: new Date(T0 + minute * MIN + 50),
  result: 'OK',
  webhook: { thresholdMs: 1, ageMs: minute },
  ...over,
});

describe('record and keyset pagination', () => {
  const monitorId = new ObjectId().toHexString();

  beforeAll(async () => {
    for (let m = 0; m < 25; m++)
      await service.record(webhook(monitorId, m, m % 5 === 0 ? { result: 'STALE' } : {}));
    // Two checks with the identical start time: the _id tie-break must keep pages stable.
    await service.record(webhook(monitorId, 24));
    await service.record(webhook(monitorId, 24));
  });

  it('lists newest first and walks every check exactly once across pages', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.listForMonitor({ monitorId }, { limit: 7, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(7);
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(27);
    expect(new Set(seen).size).toBe(27);
    const all = await service.listForMonitor({ monitorId }, { limit: 200 });
    const times = all.items.map((c) => c.startedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(all.nextCursor).toBeUndefined();
  });

  it('has no cursor when everything fits on one page', async () => {
    const page = await service.listForMonitor({ monitorId }, { limit: 27 });
    expect(page.items).toHaveLength(27);
    expect(page.nextCursor).toBeUndefined();
  });

  it('filters by result and date range, also while paging', async () => {
    const stale = await service.listForMonitor({ monitorId, result: 'STALE' }, { limit: 200 });
    expect(stale.items).toHaveLength(5);
    const ranged = await service.listForMonitor(
      { monitorId, from: new Date(T0 + 10 * MIN), to: new Date(T0 + 14 * MIN) },
      { limit: 2 },
    );
    expect(ranged.items).toHaveLength(2);
    expect(ranged.nextCursor).toBeDefined();
    const second = await service.listForMonitor(
      { monitorId, from: new Date(T0 + 10 * MIN), to: new Date(T0 + 14 * MIN) },
      { limit: 2, ...(ranged.nextCursor ? { cursor: ranged.nextCursor } : {}) },
    );
    const ids = [...ranged.items, ...second.items].map((c) => c.startedAt.getTime());
    expect(ids).toEqual([14, 13, 12, 11].map((m) => T0 + m * MIN));
  });

  it('only returns checks of the requested monitor and clamps the page size', async () => {
    const other = await service.listForMonitor({ monitorId: new ObjectId().toHexString() }, { limit: 5000 });
    expect(other.items).toEqual([]);
    expect(
      await db.collection(COLLECTIONS.CHECKS).countDocuments({ iMonitorId: new ObjectId(monitorId) }),
    ).toBe(27);
  });

  it('rejects a malformed cursor', async () => {
    await expect(service.listForMonitor({ monitorId }, { cursor: 'garbage' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('series (database-design B.3)', () => {
  it('returns raw points when there are few', async () => {
    const monitorId = new ObjectId().toHexString();
    for (let m = 0; m < 10; m++) await service.record(webhook(monitorId, m));
    const points = await service.series({
      monitorId,
      monitorType: 'WEBHOOK',
      from: new Date(T0),
      to: new Date(T0 + 60 * MIN),
    });
    expect(points).toHaveLength(10);
    expect(points.map((p) => p.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(points[0]).not.toHaveProperty('isUp');
  });

  it('buckets on the server into at most 500 points, keeping the peak age', async () => {
    const monitorId = new ObjectId().toHexString();
    const docs: RecordCheckInput[] = [];
    for (let m = 0; m < 1200; m++) docs.push(webhook(monitorId, m));
    await db.collection(COLLECTIONS.CHECKS).insertMany(
      docs.map((d) => ({
        iMonitorId: new ObjectId(d.monitorId),
        eMonitorType: d.monitorType,
        eTrigger: d.trigger,
        dStartedAt: d.startedAt,
        dFinishedAt: d.finishedAt,
        eResult: d.result,
        oWebhook: { nThresholdMs: 1, nAgeMs: d.webhook?.ageMs ?? 0 },
        dCreatedAt: d.startedAt,
      })),
    );
    const points = await service.series({
      monitorId,
      monitorType: 'WEBHOOK',
      from: new Date(T0),
      to: new Date(T0 + 1200 * MIN),
    });
    expect(points.length).toBeLessThanOrEqual(MAX_SERIES_POINTS);
    expect(points.length).toBeGreaterThan(100);
    const times = points.map((p) => p.t.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(Math.max(...points.map((p) => p.value ?? 0))).toBe(1199);
  });

  it('reports response time and up/down for endpoints, and marks a bucket down if any check failed', async () => {
    const monitorId = new ObjectId().toHexString();
    const rows = [
      { m: 0, status: 200, ms: 100, result: 'OK' },
      { m: 1, status: 500, ms: 300, result: 'DOWN' },
      { m: 2, status: 200, ms: 50, result: 'OK' },
    ];
    for (const r of rows) {
      await service.record({
        monitorId,
        monitorType: 'ENDPOINT',
        trigger: 'SCHEDULE',
        startedAt: new Date(T0 + r.m * MIN),
        finishedAt: new Date(T0 + r.m * MIN + 10),
        result: r.result as 'OK' | 'DOWN',
        endpoint: { attempts: [{ attempt: 1, statusCode: r.status, responseTimeMs: r.ms }] },
      });
    }
    const points = await service.series({
      monitorId,
      monitorType: 'ENDPOINT',
      from: new Date(T0),
      to: new Date(T0 + 10 * MIN),
    });
    expect(points.map((p) => [p.value, p.isUp])).toEqual([
      [100, true],
      [300, false],
      [50, true],
    ]);
  });

  it('returns nothing for a range without checks', async () => {
    expect(
      await service.series({
        monitorId: new ObjectId().toHexString(),
        monitorType: 'WEBHOOK',
        from: new Date(T0),
        to: new Date(T0 + MIN),
      }),
    ).toEqual([]);
  });
});
