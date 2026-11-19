import { createViaForm, MIN, startWorld, stopWorld, webhookForm, type World } from './support.js';

// Criterion 3: when a new document arrives, the next check stores and sends one RECOVERED alert,
// and the incident shows its duration.
let w: World;
let monitorId: string;

beforeAll(async () => {
  w = await startWorld();
  await w.seedSource('razor_pay_webhook_data', [10 * MIN]);
  monitorId = await createViaForm(await w.admin(), 'webhook', webhookForm());
  await w.check('WEBHOOK', monitorId);
  await w.dispatch();
}, 180_000);

afterAll(async () => {
  await stopWorld(w);
});

it('sends one RECOVERED email with the downtime once a new document arrives', async () => {
  w.clock.advance(25 * MIN);
  await w.t.sourceDb
    .collection('razor_pay_webhook_data')
    .insertOne({ dCreatedAt: new Date(w.clock.now().getTime() - 5_000) });
  expect((await w.check('WEBHOOK', monitorId))?.result).toBe('OK');
  expect(await w.alerts({ eType: 'RECOVERED' })).toHaveLength(1);
  await w.dispatch();

  expect(w.subjects()).toEqual([
    '[payMonitor] WEBHOOK_STALE – Razorpay webhooks',
    '[payMonitor] RECOVERED – Razorpay webhooks',
  ]);
  expect(w.mailer.sent[1]?.text).toContain('Downtime: 25 min');
});

it('does not send RECOVERED again on later healthy checks', async () => {
  for (let i = 0; i < 3; i++) {
    w.clock.advance(10 * MIN);
    await w.t.sourceDb
      .collection('razor_pay_webhook_data')
      .insertOne({ dCreatedAt: new Date(w.clock.now().getTime() - 1_000) });
    await w.check('WEBHOOK', monitorId);
    await w.dispatch();
  }
  expect(w.mailer.sent).toHaveLength(2);
});

it('shows the closed incident with its start, end and duration on the monitor page', async () => {
  const viewer = await w.viewer();
  const page = await viewer.get(`/webhook-monitors/${monitorId}`);
  expect(page.status).toBe(200);
  const incidents = /<h2>Incidents<\/h2>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(page.text)?.[1] ?? '';
  expect(incidents).toContain('UTC');
  expect(incidents).toContain('25 min');
  expect(incidents).not.toContain('ongoing');
  expect(page.text).toContain('RECOVERED');
});
