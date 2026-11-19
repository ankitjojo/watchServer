import { COLLECTIONS } from '../../src/constants/collections.js';
import { csrfFor } from '../helpers/testApp.js';
import { MIN, startWorld, stopWorld, webhookForm, type World } from './support.js';

// Criterion 1: an admin can create a webhook monitor by picking a collection from the source DB;
// an invalid timestamp key is rejected.
let w: World;

beforeAll(async () => {
  w = await startWorld();
  await w.seedSource('razor_pay_webhook_data', [MIN]);
  await w.t.sourceDb.collection('bad_ts_webhooks').insertOne({ dCreatedAt: 'not-a-date' });
  await w.t.sourceDb.createCollection('empty_webhooks');
}, 180_000);

afterAll(async () => {
  await stopWorld(w);
});

it('offers the live source collections in a dropdown', async () => {
  const admin = await w.admin();
  const page = await admin.get('/webhook-monitors/new');
  expect(page.status).toBe(200);
  for (const name of ['razor_pay_webhook_data', 'bad_ts_webhooks', 'empty_webhooks']) {
    expect(page.text).toContain(`<option value="${name}"`);
  }
});

it('rejects a collection whose newest document has no valid date at the timestamp key, and stores nothing', async () => {
  const admin = await w.admin();
  const token = await csrfFor(admin, '/webhook-monitors/new');
  const res = await admin
    .post('/webhook-monitors/new')
    .type('form')
    .send({ _csrf: token, ...webhookForm({ name: 'Bad key', sourceCollection: 'bad_ts_webhooks' }) });
  expect(res.status).toBe(400);
  expect(res.text).toContain('does not hold a valid date');
  expect(await w.t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).countDocuments({ sName: 'Bad key' })).toBe(0);
});

it('saves a monitor with a valid key', async () => {
  const admin = await w.admin();
  const token = await csrfFor(admin, '/webhook-monitors/new');
  const res = await admin
    .post('/webhook-monitors/new')
    .type('form')
    .send({ _csrf: token, ...webhookForm() });
  expect(res.status).toBe(303);
  expect(
    await w.t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).findOne({ sName: 'Razorpay webhooks' }),
  ).toMatchObject({
    sSourceCollection: 'razor_pay_webhook_data',
    sTimestampKey: 'dCreatedAt',
    bIsEnabled: true,
  });
});

it('also rejects a key that does not exist on the newest document', async () => {
  const admin = await w.admin();
  const token = await csrfFor(admin, '/webhook-monitors/new');
  const res = await admin
    .post('/webhook-monitors/new')
    .type('form')
    .send({ _csrf: token, ...webhookForm({ name: 'Missing key', timestampKey: 'dNope' }) });
  expect(res.status).toBe(400);
  expect(res.text).toContain('has no field');
});
