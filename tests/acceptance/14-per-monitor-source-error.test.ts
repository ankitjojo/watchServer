import { createViaForm, MIN, startWorld, stopWorld, webhookForm, type World } from './support.js';

// Review H2 / TD-29: a failure limited to ONE collection is that monitor's own MONITOR_ERROR.
// It goes to the normal recipients under the monitor's alert mode, is not grouped, and a healthy
// check of ANOTHER monitor never "recovers" it. Only a real outage uses the grouped masters-only mail.
let w: World;
let brokenId: string;
let healthyId: string;

beforeAll(async () => {
  w = await startWorld();
  await w.seedSource('razor_pay_webhook_data', [MIN]);
  await w.seedSource('apple_pay_webhook_data', [MIN]);
  const admin = await w.admin();
  brokenId = await createViaForm(admin, 'webhook', webhookForm({ name: 'Razorpay webhooks' }));
  healthyId = await createViaForm(
    admin,
    'webhook',
    webhookForm({ name: 'Apple webhooks', gatewayName: 'Apple', sourceCollection: 'apple_pay_webhook_data' }),
  );
  expect((await w.check('WEBHOOK', brokenId))?.result).toBe('OK');
  expect((await w.check('WEBHOOK', healthyId))?.result).toBe('OK');
}, 180_000);

afterAll(async () => {
  await stopWorld(w);
});

it('a dropped collection is MONITOR_ERROR for that monitor only, sent to the normal recipients', async () => {
  await w.t.sourceDb.collection('razor_pay_webhook_data').drop();
  w.clock.advance(10 * MIN);

  const check = await w.check('WEBHOOK', brokenId);
  expect(check).toMatchObject({ result: 'ERROR', error: { code: 'SOURCE_COLLECTION_NOT_FOUND' } });
  await w.dispatch();

  expect(w.subjects()).toEqual(['[payMonitor] MONITOR_ERROR – Razorpay webhooks']);
  expect(w.mailer.sent[0]?.to.sort()).toEqual(['master@x.test', 'ops@x.test']);
  expect(w.mailer.sent[0]?.text).toContain('razor_pay_webhook_data');
  // No grouped Source DB outage was opened.
  expect(await w.t.services.incidents.findOpenSourceError()).toBeNull();
  const state = (await w.t.services.webhookMonitors.getById(brokenId)).state;
  expect(state).toMatchObject({ lastResult: 'ERROR', currentStatus: 'ERROR' });
  expect(await w.t.services.incidents.findOpen(brokenId)).not.toBeNull();
});

it('a healthy check of another monitor does not recover it, and Once + recovery sends nothing more', async () => {
  w.clock.advance(10 * MIN);
  await w.t.sourceDb.collection('apple_pay_webhook_data').insertOne({ dCreatedAt: w.clock.now() });
  expect((await w.check('WEBHOOK', healthyId))?.result).toBe('OK');
  expect((await w.check('WEBHOOK', brokenId))?.result).toBe('ERROR');
  await w.dispatch();

  expect(w.mailer.sent).toHaveLength(1);
  expect(await w.alerts({ eType: 'RECOVERED' })).toHaveLength(0);
  expect(await w.t.services.incidents.findOpen(brokenId)).not.toBeNull();
});

it('recovers only when the broken monitor itself reads its collection again', async () => {
  w.clock.advance(10 * MIN);
  await w.t.sourceDb.collection('razor_pay_webhook_data').insertOne({ dCreatedAt: w.clock.now() });
  expect((await w.check('WEBHOOK', brokenId))?.result).toBe('OK');
  await w.dispatch();

  expect(w.subjects()).toEqual([
    '[payMonitor] MONITOR_ERROR – Razorpay webhooks',
    '[payMonitor] RECOVERED – Razorpay webhooks',
  ]);
  expect(w.mailer.sent[1]?.to.sort()).toEqual(['master@x.test', 'ops@x.test']);
  expect(await w.t.services.incidents.findOpen(brokenId)).toBeNull();
  // Never a grouped outage mail during the whole scenario.
  expect(w.subjects().some((s) => s.includes('Source DB'))).toBe(false);
});
