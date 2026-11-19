import { ObjectId, type Db } from 'mongodb';
import { ensureMonitorDbIndexes } from '../../../src/database/indexes.js';
import { createIncidentsRepository } from '../../../src/modules/incidents/incidents.repository.js';
import {
  createIncidentsService,
  type IncidentsService,
} from '../../../src/modules/incidents/incidents.service.js';
import { FakeClock } from '../../helpers/fakeClock.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';

let mongo: TestMongo;
let db: Db;
let service: IncidentsService;
const clock = new FakeClock('2026-11-18T10:00:00Z');
const id = (): string => new ObjectId().toHexString();

beforeAll(async () => {
  mongo = await startTestMongo();
  db = mongo.newDb('incidents');
  await ensureMonitorDbIndexes(db);
  service = createIncidentsService({ repo: createIncidentsRepository(db), clock });
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

describe('monitor incidents', () => {
  it('opens one and finds it as the open incident', async () => {
    const monitorId = id();
    const opened = await service.open({ monitorId, openingResult: 'STALE', checkId: id() });
    expect(opened).toMatchObject({
      monitorId,
      kind: 'MONITOR',
      closedAt: null,
      reminderCount: 0,
      lastAlertAt: null,
    });
    expect(await service.findOpen(monitorId)).toMatchObject({ id: opened.id });
  });

  it('keeps exactly one open incident per monitor even with concurrent opens', async () => {
    const monitorId = id();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.open({ monitorId, openingResult: 'DOWN', checkId: id() })),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(
      await db
        .collection('incidents')
        .countDocuments({ iMonitorId: new ObjectId(monitorId), dClosedAt: null }),
    ).toBe(1);
  });

  it('can open a new incident after the previous one closed', async () => {
    const monitorId = id();
    const first = await service.open({ monitorId, openingResult: 'DOWN', checkId: id() });
    clock.advance(60_000);
    expect(await service.close(first.id, 'RECOVERED')).toMatchObject({ closeReason: 'RECOVERED' });
    expect(await service.findOpen(monitorId)).toBeNull();
    const second = await service.open({ monitorId, openingResult: 'STALE', checkId: id() });
    expect(second.id).not.toBe(first.id);
    expect((await service.listForMonitor(monitorId)).map((i) => i.id)).toEqual([second.id, first.id]);
  });

  it('closing is conditional: a second close returns null and keeps the first reason', async () => {
    const monitorId = id();
    const incident = await service.open({ monitorId, openingResult: 'DOWN', checkId: id() });
    expect(await service.close(incident.id, 'RECOVERED')).not.toBeNull();
    expect(await service.close(incident.id, 'MONITOR_DELETED')).toBeNull();
    const stored = await db.collection('incidents').findOne({ _id: new ObjectId(incident.id) });
    expect(stored?.['eCloseReason']).toBe('RECOVERED');
  });

  it('markAlerted stores the last alert time and the reminder counter', async () => {
    const monitorId = id();
    const incident = await service.open({ monitorId, openingResult: 'DOWN', checkId: id() });
    const at = new Date('2026-11-18T10:30:00Z');
    await service.markAlerted(incident.id, at);
    expect(await service.findOpen(monitorId)).toMatchObject({ lastAlertAt: at, reminderCount: 0 });
    await service.markAlerted(incident.id, new Date('2026-11-18T11:00:00Z'), 2);
    expect(await service.findOpen(monitorId)).toMatchObject({ reminderCount: 2 });
  });

  it('D7: closing for a deleted monitor records MONITOR_DELETED and is a no-op without an open incident', async () => {
    const monitorId = id();
    const incident = await service.open({ monitorId, openingResult: 'DOWN', checkId: id() });
    await service.closeOpenIncidentForDeletedMonitor('WEBHOOK', monitorId);
    expect(await service.findOpen(monitorId)).toBeNull();
    const stored = await db.collection('incidents').findOne({ _id: new ObjectId(incident.id) });
    expect(stored?.['eCloseReason']).toBe('MONITOR_DELETED');
    await expect(service.closeOpenIncidentForDeletedMonitor('WEBHOOK', id())).resolves.toBeUndefined();
  });
});

describe('source outage incident (FR-A4a)', () => {
  it('allows only one open source outage, and joiners are added once', async () => {
    const a = id();
    const b = id();
    const results = await Promise.all([
      service.openSourceError({ affectedMonitorIds: [a], checkId: id() }),
      service.openSourceError({ affectedMonitorIds: [b], checkId: id() }),
      service.openSourceError({ affectedMonitorIds: [a], checkId: id() }),
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const open = await service.findOpenSourceError();
    expect(open).toMatchObject({ kind: 'SOURCE_ERROR', monitorId: null });
    await service.addAffectedMonitor(results[0].id, b);
    await service.addAffectedMonitor(results[0].id, b);
    const c = id();
    await service.addAffectedMonitor(results[0].id, c);
    const after = await service.findOpenSourceError();
    expect(after?.affectedMonitorIds.filter((m) => m === b)).toHaveLength(1);
    expect(after?.affectedMonitorIds).toContain(c);
  });

  it('counts monitor incidents plus the open source outage, and a new outage can start after closing', async () => {
    const before = await service.countOpen();
    expect(before).toBeGreaterThanOrEqual(1);
    const open = await service.findOpenSourceError();
    await service.close(open?.id ?? '', 'RECOVERED');
    expect(await service.findOpenSourceError()).toBeNull();
    expect(await service.countOpen()).toBe(before - 1);
    const next = await service.openSourceError({ affectedMonitorIds: [id()], checkId: id() });
    expect(next.id).not.toBe(open?.id);
  });
});
