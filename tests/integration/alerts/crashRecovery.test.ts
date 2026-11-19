import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import {
  MIN,
  endpointSnapshot,
  makeCheck,
  startAlertsHarness,
  webhookSnapshot,
} from '../../helpers/alertsHarness.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo();
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

// Plan Appendix F.3: a crash at any step must leave exactly one alert per dedupe key after the next check.

describe('crash after the incident opened, before the alert was stored', () => {
  it('the next failing check creates the missing alert, and a repeat creates nothing more', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = webhookSnapshot();
    const incident = await h.t.services.incidents.open({
      monitorId: monitor.monitorId,
      openingResult: 'STALE',
      checkId: new ObjectId().toHexString(),
    });
    expect(incident.lastAlertAt).toBeNull();

    h.clock.advance(10 * MIN);
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });
    h.clock.advance(10 * MIN);
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });

    const alerts = await h.t.db
      .collection(COLLECTIONS.ALERTS)
      .find({ iMonitorId: new ObjectId(monitor.monitorId) })
      .toArray();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.['sDedupeKey']).toBe(`incident:${incident.id}:open`);
    expect((await h.t.services.incidents.findOpen(monitor.monitorId))?.lastAlertAt).not.toBeNull();
  });
});

describe('crash after the alert was stored, before the incident recorded it', () => {
  it('re-creating the alert is a no-op through the dedupe key, and the incident catches up', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = webhookSnapshot();
    const first = await h.t.services.alerts.processCheckOutcome({
      monitor,
      check: makeCheck(monitor, 'STALE', h.clock),
    });
    // Simulate the crash: the alert exists but the incident never learned about it.
    await h.t.db
      .collection(COLLECTIONS.INCIDENTS)
      .updateOne({ _id: new ObjectId(first.openIncidentId ?? '') }, { $set: { dLastAlertAt: null } });

    h.clock.advance(10 * MIN);
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });

    expect(
      await h.t.db
        .collection(COLLECTIONS.ALERTS)
        .countDocuments({ iMonitorId: new ObjectId(monitor.monitorId) }),
    ).toBe(1);
    expect((await h.t.services.incidents.findOpen(monitor.monitorId))?.lastAlertAt).toEqual(h.clock.now());
  });

  it('works the same for a reminder', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = endpointSnapshot({ alertMode: 'REPEAT_EVERY', repeatIntervalMs: 30 * MIN });
    const first = await h.t.services.alerts.processCheckOutcome({
      monitor,
      check: makeCheck(monitor, 'DOWN', h.clock),
    });
    h.clock.advance(30 * MIN);
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'DOWN', h.clock) });
    // Crash: the reminder was stored but the counter and timestamp were not.
    await h.t.db
      .collection(COLLECTIONS.INCIDENTS)
      .updateOne(
        { _id: new ObjectId(first.openIncidentId ?? '') },
        { $set: { dLastAlertAt: new Date(h.clock.now().getTime() - 30 * MIN), nReminderCount: 0 } },
      );
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'DOWN', h.clock) });
    const alerts = await h.t.db
      .collection(COLLECTIONS.ALERTS)
      .find({ iMonitorId: new ObjectId(monitor.monitorId) })
      .toArray();
    expect(alerts).toHaveLength(2);
    expect((await h.t.services.incidents.findOpen(monitor.monitorId))?.reminderCount).toBe(1);
  });
});

describe('crash after the RECOVERED alert was stored, before the incident closed', () => {
  it('the next OK check closes the incident and does not send a second RECOVERED', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = webhookSnapshot();
    const opened = await h.t.services.alerts.processCheckOutcome({
      monitor,
      check: makeCheck(monitor, 'STALE', h.clock),
    });
    h.clock.advance(30 * MIN);
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'OK', h.clock) });
    // Simulate the crash by re-opening the incident.
    await h.t.db
      .collection(COLLECTIONS.INCIDENTS)
      .updateOne(
        { _id: new ObjectId(opened.openIncidentId ?? '') },
        { $set: { dClosedAt: null }, $unset: { eCloseReason: '' } },
      );

    h.clock.advance(10 * MIN);
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'OK', h.clock) });

    expect(await h.t.services.incidents.findOpen(monitor.monitorId)).toBeNull();
    expect(
      await h.t.db
        .collection(COLLECTIONS.ALERTS)
        .countDocuments({ iMonitorId: new ObjectId(monitor.monitorId), eType: 'RECOVERED' }),
    ).toBe(1);
  });
});

describe('source outage crash points', () => {
  it('a repeated MONITOR_ERROR for the same outage never creates a second alert', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = webhookSnapshot();
    for (let i = 0; i < 4; i++)
      await h.t.services.alerts.handleSourceError({ monitor, check: makeCheck(monitor, 'ERROR', h.clock) });
    expect(await h.t.db.collection(COLLECTIONS.ALERTS).countDocuments({ eType: 'MONITOR_ERROR' })).toBe(1);
  });

  it('crash after the source RECOVERED alert was stored, before the outage closed: the next healthy read finishes the job once', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = webhookSnapshot();
    await h.t.services.alerts.handleSourceError({ monitor, check: makeCheck(monitor, 'ERROR', h.clock) });
    const outage = await h.t.services.incidents.findOpenSourceError();
    h.clock.advance(MIN);
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'OK', h.clock) });
    await h.t.db
      .collection(COLLECTIONS.INCIDENTS)
      .updateOne({ _id: new ObjectId(outage?.id ?? '') }, { $set: { dClosedAt: null } });
    h.clock.advance(MIN);
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'OK', h.clock) });
    expect(await h.t.services.incidents.findOpenSourceError()).toBeNull();
    expect(
      await h.t.db.collection(COLLECTIONS.ALERTS).countDocuments({ iMonitorId: null, eType: 'RECOVERED' }),
    ).toBe(1);
  });
});
