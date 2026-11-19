import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import {
  HOUR,
  MIN,
  endpointSnapshot,
  makeCheck,
  startAlertsHarness,
  webhookSnapshot,
  type AlertsHarness,
} from '../../helpers/alertsHarness.js';

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo();
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

const alertsOf = (h: AlertsHarness, monitorId: string) =>
  h.t.db
    .collection(COLLECTIONS.ALERTS)
    .find({ iMonitorId: new ObjectId(monitorId) })
    .sort({ dCreatedAt: 1, _id: 1 })
    .toArray();

describe('ONCE_WITH_RECOVERY (acceptance 2 and 3)', () => {
  it('stores exactly one STALE alert for a failing monitor, nothing more while it keeps failing, then one RECOVERED', async () => {
    const h = await startAlertsHarness(mongo);
    const { alerts, incidents } = h.t.services;
    const monitor = webhookSnapshot({ name: 'Razorpay webhooks' });

    const first = await alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });
    expect(first.openIncidentId).not.toBeNull();
    let stored = await alertsOf(h, monitor.monitorId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      eType: 'WEBHOOK_STALE',
      eStatus: 'PENDING',
      sSubject: '[payMonitor] WEBHOOK_STALE – Razorpay webhooks',
      sDedupeKey: `incident:${first.openIncidentId}:open`,
      dNextAttemptAt: h.clock.now(),
    });
    expect(stored[0]?.['sTextBody']).toContain('Razorpay');
    expect(stored[0]?.['sHtmlBody']).toContain('<table');

    for (let i = 0; i < 5; i++) {
      h.clock.advance(10 * MIN);
      const again = await alerts.processCheckOutcome({
        monitor,
        check: makeCheck(monitor, 'STALE', h.clock),
      });
      expect(again.openIncidentId).toBe(first.openIncidentId);
    }
    expect(await alertsOf(h, monitor.monitorId)).toHaveLength(1);

    h.clock.advance(10 * MIN);
    const recovered = await alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'OK', h.clock) });
    expect(recovered.openIncidentId).toBeNull();
    stored = await alertsOf(h, monitor.monitorId);
    expect(stored.map((a) => String(a['eType']))).toEqual(['WEBHOOK_STALE', 'RECOVERED']);
    expect(stored[1]).toMatchObject({
      sSubject: '[payMonitor] RECOVERED – Razorpay webhooks',
      sDedupeKey: `incident:${first.openIncidentId}:recovered`,
    });
    expect(stored[1]?.['sTextBody']).toContain('Downtime: 1 h');

    expect(await incidents.findOpen(monitor.monitorId)).toBeNull();
    const [closed] = await incidents.listForMonitor(monitor.monitorId);
    expect(closed).toMatchObject({ closeReason: 'RECOVERED', openingResult: 'STALE' });
    expect(closed?.closedAt).toEqual(h.clock.now());
  });

  it('resolves recipients when the alert is created: active normal + master, never an inactive one (acceptance 10)', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = webhookSnapshot();
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });
    const [alert] = await alertsOf(h, monitor.monitorId);
    const emails = (alert?.['aRecipients'] as { sEmail: string }[]).map((r) => r.sEmail).sort();
    expect(emails).toEqual(['master@x.test', 'ops@x.test']);

    // Recipients added later do not change an alert that already exists (FR-A5).
    await h.t.services.recipients.create({
      name: 'Late',
      email: 'late@x.test',
      type: 'NORMAL',
      isActive: true,
    });
    const [same] = await alertsOf(h, monitor.monitorId);
    expect((same?.['aRecipients'] as unknown[]).length).toBe(2);
  });

  it('a monitor that never fails produces no incident and no alert', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = webhookSnapshot();
    for (let i = 0; i < 3; i++) {
      h.clock.advance(10 * MIN);
      expect(
        (await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'OK', h.clock) }))
          .openIncidentId,
      ).toBeNull();
    }
    expect(await alertsOf(h, monitor.monitorId)).toHaveLength(0);
    expect(await h.t.services.incidents.findOpen(monitor.monitorId)).toBeNull();
  });
});

describe('storing without recipients (FR-A5)', () => {
  it('still stores the alert, as FAILED with the reason "no recipients"', async () => {
    const h = await startAlertsHarness(mongo, { recipients: false });
    const monitor = webhookSnapshot();
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });
    const [alert] = await alertsOf(h, monitor.monitorId);
    expect(alert).toMatchObject({
      eStatus: 'FAILED',
      sFailureReason: 'no recipients',
      dNextAttemptAt: null,
      aRecipients: [],
    });
  });
});

describe('EVERY_CHECK (acceptance 5, D5)', () => {
  it('emails every failing check, keeps an incident for history, and sends no recovery email', async () => {
    const h = await startAlertsHarness(mongo);
    const { alerts, incidents } = h.t.services;
    const monitor = endpointSnapshot({ alertMode: 'EVERY_CHECK' });
    for (let i = 0; i < 4; i++) {
      await alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'DOWN', h.clock) });
      h.clock.advance(5 * MIN);
    }
    expect(await alertsOf(h, monitor.monitorId)).toHaveLength(4);
    await alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'OK', h.clock) });
    const stored = await alertsOf(h, monitor.monitorId);
    expect(stored).toHaveLength(4);
    expect(stored.every((a) => a['eType'] === 'ENDPOINT_DOWN')).toBe(true);
    expect(await incidents.findOpen(monitor.monitorId)).toBeNull();
    expect(await incidents.listForMonitor(monitor.monitorId)).toHaveLength(1);
  });

  it('processing the same check twice creates one alert (dedupe key per check)', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = endpointSnapshot({ alertMode: 'EVERY_CHECK' });
    const check = makeCheck(monitor, 'DOWN', h.clock);
    await h.t.services.alerts.processCheckOutcome({ monitor, check });
    await h.t.services.alerts.processCheckOutcome({ monitor, check });
    expect(await alertsOf(h, monitor.monitorId)).toHaveLength(1);
  });
});

describe('REPEAT_EVERY (acceptance 6)', () => {
  it('a 1-hour outage with repeat 30 min and checks every 10 min sends 1 alert, 2 reminders and 1 RECOVERED', async () => {
    const h = await startAlertsHarness(mongo);
    const { alerts, incidents } = h.t.services;
    const monitor = webhookSnapshot({
      alertMode: 'REPEAT_EVERY',
      repeatIntervalMs: 30 * MIN,
      checkIntervalMs: 10 * MIN,
    });

    for (let minute = 0; minute <= 60; minute += 10) {
      await alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });
      h.clock.advance(10 * MIN);
    }
    // t = 70: the gateway recovers.
    await alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'OK', h.clock) });

    const stored = await alertsOf(h, monitor.monitorId);
    expect(stored.map((a) => String(a['eType']))).toEqual([
      'WEBHOOK_STALE',
      'WEBHOOK_STALE',
      'WEBHOOK_STALE',
      'RECOVERED',
    ]);
    const keys = stored.map((a) => String(a['sDedupeKey']));
    expect(keys[0]).toMatch(/:open$/);
    expect(keys[1]).toMatch(/:reminder:1$/);
    expect(keys[2]).toMatch(/:reminder:2$/);
    expect(keys[3]).toMatch(/:recovered$/);

    expect(stored[1]?.['sTextBody']).toContain('Reminder: #1');
    expect(stored[1]?.['sTextBody']).toContain('Incident open for: 30 min');
    expect(stored[1]?.['sTextBody']).toContain('Earlier reminders: 0');
    expect(stored[2]?.['sTextBody']).toContain('Reminder: #2');
    expect(stored[2]?.['sTextBody']).toContain('Incident open for: 1 h');
    expect(stored[2]?.['sTextBody']).toContain('Earlier reminders: 1');
    expect(stored[3]?.['sTextBody']).toContain('Downtime: 1 h 10 min');

    const [incident] = await incidents.listForMonitor(monitor.monitorId);
    expect(incident?.reminderCount).toBe(2);
  });
});

describe('failure type changes inside one incident (D4)', () => {
  it('STALE then NO_DATA: same incident, no second "open" email', async () => {
    const h = await startAlertsHarness(mongo);
    const { alerts } = h.t.services;
    const monitor = webhookSnapshot();
    const a = await alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });
    h.clock.advance(10 * MIN);
    const b = await alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'NO_DATA', h.clock) });
    expect(b.openIncidentId).toBe(a.openIncidentId);
    expect(await alertsOf(h, monitor.monitorId)).toHaveLength(1);
  });

  it('a reminder uses the alert type of the current result', async () => {
    const h = await startAlertsHarness(mongo);
    const { alerts } = h.t.services;
    const monitor = webhookSnapshot({ alertMode: 'REPEAT_EVERY', repeatIntervalMs: 30 * MIN });
    await alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });
    h.clock.advance(30 * MIN);
    await alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'NO_DATA', h.clock) });
    const stored = await alertsOf(h, monitor.monitorId);
    expect(stored.map((a) => String(a['eType']))).toEqual(['WEBHOOK_STALE', 'WEBHOOK_NO_DATA']);
    expect(stored[1]?.['sTextBody']).toContain('Reminder: #1');
  });
});

describe('endpoint alerts (FR-E3)', () => {
  it('ENDPOINT_DOWN lists every attempt and uses the masked URL', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = endpointSnapshot();
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'DOWN', h.clock) });
    const [alert] = await alertsOf(h, monitor.monitorId);
    expect(alert).toMatchObject({
      eType: 'ENDPOINT_DOWN',
      sSubject: '[payMonitor] ENDPOINT_DOWN – Subscription API – prod',
    });
    const text = String(alert?.['sTextBody']);
    for (const value of ['Attempts: 3', 'HTTP 502 (80 ms)', 'The request timed out (10000 ms)', 'token=***'])
      expect(text).toContain(value);
    expect(text).not.toContain('SECRET');
  });
});

describe('source outage (acceptance 7, FR-A4a)', () => {
  it('groups simultaneous failures into ONE incident and ONE masters-only MONITOR_ERROR alert', async () => {
    const h = await startAlertsHarness(mongo);
    const { alerts, incidents } = h.t.services;
    const [m1, m2, m3] = [
      webhookSnapshot({ name: 'Razorpay' }),
      webhookSnapshot({ name: 'Apple Pay' }),
      webhookSnapshot({ name: 'Google Play' }),
    ];

    // Monitor 1 already has its own incident: the outage must not touch it.
    const own = await alerts.processCheckOutcome({ monitor: m1, check: makeCheck(m1, 'STALE', h.clock) });
    const ownBefore = await incidents.findOpen(m1.monitorId);

    for (const m of [m1, m2, m3]) {
      await alerts.handleSourceError({ monitor: m, check: makeCheck(m, 'ERROR', h.clock) });
      h.clock.advance(1000);
    }

    const outage = await incidents.findOpenSourceError();
    expect(outage?.affectedMonitorIds.sort()).toEqual([m1.monitorId, m2.monitorId, m3.monitorId].sort());
    const all = await h.t.db.collection(COLLECTIONS.ALERTS).find({ eType: 'MONITOR_ERROR' }).toArray();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      eStatus: 'PENDING',
      iMonitorId: null,
      sSubject: '[payMonitor] MONITOR_ERROR – Source DB (3 monitors)',
      sDedupeKey: `sourceError:${outage?.id}:open`,
    });
    expect((all[0]?.['aRecipients'] as { sEmail: string }[]).map((r) => r.sEmail)).toEqual(['master@x.test']);
    const body = String(all[0]?.['sTextBody']);
    for (const name of ['Razorpay', 'Apple Pay', 'Google Play']) expect(body).toContain(name);
    // The first email waits for the grouping window so all affected monitors can share it (D6).
    expect(all[0]?.['dNextAttemptAt']).toEqual(new Date((outage?.openedAt.getTime() ?? 0) + 60_000));

    // Monitor-level state is untouched: its own incident is still open and unchanged.
    expect(await incidents.findOpen(m1.monitorId)).toMatchObject({
      id: own.openIncidentId,
      lastAlertAt: ownBefore?.lastAlertAt,
    });
    expect(await alertsOf(h, m1.monitorId)).toHaveLength(1);
  });

  it('a monitor failing after the outage email was sent joins the incident only: no second email', async () => {
    const h = await startAlertsHarness(mongo);
    const { alerts, incidents } = h.t.services;
    const [m1, m2] = [webhookSnapshot({ name: 'First' }), webhookSnapshot({ name: 'Late' })];
    await alerts.handleSourceError({ monitor: m1, check: makeCheck(m1, 'ERROR', h.clock) });
    await h.t.db
      .collection(COLLECTIONS.ALERTS)
      .updateOne({ eType: 'MONITOR_ERROR' }, { $set: { eStatus: 'SENT' } });
    h.clock.advance(5 * MIN);
    await alerts.handleSourceError({ monitor: m2, check: makeCheck(m2, 'ERROR', h.clock) });
    await alerts.handleSourceError({ monitor: m2, check: makeCheck(m2, 'ERROR', h.clock) });

    expect((await incidents.findOpenSourceError())?.affectedMonitorIds).toHaveLength(2);
    const stored = await h.t.db.collection(COLLECTIONS.ALERTS).find({ eType: 'MONITOR_ERROR' }).toArray();
    expect(stored).toHaveLength(1);
    expect(String(stored[0]?.['sTextBody'])).not.toContain('Late');
  });

  it('a monitor joining while the email is still pending is added to that email', async () => {
    const h = await startAlertsHarness(mongo);
    const [m1, m2] = [webhookSnapshot({ name: 'First' }), webhookSnapshot({ name: 'Second' })];
    await h.t.services.alerts.handleSourceError({ monitor: m1, check: makeCheck(m1, 'ERROR', h.clock) });
    await h.t.services.alerts.handleSourceError({ monitor: m2, check: makeCheck(m2, 'ERROR', h.clock) });
    const [alert] = await h.t.db.collection(COLLECTIONS.ALERTS).find({ eType: 'MONITOR_ERROR' }).toArray();
    expect(alert?.['sSubject']).toBe('[payMonitor] MONITOR_ERROR – Source DB (2 monitors)');
    expect(String(alert?.['sTextBody'])).toContain('Second');
  });

  it('concurrent failures create one alert and lose no monitor', async () => {
    const h = await startAlertsHarness(mongo);
    const monitors = Array.from({ length: 6 }, (_, i) => webhookSnapshot({ name: `M${i}` }));
    await Promise.all(
      monitors.map((m) =>
        h.t.services.alerts.handleSourceError({ monitor: m, check: makeCheck(m, 'ERROR', h.clock) }),
      ),
    );
    expect((await h.t.services.incidents.findOpenSourceError())?.affectedMonitorIds).toHaveLength(6);
    expect(await h.t.db.collection(COLLECTIONS.ALERTS).countDocuments({ eType: 'MONITOR_ERROR' })).toBe(1);
  });

  it('monitors joining concurrently are ALL listed in the one stored outage email (review M2)', async () => {
    const h = await startAlertsHarness(mongo);
    const first = webhookSnapshot({ name: 'First' });
    await h.t.services.alerts.handleSourceError({
      monitor: first,
      check: makeCheck(first, 'ERROR', h.clock),
    });
    const joining = Array.from({ length: 5 }, (_, i) => webhookSnapshot({ name: `Joiner ${i}` }));
    await Promise.all(
      joining.map((m) =>
        h.t.services.alerts.handleSourceError({ monitor: m, check: makeCheck(m, 'ERROR', h.clock) }),
      ),
    );
    const alert = await h.t.db.collection(COLLECTIONS.ALERTS).findOne({ eType: 'MONITOR_ERROR' });
    expect((alert?.['aAffectedMonitors'] as unknown[]).length).toBe(6);
    expect(alert?.['sSubject']).toBe('[payMonitor] MONITOR_ERROR – Source DB (6 monitors)');
    for (const m of [first, ...joining]) expect(alert?.['sTextBody']).toContain(m.name);
  });

  it('the first successful read ends the outage: one RECOVERED to masters only, the outage mail sent first', async () => {
    const h = await startAlertsHarness(mongo);
    const { alerts, incidents } = h.t.services;
    const [m1, m2] = [webhookSnapshot({ name: 'Razorpay' }), webhookSnapshot({ name: 'Apple Pay' })];
    await alerts.handleSourceError({ monitor: m1, check: makeCheck(m1, 'ERROR', h.clock) });
    await alerts.handleSourceError({ monitor: m2, check: makeCheck(m2, 'ERROR', h.clock) });
    const outage = await incidents.findOpenSourceError();

    // Recovery inside the 60 s grouping window: the outage mail has not been sent yet.
    h.clock.advance(10_000);
    const result = await alerts.processCheckOutcome({ monitor: m1, check: makeCheck(m1, 'OK', h.clock) });
    expect(result.openIncidentId).toBeNull();

    expect(await incidents.findOpenSourceError()).toBeNull();
    const stored = await h.t.db
      .collection(COLLECTIONS.ALERTS)
      .find({ iMonitorId: null })
      .sort({ dNextAttemptAt: 1 })
      .toArray();
    expect(stored.map((a) => String(a['eType']))).toEqual(['MONITOR_ERROR', 'RECOVERED']);
    expect(stored[1]).toMatchObject({
      sSubject: '[payMonitor] RECOVERED – Source DB',
      sDedupeKey: `sourceError:${outage?.id}:recovered`,
    });
    expect((stored[1]?.['aRecipients'] as { sEmail: string }[]).map((r) => r.sEmail)).toEqual([
      'master@x.test',
    ]);
    expect(String(stored[1]?.['sTextBody'])).toContain('Downtime: 10 s');
    expect(String(stored[1]?.['sTextBody'])).toContain('Apple Pay');
    // The outage mail, still waiting for its grouping window, is made due now so it goes out BEFORE the recovery mail.
    expect(stored[0]?.['dNextAttemptAt']).toEqual(h.clock.now());
    expect((stored[1]?.['dNextAttemptAt'] as Date).getTime()).toBeGreaterThan(
      (stored[0]?.['dNextAttemptAt'] as Date).getTime(),
    );
  });

  it('a STALE result also proves the source is back (the gateway problem is then handled normally)', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = webhookSnapshot();
    await h.t.services.alerts.handleSourceError({ monitor, check: makeCheck(monitor, 'ERROR', h.clock) });
    h.clock.advance(MIN);
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });
    expect(await h.t.services.incidents.findOpenSourceError()).toBeNull();
    expect(await alertsOf(h, monitor.monitorId)).toHaveLength(1);
  });

  it('an endpoint check says nothing about the source database', async () => {
    const h = await startAlertsHarness(mongo);
    const web = webhookSnapshot();
    const endpoint = endpointSnapshot();
    await h.t.services.alerts.handleSourceError({ monitor: web, check: makeCheck(web, 'ERROR', h.clock) });
    await h.t.services.alerts.processCheckOutcome({
      monitor: endpoint,
      check: makeCheck(endpoint, 'OK', h.clock),
    });
    expect(await h.t.services.incidents.findOpenSourceError()).not.toBeNull();
  });

  it("a monitor's OWN ERROR goes through its alert rules to all recipients and does not end an outage (TD-29)", async () => {
    const h = await startAlertsHarness(mongo);
    const other = webhookSnapshot({ name: 'Other' });
    await h.t.services.alerts.handleSourceError({
      monitor: other,
      check: makeCheck(other, 'ERROR', h.clock),
    });
    const monitor = webhookSnapshot({ name: 'Razorpay webhooks' });

    const own = makeCheck(monitor, 'ERROR', h.clock);
    const result = await h.t.services.alerts.processCheckOutcome({ monitor, check: own });

    expect(result.openIncidentId).not.toBeNull();
    const stored = await h.t.db
      .collection(COLLECTIONS.ALERTS)
      .find({ iMonitorId: new ObjectId(monitor.monitorId) })
      .toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      eType: 'MONITOR_ERROR',
      sSubject: '[payMonitor] MONITOR_ERROR – Razorpay webhooks',
    });
    expect((stored[0]?.['aRecipients'] as { sEmail: string }[]).map((r) => r.sEmail).sort()).toEqual([
      'master@x.test',
      'ops@x.test',
    ]);
    // The grouped outage opened by the other monitor is still open.
    expect(await h.t.services.incidents.findOpenSourceError()).not.toBeNull();
  });
});

describe('test email (FR-D3)', () => {
  it('stores a TEST alert for all current recipients, like any other alert', async () => {
    const h = await startAlertsHarness(mongo);
    const monitor = webhookSnapshot({ name: 'Razorpay webhooks' });
    const alert = await h.t.services.alerts.sendTestEmail(monitor, h.actor);
    expect(alert).toMatchObject({
      type: 'TEST',
      status: 'PENDING',
      subject: '[payMonitor] TEST – Razorpay webhooks',
      monitorId: monitor.monitorId,
    });
    expect(alert.dedupeKey).toMatch(/^test:/);
    expect(alert.recipients.map((r) => r.email).sort()).toEqual(['master@x.test', 'ops@x.test']);
    const stored = await h.t.db.collection(COLLECTIONS.ALERTS).findOne({ _id: new ObjectId(alert.id) });
    expect(String(stored?.['sTextBody'])).toContain(h.actor.email);
    const second = await h.t.services.alerts.sendTestEmail(monitor, h.actor);
    expect(second.id).not.toBe(alert.id);
  });
});

describe('resend (FR-A2)', () => {
  async function failedAlert(h: AlertsHarness) {
    const monitor = webhookSnapshot();
    const alert = await h.t.services.alerts.sendTestEmail(monitor, h.actor);
    await h.t.db.collection(COLLECTIONS.ALERTS).updateOne(
      { _id: new ObjectId(alert.id) },
      {
        $set: {
          eStatus: 'FAILED',
          sFailureReason: 'The mail server could not be reached',
          nRetryIndex: 3,
          dNextAttemptAt: null,
        },
      },
    );
    return alert;
  }

  it('moves FAILED to PENDING, resets the retry counter, keeps the stored recipients, and audits it', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await failedAlert(h);
    const requeued = await h.t.services.alerts.resend(alert.id, h.actor);
    expect(requeued).toMatchObject({ status: 'PENDING', retryIndex: 0, failureReason: null });
    expect(requeued.nextAttemptAt).toEqual(h.clock.now());
    expect(requeued.recipients).toHaveLength(2);
    expect(
      await h.t.db
        .collection(COLLECTIONS.AUDIT_LOGS)
        .countDocuments({ eAction: 'RESEND', eEntityType: 'ALERT', iEntityId: new ObjectId(alert.id) }),
    ).toBe(1);
  });

  it('works only from FAILED: a second resend and a resend of a SENT alert are conflicts', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await failedAlert(h);
    await h.t.services.alerts.resend(alert.id, h.actor);
    await expect(h.t.services.alerts.resend(alert.id, h.actor)).rejects.toMatchObject({ httpStatus: 409 });
    await h.t.db
      .collection(COLLECTIONS.ALERTS)
      .updateOne({ _id: new ObjectId(alert.id) }, { $set: { eStatus: 'SENT' } });
    await expect(h.t.services.alerts.resend(alert.id, h.actor)).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('answers NotFound for an unknown alert', async () => {
    const h = await startAlertsHarness(mongo);
    await expect(h.t.services.alerts.resend(new ObjectId().toHexString(), h.actor)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('D18: an alert stored with no recipients looks for recipients again, and stays FAILED if there are still none', async () => {
    const h = await startAlertsHarness(mongo, { recipients: false });
    const monitor = webhookSnapshot();
    await h.t.services.alerts.processCheckOutcome({ monitor, check: makeCheck(monitor, 'STALE', h.clock) });
    const [stored] = await alertsOf(h, monitor.monitorId);
    const id = String(stored?.['_id']);
    await expect(h.t.services.alerts.resend(id, h.actor)).rejects.toMatchObject({ httpStatus: 409 });
    expect((await alertsOf(h, monitor.monitorId))[0]?.['eStatus']).toBe('FAILED');

    await h.t.services.recipients.create({
      name: 'Master',
      email: 'master@x.test',
      type: 'MASTER',
      isActive: true,
    });
    const requeued = await h.t.services.alerts.resend(id, h.actor);
    expect(requeued).toMatchObject({ status: 'PENDING' });
    expect(requeued.recipients.map((r) => r.email)).toEqual(['master@x.test']);
  });
});

describe('listing', () => {
  it('filters by monitor, type, status and date range, newest first, without bodies', async () => {
    const h = await startAlertsHarness(mongo);
    const { alerts } = h.t.services;
    const a = webhookSnapshot({ name: 'A' });
    const b = endpointSnapshot({ name: 'B', alertMode: 'EVERY_CHECK' });
    await alerts.processCheckOutcome({ monitor: a, check: makeCheck(a, 'STALE', h.clock) });
    h.clock.advance(HOUR);
    for (let i = 0; i < 3; i++) {
      await alerts.processCheckOutcome({ monitor: b, check: makeCheck(b, 'DOWN', h.clock) });
      h.clock.advance(MIN);
    }
    const all = await alerts.list({}, { limit: 50 });
    expect(all.items).toHaveLength(4);
    expect(JSON.stringify(all.items)).not.toContain('<table');
    expect(all.items[0]).not.toHaveProperty('textBody');
    expect((await alerts.list({ monitorId: b.monitorId })).items).toHaveLength(3);
    expect((await alerts.list({ type: 'WEBHOOK_STALE' })).items).toHaveLength(1);
    expect((await alerts.list({ status: 'FAILED' })).items).toHaveLength(0);
    expect((await alerts.list({ from: new Date(h.clock.now().getTime() - 10 * MIN) })).items).toHaveLength(3);
    const page1 = await alerts.list({}, { limit: 3 });
    expect(page1.items).toHaveLength(3);
    const page2 = await alerts.list(
      {},
      { limit: 3, ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}) },
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
    expect((await alerts.listForMonitor(b.monitorId)).length).toBe(3);
    expect(await alerts.countFailed()).toBe(0);
  });
});
