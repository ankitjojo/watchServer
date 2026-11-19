import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { ADMIN, VIEWER, csrfFor, startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;
let server: Server;
let base: string;
let actor: { id: string; email: string };

async function waitFor(condition: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(req.url === '/fail' ? 500 : 200).end('x');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mongo = await startTestMongo();
  t = await startTestApp({ mongo, config: { ACTION_RATE_LIMIT: '30 per 1 min' } });
  await t.services.recipients.create({
    name: 'Master',
    email: 'master@x.test',
    type: 'MASTER',
    isActive: true,
  });
  const admin = (await t.services.users.list()).find((u) => u.role === 'ADMIN');
  actor = { id: admin?.id ?? '', email: admin?.email ?? '' };
  await t.sourceDb
    .collection('wh_ok')
    .insertOne({ dCreatedAt: new Date(Date.now() - 60_000), secret: 'SECRET' });
  await t.sourceDb.collection('wh_ok').createIndex({ dCreatedAt: -1 });
}, 180_000);

afterAll(async () => {
  await t.services.scheduler.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await mongo.stop();
});

const webhook = (name: string) =>
  t.services.webhookMonitors.create(
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
  );
const endpoint = (name: string, path = '/ok') =>
  t.services.endpointMonitors.create(
    {
      serverName: name,
      url: `${base}${path}`,
      checkInterval: { value: 5, unit: 'MINUTE' },
      retryCount: 0,
      alertMode: 'ONCE_WITH_RECOVERY',
      isEnabled: true,
    },
    actor,
  );
const checksOf = (id: string) =>
  t.db.collection(COLLECTIONS.CHECKS).countDocuments({ iMonitorId: new ObjectId(id) });
const stateOf = async (id: string) => (await t.services.webhookMonitors.getById(id)).state;

describe('run check now (FR-D3)', () => {
  it('answers 409 SCHEDULER_STANDBY while this instance does not hold the lease', async () => {
    const { monitor } = await webhook('Standby');
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const res = await admin.post(`/api/v1/monitors/webhook/${monitor.id}/run`).set('x-csrf-token', token);
    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('error.code', 'SCHEDULER_STANDBY');
  });

  it('runs the check, returns the result inline and stores it as MANUAL', async () => {
    await t.services.scheduler.start();
    const { monitor } = await webhook('Manual run');
    await waitFor(async () => (await checksOf(monitor.id)) >= 1); // the first scheduled check after create
    const before = await checksOf(monitor.id);
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const res = await admin.post(`/api/v1/monitors/webhook/${monitor.id}/run`).set('x-csrf-token', token);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data.result', 'OK');
    expect(res.body).toHaveProperty('data.trigger', 'MANUAL');
    expect(res.body).toHaveProperty('data.startedAtUtc');
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(await checksOf(monitor.id)).toBe(before + 1);
    expect((await stateOf(monitor.id)).lastResult).toBe('OK');
  });

  it('works for an endpoint monitor and shows each attempt', async () => {
    const monitor = await endpoint('Endpoint run', '/fail');
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const res = await admin.post(`/api/v1/monitors/endpoint/${monitor.id}/run`).set('x-csrf-token', token);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data.result', 'DOWN');
    expect(res.body).toHaveProperty('data.endpoint.attempts.0.statusCode', 500);
  });

  it('answers 404 for an unknown monitor and 400 for a bad type or id', async () => {
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const post = (path: string) => admin.post(path).set('x-csrf-token', token);
    expect((await post(`/api/v1/monitors/webhook/${new ObjectId().toHexString()}/run`)).status).toBe(404);
    expect((await post(`/api/v1/monitors/server/${new ObjectId().toHexString()}/run`)).status).toBe(400);
    expect((await post('/api/v1/monitors/webhook/not-an-id/run')).status).toBe(400);
  });

  it('is rate limited per user (api-standards 6)', async () => {
    const limited = await startTestApp({ mongo, config: { ACTION_RATE_LIMIT: '2 per 1 min' } });
    const admin = await limited.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const url = `/api/v1/monitors/webhook/${new ObjectId().toHexString()}/run`;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await admin.post(url).set('x-csrf-token', token)).status);
    expect(statuses[2]).toBe(429);
  });
});

describe('pause and resume (FR-D3)', () => {
  it('pausing unschedules the monitor, keeps an open incident open and is audited; it is idempotent', async () => {
    await t.services.scheduler.start();
    const { monitor } = await webhook('Pausable');
    // The first scheduled check (fresh data = OK) must be finished first, or it could legitimately close the incident we open next.
    await waitFor(async () => (await stateOf(monitor.id)).lastResult !== null);
    const incident = await t.services.incidents.open({
      monitorId: monitor.id,
      openingResult: 'STALE',
      checkId: new ObjectId().toHexString(),
    });

    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const res = await admin.post(`/api/v1/monitors/webhook/${monitor.id}/pause`).set('x-csrf-token', token);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data.isEnabled', false);
    expect((await t.services.webhookMonitors.getById(monitor.id)).isEnabled).toBe(false);
    await waitFor(async () => (await stateOf(monitor.id)).nextCheckAt === null);
    expect(await t.services.incidents.findOpen(monitor.id)).toMatchObject({ id: incident.id });

    expect(
      (await admin.post(`/api/v1/monitors/webhook/${monitor.id}/pause`).set('x-csrf-token', token)).status,
    ).toBe(200);
    expect(
      await t.db
        .collection(COLLECTIONS.AUDIT_LOGS)
        .countDocuments({ eAction: 'PAUSE', iEntityId: new ObjectId(monitor.id) }),
    ).toBe(1);

    // A check that was already running when we paused may still finish, so wait until the count is stable.
    let checks = await checksOf(monitor.id);
    await waitFor(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const now = await checksOf(monitor.id);
      const stable = now === checks;
      checks = now;
      return stable;
    });
    // No scheduled run happens while paused.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await checksOf(monitor.id)).toBe(checks);
  });

  it('resuming runs a check at once and records the next check time', async () => {
    await t.services.scheduler.start();
    const { monitor } = await webhook('Resumable');
    await t.services.webhookMonitors.setEnabled(monitor.id, false, actor);
    await waitFor(async () => (await stateOf(monitor.id)).nextCheckAt === null);
    const before = await checksOf(monitor.id);

    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const res = await admin.post(`/api/v1/monitors/webhook/${monitor.id}/resume`).set('x-csrf-token', token);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data.isEnabled', true);
    await waitFor(async () => (await checksOf(monitor.id)) > before);
    await waitFor(async () => (await stateOf(monitor.id)).nextCheckAt !== null);
    expect(
      await t.db
        .collection(COLLECTIONS.AUDIT_LOGS)
        .countDocuments({ eAction: 'RESUME', iEntityId: new ObjectId(monitor.id) }),
    ).toBe(1);
  });

  it('works for endpoint monitors too', async () => {
    const monitor = await endpoint('Endpoint pause');
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    expect(
      (await admin.post(`/api/v1/monitors/endpoint/${monitor.id}/pause`).set('x-csrf-token', token)).body,
    ).toHaveProperty('data.isEnabled', false);
    expect((await t.services.endpointMonitors.getById(monitor.id)).isEnabled).toBe(false);
  });
});

describe('test email (FR-D3)', () => {
  it('stores a TEST alert and answers 202 "queued"', async () => {
    const { monitor } = await webhook('Mail test');
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const res = await admin
      .post(`/api/v1/monitors/webhook/${monitor.id}/test-email`)
      .set('x-csrf-token', token);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, data: { status: 'queued' } });
    const stored = await t.db
      .collection(COLLECTIONS.ALERTS)
      .findOne({ _id: new ObjectId((res.body as { data: { alertId: string } }).data.alertId) });
    expect(stored).toMatchObject({
      eType: 'TEST',
      eStatus: 'PENDING',
      sSubject: '[payMonitor] TEST – Mail test',
    });
  });
});

describe('history and charts (viewer allowed)', () => {
  it('lists checks newest first with filters and a cursor', async () => {
    const { monitor } = await webhook('History');
    await t.services.scheduler.start();
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    await waitFor(async () => (await checksOf(monitor.id)) >= 1);
    for (let i = 0; i < 2; i++)
      await admin.post(`/api/v1/monitors/webhook/${monitor.id}/run`).set('x-csrf-token', token);

    const viewer = await t.loginAs(VIEWER);
    const first = await viewer.get(`/api/v1/monitors/webhook/${monitor.id}/checks?limit=2`);
    expect(first.status).toBe(200);
    expect((first.body as { data: unknown[] }).data).toHaveLength(2);
    expect(first.body).toHaveProperty('meta.nextCursor');
    const nextCursor = (first.body as { meta: { nextCursor: string } }).meta.nextCursor;
    const second = await viewer.get(
      `/api/v1/monitors/webhook/${monitor.id}/checks?limit=2&cursor=${encodeURIComponent(nextCursor)}`,
    );
    expect((second.body as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(1);
    expect(
      (await viewer.get(`/api/v1/monitors/webhook/${monitor.id}/checks?result=STALE`)).body,
    ).toHaveProperty('data', []);
    expect((await viewer.get(`/api/v1/monitors/webhook/${monitor.id}/checks?bogus=1`)).status).toBe(400);
    expect((await viewer.get(`/api/v1/monitors/webhook/${monitor.id}/checks?result=NOPE`)).status).toBe(400);
    expect((await viewer.get(`/api/v1/monitors/webhook/${monitor.id}/checks?cursor=garbage`)).status).toBe(
      400,
    );
  });

  it('serves chart series with the threshold line for webhook monitors', async () => {
    const { monitor } = await webhook('Series');
    await t.services.scheduler.start();
    await waitFor(async () => (await checksOf(monitor.id)) >= 1);
    const viewer = await t.loginAs(VIEWER);
    const res = await viewer.get(`/api/v1/monitors/webhook/${monitor.id}/series?range=24h`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data.thresholdMs', 2 * 3_600_000);
    const points = (res.body as { data: { points: { t: string; value: number }[] } }).data.points;
    expect(points.length).toBeGreaterThanOrEqual(1);
    expect(new Date(points[0]?.t ?? '').toString()).not.toBe('Invalid Date');
  });

  it('serves response time and up/down for endpoint monitors', async () => {
    const monitor = await endpoint('Endpoint series');
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    await t.services.scheduler.start();
    await admin.post(`/api/v1/monitors/endpoint/${monitor.id}/run`).set('x-csrf-token', token);
    const res = await admin.get(`/api/v1/monitors/endpoint/${monitor.id}/series?range=7d`);
    expect(res.status).toBe(200);
    const points = (res.body as { data: { points: { isUp: boolean }[] } }).data.points;
    expect(points.some((p) => p.isUp)).toBe(true);
    expect(res.body).not.toHaveProperty('data.thresholdMs');
  });

  it.each([
    ['range=custom', 400],
    ['range=custom&from=2026-11-10T00:00:00Z', 400],
    ['range=custom&from=2026-11-10T00:00:00Z&to=2026-11-01T00:00:00Z', 400],
    ['range=custom&from=2026-01-01T00:00:00Z&to=2026-11-01T00:00:00Z', 400],
    ['range=90d', 400],
    ['', 400],
    ['range=custom&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z', 200],
  ])('series query "%s" -> %d', async (query, status) => {
    const { monitor } = await webhook(`Range ${query.length}-${status}-${Math.random()}`);
    const viewer = await t.loginAs(VIEWER);
    expect((await viewer.get(`/api/v1/monitors/webhook/${monitor.id}/series?${query}`)).status).toBe(status);
  });

  it('needs a session', async () => {
    const { monitor } = await webhook('Anon');
    expect((await t.anonymous().get(`/api/v1/monitors/webhook/${monitor.id}/checks`)).status).toBe(401);
  });
});

describe('action buttons on the detail page', () => {
  it('admins see them with the monitor id, viewers do not, and the script is a same-origin file (CSP)', async () => {
    const { monitor } = await webhook('Buttons');
    const admin = await t.loginAs(ADMIN);
    const adminPage = await admin.get(`/webhook-monitors/${monitor.id}`);
    expect(adminPage.text).toContain('id="monitor-actions"');
    expect(adminPage.text).toContain(`data-monitor-id="${monitor.id}"`);
    for (const action of ['run', 'pause', 'test-email'])
      expect(adminPage.text).toContain(`data-action="${action}"`);
    expect(adminPage.text).not.toContain('data-action="resume"');
    expect(adminPage.text).toContain('<script src="/public/js/monitorActions.js" defer></script>');
    expect(adminPage.text).not.toMatch(/\son(click|submit|load)=/i);

    await t.services.webhookMonitors.setEnabled(monitor.id, false, actor);
    expect((await admin.get(`/webhook-monitors/${monitor.id}`)).text).toContain('data-action="resume"');

    const viewer = await t.loginAs(VIEWER);
    const viewerPage = await viewer.get(`/webhook-monitors/${monitor.id}`);
    expect(viewerPage.text).not.toContain('monitor-actions');
    expect(viewerPage.text).not.toContain('data-action=');
  });

  it('the script itself is served as a static file', async () => {
    const res = await t.anonymous().get('/public/js/monitorActions.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/api/v1/monitors/');
  });
});
