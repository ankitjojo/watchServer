import { COLLECTIONS } from '../../../src/constants/collections.js';
import { ObjectId } from 'mongodb';
import { createAlertsRepository } from '../../../src/modules/alerts/alerts.repository.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { ADMIN, VIEWER, startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;
let actor: { id: string; email: string };
let webhookId: string;
let endpointId: string;
let failedAlertId: string;

beforeAll(async () => {
  mongo = await startTestMongo();
  t = await startTestApp({ mongo });
  const admin = (await t.services.users.list()).find((u) => u.role === 'ADMIN');
  actor = { id: admin?.id ?? '', email: admin?.email ?? '' };
  await t.services.recipients.create({
    name: 'Master',
    email: 'master@x.test',
    type: 'MASTER',
    isActive: true,
  });
  await t.sourceDb.collection('wh').insertOne({ dCreatedAt: new Date(Date.now() - 3 * 3_600_000) });
  await t.sourceDb.collection('wh').createIndex({ dCreatedAt: -1 });

  const { monitor } = await t.services.webhookMonitors.create(
    {
      name: 'Razorpay <b>webhooks</b>',
      gatewayName: 'Razorpay',
      sourceCollection: 'wh',
      timestampKey: 'dCreatedAt',
      checkInterval: { value: 10, unit: 'MINUTE' },
      threshold: { value: 1, unit: 'HOUR' },
      alertMode: 'ONCE_WITH_RECOVERY',
      isEnabled: true,
    },
    actor,
  );
  webhookId = monitor.id;
  const ep = await t.services.endpointMonitors.create(
    {
      serverName: 'Subscription API',
      url: 'http://127.0.0.1:1/health?token=SECRET',
      checkInterval: { value: 5, unit: 'MINUTE' },
      retryCount: 0,
      alertMode: 'ONCE_WITH_RECOVERY',
      isEnabled: true,
    },
    actor,
  );
  endpointId = ep.id;
  // A stale check creates an incident and an alert (real runner + real alerts service).
  await t.services.runners.WEBHOOK.run(webhookId, 'MANUAL');
  await t.services.runners.ENDPOINT.run(endpointId, 'MANUAL');
  const alert = await t.services.alerts.sendTestEmail(
    {
      monitorType: 'WEBHOOK',
      monitorId: webhookId,
      name: 'Razorpay <b>webhooks</b>',
      checkIntervalMs: 600_000,
      alertMode: 'ONCE_WITH_RECOVERY',
    },
    actor,
  );
  failedAlertId = alert.id;
  // The dispatcher writes outcomes only under its claim (review M6): take one as the test.
  await t.db
    .collection(COLLECTIONS.ALERTS)
    .updateOne({ _id: new ObjectId(alert.id) }, { $set: { sClaimId: 'test-claim' } });
  await createAlertsRepository(t.db).markFailed(alert.id, 'test-claim', {
    at: new Date(),
    reason: 'The mail server could not be reached',
    attempt: { dAt: new Date(), bIsSuccess: false },
  });
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

const pages = (): [string, string, string][] => [
  ['/', 'Overview', 'overview'],
  ['/webhook-monitors', 'Webhook monitors', 'webhook list'],
  [`/webhook-monitors/${webhookId}`, 'Razorpay', 'webhook detail'],
  ['/endpoint-monitors', 'Endpoint monitors', 'endpoint list'],
  [`/endpoint-monitors/${endpointId}`, 'Subscription API', 'endpoint detail'],
  ['/alerts', 'Alerts', 'alert log'],
];

describe('every page renders for admins and viewers (FR-D1..D7)', () => {
  it.each([ADMIN, VIEWER].flatMap((who) => [0, 1, 2, 3, 4, 5].map((i) => [who.email, i] as const)))(
    '%s page #%i',
    async (email, index) => {
      const agent = await t.loginAs(email === ADMIN.email ? ADMIN : VIEWER);
      const [path, heading] = pages()[index] ?? ['/', ''];
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/<h1[^>]*>/);
      expect(res.text).toContain(heading);
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );
});

describe('overview', () => {
  it('shows the six cards and a table with real monitor data', async () => {
    const res = await (await t.loginAs(VIEWER)).get('/');
    for (const label of ['Monitors', 'OK', 'Failing', 'Paused', 'Open incidents', 'Emails failed'])
      expect(res.text).toContain(`>${label}</span>`);
    expect(res.text).toContain('Subscription API');
    expect(res.text).toMatch(/badge-stale/);
    expect(res.text).toMatch(/badge-down/);
    expect(res.text).toContain('UTC');
  });

  it('escapes monitor names', async () => {
    const res = await (await t.loginAs(ADMIN)).get('/');
    expect(res.text).not.toContain('<b>webhooks</b>');
    expect(res.text).toContain('&lt;b&gt;webhooks&lt;/b&gt;');
  });
});

describe('monitor detail (FR-D4)', () => {
  it('shows history, incidents, alerts and the chart settings', async () => {
    const res = await (await t.loginAs(VIEWER)).get(`/webhook-monitors/${webhookId}`);
    expect(res.text).toContain('<h2>History</h2>');
    expect(res.text).toContain('<h2>Incidents</h2>');
    expect(res.text).toContain('<h2>Alerts and emails</h2>');
    expect(res.text).toContain('Newest document');
    expect(res.text).toContain('ongoing');
    expect(res.text).toContain('WEBHOOK_STALE');
    expect(res.text).toContain('id="chart-root"');
    expect(res.text).toContain(`/api/v1/monitors/webhook/${webhookId}/series`);
    expect(res.text).toContain('&#34;thresholdMs&#34;:3600000');
    for (const src of ['/vendor/chart.js/chart.umd.js', '/public/js/charts.js'])
      expect(res.text).toContain(`<script src="${src}" defer></script>`);
    expect(res.text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it('serves the chart library and scripts from our own origin', async () => {
    const agent = t.anonymous();
    for (const path of [
      '/vendor/chart.js/chart.umd.js',
      '/public/js/charts.js',
      '/public/js/alertActions.js',
    ]) {
      expect((await agent.get(path)).status).toBe(200);
    }
  });

  it('endpoint detail lists each attempt result, masks the URL and has no threshold line', async () => {
    const res = await (await t.loginAs(VIEWER)).get(`/endpoint-monitors/${endpointId}`);
    expect(res.text).toContain('Response time and availability');
    expect(res.text).toContain('token=***');
    expect(res.text).not.toContain('SECRET');
    expect(res.text).not.toContain('thresholdMs');
    expect(res.text).toContain('ENDPOINT_DOWN');
  });

  it('filters the history by result and date, and keeps the filter in the form', async () => {
    const admin = await t.loginAs(ADMIN);
    const stale = await admin.get(`/webhook-monitors/${webhookId}?result=STALE`);
    expect(stale.text).toMatch(/<option value="STALE" selected>/);
    expect(stale.text).toContain('Newest document');
    const none = await admin.get(`/webhook-monitors/${webhookId}?result=DOWN`);
    expect(none.text).toContain('No checks match.');
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await admin.get(`/webhook-monitors/${webhookId}?from=${tomorrow}`)).text).toContain(
      'No checks match.',
    );
    expect((await admin.get(`/webhook-monitors/${webhookId}?result=NOPE`)).status).toBe(400);
    expect((await admin.get(`/webhook-monitors/${webhookId}?from=yesterday`)).status).toBe(400);
    expect((await admin.get(`/webhook-monitors/${webhookId}?evil=1`)).status).toBe(400);
  });

  it('pages through history with an "Older" link', async () => {
    const { monitor } = await t.services.webhookMonitors.create(
      {
        name: 'Paged',
        gatewayName: 'G',
        sourceCollection: 'wh',
        timestampKey: 'dCreatedAt',
        checkInterval: { value: 10, unit: 'MINUTE' },
        threshold: { value: 1, unit: 'HOUR' },
        alertMode: 'EVERY_CHECK',
        isEnabled: true,
      },
      actor,
    );
    for (let i = 0; i < 27; i++) await t.services.runners.WEBHOOK.run(monitor.id, 'MANUAL');
    const admin = await t.loginAs(ADMIN);
    const first = await admin.get(`/webhook-monitors/${monitor.id}`);
    const older = /<a href="(\?[^"]+)" rel="next">/.exec(first.text)?.[1];
    expect(older).toBeDefined();
    expect(older).toContain('cursor=');
    const second = await admin.get(`/webhook-monitors/${monitor.id}${(older ?? '').replace(/&amp;/g, '&')}`);
    expect(second.status).toBe(200);
    expect(second.text).not.toContain('rel="next"');
  });
});

describe('admin controls only for admins (server also enforces)', () => {
  it('admin detail has Resend on the FAILED alert and the action buttons; viewer has neither', async () => {
    const admin = await (await t.loginAs(ADMIN)).get(`/webhook-monitors/${webhookId}`);
    expect(admin.text).toContain(`data-resend="${failedAlertId}"`);
    expect(admin.text).toContain('id="monitor-actions"');
    expect(admin.text).toContain('/public/js/alertActions.js');
    expect(admin.text).toContain('row-failed');
    const viewer = await (await t.loginAs(VIEWER)).get(`/webhook-monitors/${webhookId}`);
    expect(viewer.text).not.toContain('data-resend=');
    expect(viewer.text).not.toContain('monitor-actions');
    expect(viewer.text).toContain('row-failed');
  });
});

describe('global alert log (FR-D5)', () => {
  it('lists alerts with FAILED rows highlighted and the failure reason', async () => {
    const res = await (await t.loginAs(VIEWER)).get('/alerts');
    expect(res.text).toContain('row-failed');
    expect(res.text).toContain('The mail server could not be reached');
    expect(res.text).toContain('WEBHOOK_STALE');
    expect(res.text).not.toContain('data-resend=');
  });

  it('admins can resend from the log', async () => {
    const res = await (await t.loginAs(ADMIN)).get('/alerts');
    expect(res.text).toContain(`data-resend="${failedAlertId}"`);
    expect(res.text).toContain('/public/js/alertActions.js');
  });

  it('filters by status, type, monitor and date range', async () => {
    const viewer = await t.loginAs(VIEWER);
    const failed = await viewer.get('/alerts?status=FAILED');
    expect(failed.text).toContain('row-failed');
    expect(failed.text).toMatch(/<option value="FAILED" selected>/);
    expect((await viewer.get('/alerts?status=SENT')).text).toContain('No alerts match.');
    expect((await viewer.get('/alerts?type=ENDPOINT_DOWN')).text).toContain('ENDPOINT_DOWN');
    expect((await viewer.get('/alerts?type=TEST')).text).toMatch(/<td>TEST<\/td>/);
    expect((await viewer.get(`/alerts?monitorId=${endpointId}`)).text).not.toMatch(/<td>TEST<\/td>/);
    expect((await viewer.get(`/alerts?monitorId=${new ObjectId().toHexString()}`)).text).toContain(
      'No alerts match.',
    );
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await viewer.get(`/alerts?from=${tomorrow}`)).text).toContain('No alerts match.');
  });

  it('rejects unknown or malformed filters', async () => {
    const viewer = await t.loginAs(VIEWER);
    for (const query of [
      'status=BOGUS',
      'type=BOGUS',
      'monitorId=x',
      'from=nope',
      'cursor=garbage',
      'evil=1',
    ]) {
      expect((await viewer.get(`/alerts?${query}`)).status).toBe(400);
    }
  });

  it('needs a session', async () => {
    expect((await t.anonymous().get('/alerts')).status).toBe(302);
  });
});

describe('product name from APP_NAME (plan app-name-from-env)', () => {
  const brand = (html: string): string => /<a class="brand" href="\/">([^<]*)<\/a>/.exec(html)?.[1] ?? '';
  const title = (html: string): string => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';

  it('shows payMonitor by default (nothing changes unless the variable is set)', async () => {
    const res = await (await t.loginAs(VIEWER)).get('/');
    expect(brand(res.text)).toBe('payMonitor');
    expect(title(res.text)).toBe('Overview · payMonitor');
  });

  it('shows the configured name in the tab title and the brand, on every kind of page', async () => {
    const custom = await startTestApp({ mongo, config: { APP_NAME: 'Acme <Watch>' } });
    const admin = await custom.loginAs(ADMIN);
    const overview = await admin.get('/');
    expect(title(overview.text)).toBe('Overview · Acme &lt;Watch&gt;');
    expect(brand(overview.text)).toBe('Acme &lt;Watch&gt;');
    const login = await custom.anonymous().get('/login');
    expect(title(login.text)).toBe('Sign in · Acme &lt;Watch&gt;');
    const missing = await admin.get('/no-such-page');
    expect(missing.status).toBe(404);
    expect(title(missing.text)).toContain('Acme &lt;Watch&gt;');
    // Escaped: the raw tag never reaches the page, and no visible old name is left.
    expect(overview.text).not.toContain('<Watch>');
    expect(overview.text).not.toMatch(/>\s*payMonitor\s*</);
    await custom.stop();
  });
});
