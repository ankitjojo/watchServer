import { COLLECTIONS } from '../../src/constants/collections.js';
import { HOUR, MIN, createViaForm, startWorld, stopWorld, webhookForm, type World } from './support.js';

// Criterion 2: threshold 1 minute on a collection with no new document. After the next check exactly one
// WEBHOOK_STALE alert is stored, followed by one email (mode "Once + recovery").
let w: World;
let monitorId: string;

beforeAll(async () => {
  w = await startWorld();
  await w.seedSource('razor_pay_webhook_data', [10 * MIN]);
  monitorId = await createViaForm(await w.admin(), 'webhook', webhookForm());
}, 180_000);

afterAll(async () => {
  await stopWorld(w);
});

it('stores exactly one WEBHOOK_STALE alert, then sends exactly one email', async () => {
  const check = await w.check('WEBHOOK', monitorId);
  expect(check?.result).toBe('STALE');

  // Store first: the alert exists, PENDING, before any email was attempted.
  const stored = await w.alerts({ eType: 'WEBHOOK_STALE' });
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ eStatus: 'PENDING' });
  expect(w.mailer.attempts).toBe(0);

  await w.dispatch();
  expect(w.subjects()).toEqual(['[payMonitor] WEBHOOK_STALE – Razorpay webhooks']);
  expect(await w.alerts({ eType: 'WEBHOOK_STALE' })).toMatchObject([{ eStatus: 'SENT' }]);
  const [email] = w.mailer.sent;
  expect(email?.to.sort()).toEqual(['master@x.test', 'ops@x.test']);
  for (const field of [
    'Razorpay webhooks',
    'razor_pay_webhook_data',
    'dCreatedAt',
    'Age:',
    'Threshold: 1 min',
    'UTC',
    `/webhook-monitors/${monitorId}`,
  ]) {
    expect(email?.text).toContain(field);
  }
});

it('sends nothing more while the monitor keeps failing', async () => {
  for (let i = 0; i < 6; i++) {
    w.clock.advance(10 * MIN);
    expect((await w.check('WEBHOOK', monitorId))?.result).toBe('STALE');
    await w.dispatch();
  }
  expect(await w.alerts({ eType: 'WEBHOOK_STALE' })).toHaveLength(1);
  expect(w.mailer.sent).toHaveLength(1);
  const incidents = await w.t.db.collection(COLLECTIONS.INCIDENTS).find({}).toArray();
  expect(incidents).toHaveLength(1);
  expect(incidents[0]?.['dClosedAt']).toBeNull();
  expect(HOUR).toBeGreaterThan(0);
});
