import { COLLECTIONS } from '../../src/constants/collections.js';
import { ADMIN, csrfFor } from '../helpers/testApp.js';
import { MIN, startWorld, stopWorld, type World } from './support.js';

// Criterion 9: with SMTP down, alerts move PENDING -> RETRYING -> FAILED. Resend works once SMTP is back.
let w: World;
let alertId: string;

beforeAll(async () => {
  w = await startWorld();
  const alert = await w.t.services.alerts.sendTestEmail(
    {
      monitorType: 'WEBHOOK',
      monitorId: 'a'.repeat(24),
      name: 'Razorpay',
      checkIntervalMs: 60_000,
      alertMode: 'ONCE_WITH_RECOVERY',
    },
    w.actor,
  );
  alertId = alert.id;
}, 180_000);

afterAll(async () => {
  await stopWorld(w);
});

const status = async (): Promise<unknown> =>
  (await w.alerts({ _id: (await w.alerts())[0]?.['_id'] }))[0]?.['eStatus'];

it('PENDING -> RETRYING -> RETRYING -> RETRYING -> FAILED while SMTP is down', async () => {
  expect(await status()).toBe('PENDING');
  w.mailer.failAlways = true;
  const seen: unknown[] = [];
  for (const wait of [0, 1, 5, 15]) {
    w.clock.advance(wait * MIN);
    await w.dispatch();
    seen.push(await status());
  }
  expect(seen).toEqual(['RETRYING', 'RETRYING', 'RETRYING', 'FAILED']);
  expect(w.mailer.sent).toHaveLength(0);
});

it('shows the failed email highlighted on the dashboard, with a Resend button for admins only', async () => {
  const admin = await w.admin();
  const log = await admin.get('/alerts?status=FAILED');
  expect(log.text).toContain('row-failed');
  expect(log.text).toContain('The mail server could not be reached');
  expect(log.text).toContain(`data-resend="${alertId}"`);
  const viewerLog = await (await w.viewer()).get('/alerts?status=FAILED');
  expect(viewerLog.text).toContain('row-failed');
  expect(viewerLog.text).not.toContain('data-resend=');
  const overview = await admin.get('/');
  expect(overview.text).toMatch(/stat-value">1<\/span><span class="stat-label">Emails failed/);
});

it('Resend works once SMTP is back', async () => {
  w.mailer.failAlways = false;
  const admin = await w.admin();
  const token = await csrfFor(admin, '/');
  const res = await admin.post(`/api/v1/alerts/${alertId}/resend`).set('x-csrf-token', token);
  expect(res.status).toBe(202);
  expect(res.body).toEqual({ success: true, data: { status: 'queued' } });
  await w.dispatch();
  expect(w.mailer.sent).toHaveLength(1);
  expect((await w.alerts())[0]).toMatchObject({ eStatus: 'SENT', sMessageId: '<fake-1@test>' });
  const attempts = (await w.alerts())[0]?.['aAttempts'] as { bIsSuccess: boolean }[];
  expect(attempts.map((a) => a.bIsSuccess)).toEqual([false, false, false, false, true]);
  expect(await w.t.db.collection(COLLECTIONS.AUDIT_LOGS).countDocuments({ eAction: 'RESEND' })).toBe(1);
  expect(ADMIN.email).toContain('@');
});
