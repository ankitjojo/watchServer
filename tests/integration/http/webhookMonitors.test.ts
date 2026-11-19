import { MongoClient } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { ADMIN, VIEWER, csrfFor, startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;

const form = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Razorpay webhooks',
  gatewayName: 'Razorpay',
  sourceCollection: 'razor_pay_webhook_data',
  timestampKey: 'dCreatedAt',
  checkInterval: { value: '10', unit: 'MINUTE' },
  threshold: { value: '2', unit: 'HOUR' },
  alertMode: 'ONCE_WITH_RECOVERY',
  repeatInterval: { value: '', unit: 'MINUTE' },
  isEnabled: 'on',
  ...over,
});

beforeAll(async () => {
  mongo = await startTestMongo();
  t = await startTestApp({ mongo });
  const razor = t.sourceDb.collection('razor_pay_webhook_data');
  await razor.insertOne({ dCreatedAt: new Date(), payload: 'SECRET' });
  await razor.createIndex({ dCreatedAt: -1 });
  await t.sourceDb.collection('amazon_pay_webhook_data').insertOne({ dCreatedAt: new Date() });
  await t.sourceDb.createCollection('empty_webhooks');
  await t.sourceDb.collection('bad_ts_webhooks').insertOne({ dCreatedAt: 'not-a-date' });
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

async function post(
  agent: Awaited<ReturnType<TestApp['loginAs']>>,
  url: string,
  body: Record<string, unknown>,
) {
  const token = await csrfFor(agent, '/webhook-monitors/new');
  return agent
    .post(url)
    .type('form')
    .send({ _csrf: token, ...body });
}

describe('creating a webhook monitor (acceptance 1)', () => {
  it('shows the live source collections in a dropdown', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await admin.get('/webhook-monitors/new');
    expect(res.status).toBe(200);
    for (const name of [
      'razor_pay_webhook_data',
      'amazon_pay_webhook_data',
      'empty_webhooks',
      'bad_ts_webhooks',
    ]) {
      expect(res.text).toContain(`<option value="${name}"`);
    }
  });

  it('saves a valid monitor, audits it and redirects', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(admin, '/webhook-monitors/new', form());
    expect(res.status).toBe(303);
    const stored = await t.db
      .collection(COLLECTIONS.WEBHOOK_MONITORS)
      .findOne({ sName: 'Razorpay webhooks' });
    expect(stored).toMatchObject({
      sSourceCollection: 'razor_pay_webhook_data',
      oThreshold: { nValue: 2, eUnit: 'HOUR', nMs: 7_200_000 },
      oCheckInterval: { nValue: 10, eUnit: 'MINUTE', nMs: 600_000 },
      bHasDescIndexAtSave: true,
      bIsEnabled: true,
      dDeletedAt: null,
    });
    expect(
      await t.db
        .collection(COLLECTIONS.AUDIT_LOGS)
        .countDocuments({ eEntityType: 'WEBHOOK_MONITOR', eAction: 'CREATE' }),
    ).toBeGreaterThan(0);
    const list = await admin.get('/webhook-monitors');
    expect(list.text).toContain('Razorpay webhooks');
  });

  it('rejects an invalid timestamp key with a clear field error and keeps the entered values', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(
      admin,
      '/webhook-monitors/new',
      form({ name: 'Bad key monitor', sourceCollection: 'bad_ts_webhooks' }),
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain('does not hold a valid date');
    expect(res.text).toContain('Bad key monitor');
    expect(
      await t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).countDocuments({ sName: 'Bad key monitor' }),
    ).toBe(0);
  });

  it('rejects a key that is missing on the newest document', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(
      admin,
      '/webhook-monitors/new',
      form({ name: 'Missing key', timestampKey: 'nope' }),
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain('has no field');
  });

  it('rejects a collection that does not exist', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(
      admin,
      '/webhook-monitors/new',
      form({ name: 'Ghost', sourceCollection: 'ghost_collection' }),
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain('does not exist in the source database');
  });

  it('saves an empty collection with a warning', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(
      admin,
      '/webhook-monitors/new',
      form({ name: 'Empty one', sourceCollection: 'empty_webhooks' }),
    );
    expect(res.status).toBe(303);
    const page = await admin.get('/webhook-monitors');
    expect(page.text).toContain('The collection is empty');
  });

  it('the missing-index warning names the product from APP_NAME, in the save message and on the detail page (plan app-name-from-env)', async () => {
    const custom = await startTestApp({ mongo, sourceDb: t.sourceDb, config: { APP_NAME: 'Acme Watch' } });
    const admin = await custom.loginAs(ADMIN);
    const token = await csrfFor(admin, '/webhook-monitors/new');
    const res = await admin
      .post('/webhook-monitors/new')
      .type('form')
      .send({
        _csrf: token,
        ...form({ name: 'Acme no index', sourceCollection: 'amazon_pay_webhook_data' }),
      });
    expect(res.status).toBe(303);
    const list = await admin.get('/webhook-monitors');
    expect(list.text).toContain('Acme Watch cannot create it');
    const stored = await custom.db
      .collection(COLLECTIONS.WEBHOOK_MONITORS)
      .findOne({ sName: 'Acme no index' });
    const detail = await admin.get(`/webhook-monitors/${String(stored?.['_id'])}`);
    expect(detail.text).toContain('Acme Watch cannot create it');
    expect(list.text + detail.text).not.toContain('payMonitor cannot create it');
    await custom.stop();
  });

  it('warns about a missing index but still saves (section 5)', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(
      admin,
      '/webhook-monitors/new',
      form({ name: 'No index', sourceCollection: 'amazon_pay_webhook_data' }),
    );
    expect(res.status).toBe(303);
    const page = await admin.get('/webhook-monitors');
    expect(page.text).toContain('No index starts with');
    const stored = await t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).findOne({ sName: 'No index' });
    expect(stored?.['bHasDescIndexAtSave']).toBe(false);
    const detail = await admin.get(`/webhook-monitors/${String(stored?.['_id'])}`);
    expect(detail.text).toContain('No index starts with');
  });

  it('rejects a duplicate name with a 409 field error', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(admin, '/webhook-monitors/new', form());
    expect(res.status).toBe(409);
    expect(res.text).toContain('already exists');
  });

  it('shows field errors for cross-field problems and keeps nested values', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(
      admin,
      '/webhook-monitors/new',
      form({ name: 'Repeat bad', alertMode: 'REPEAT_EVERY', repeatInterval: { value: '5', unit: 'MINUTE' } }),
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain('must not be shorter than the check interval');
    expect(res.text).toContain('value="Repeat bad"');
  });

  it('treats an omitted Enabled checkbox as disabled', async () => {
    const admin = await t.loginAs(ADMIN);
    const body = form({ name: 'Paused at birth' });
    delete body['isEnabled'];
    expect((await post(admin, '/webhook-monitors/new', body)).status).toBe(303);
    expect(
      (await t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).findOne({ sName: 'Paused at birth' }))?.[
        'bIsEnabled'
      ],
    ).toBe(false);
  });
});

describe('editing and deleting', () => {
  it('edits a monitor without touching its state, and clears the repeat interval when the mode changes', async () => {
    const admin = await t.loginAs(ADMIN);
    await post(
      admin,
      '/webhook-monitors/new',
      form({ name: 'Editable', alertMode: 'REPEAT_EVERY', repeatInterval: { value: '30', unit: 'MINUTE' } }),
    );
    const before = await t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).findOne({ sName: 'Editable' });
    expect(before?.['oRepeatInterval']).toBeDefined();
    const id = String(before?.['_id']);
    await t.db
      .collection(COLLECTIONS.WEBHOOK_MONITORS)
      .updateOne({ sName: 'Editable' }, { $set: { 'oState.eLastResult': 'STALE' } });

    const res = await post(
      admin,
      `/webhook-monitors/${id}/edit`,
      form({ name: 'Editable v2', alertMode: 'EVERY_CHECK', threshold: { value: '3', unit: 'HOUR' } }),
    );
    expect(res.status).toBe(303);
    const after = await t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).findOne({ sName: 'Editable v2' });
    expect(after?.['oRepeatInterval']).toBeUndefined();
    expect(after?.['oThreshold']).toMatchObject({ nValue: 3 });
    expect((after?.['oState'] as Record<string, unknown>)['eLastResult']).toBe('STALE');
    expect(after?.['dCreatedAt']).toEqual(before?.['dCreatedAt']);
  });

  it('pre-fills the edit form', async () => {
    const admin = await t.loginAs(ADMIN);
    const stored = await t.db
      .collection(COLLECTIONS.WEBHOOK_MONITORS)
      .findOne({ sName: 'Razorpay webhooks' });
    const res = await admin.get(`/webhook-monitors/${String(stored?.['_id'])}/edit`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('value="Razorpay webhooks"');
    expect(res.text).toMatch(/name="threshold\[value\]"[^>]*value="2"/);
  });

  it('soft-deletes: hidden everywhere, history record kept, 404 afterwards', async () => {
    const admin = await t.loginAs(ADMIN);
    await post(admin, '/webhook-monitors/new', form({ name: 'To delete' }));
    const stored = await t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).findOne({ sName: 'To delete' });
    const id = String(stored?.['_id']);
    const token = await csrfFor(admin, '/webhook-monitors');
    expect(
      (await admin.post(`/webhook-monitors/${id}/delete`).type('form').send({ _csrf: token })).status,
    ).toBe(303);
    expect((await admin.get('/webhook-monitors')).text).not.toContain('To delete');
    expect((await admin.get(`/webhook-monitors/${id}`)).status).toBe(404);
    const kept = await t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).findOne({ sName: 'To delete' });
    expect(kept?.['dDeletedAt']).toEqual(expect.any(Date));
    expect(kept?.['bIsEnabled']).toBe(false);
    // The name is free again once deleted.
    expect((await post(admin, '/webhook-monitors/new', form({ name: 'To delete' }))).status).toBe(303);
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    const admin = await t.loginAs(ADMIN);
    expect((await admin.get('/webhook-monitors/aaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
    expect((await admin.get('/webhook-monitors/not-an-id')).status).toBe(400);
  });
});

describe('viewers', () => {
  it('can read the list and the detail but see no admin controls', async () => {
    const viewer = await t.loginAs(VIEWER);
    const list = await viewer.get('/webhook-monitors');
    expect(list.status).toBe(200);
    expect(list.text).toContain('Razorpay webhooks');
    expect(list.text).not.toContain('New webhook monitor');
    const stored = await t.db
      .collection(COLLECTIONS.WEBHOOK_MONITORS)
      .findOne({ sName: 'Razorpay webhooks' });
    const detail = await viewer.get(`/webhook-monitors/${String(stored?.['_id'])}`);
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain('/edit');
    expect(detail.text).not.toContain('/delete');
  });
});

describe('source API (acceptance 1)', () => {
  it('lists collections for admins in the JSON envelope', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await admin.get('/api/v1/source/collections');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data.collections');
    expect(JSON.stringify(res.body)).toContain('razor_pay_webhook_data');
  });

  it('validates a key: valid, invalid, empty', async () => {
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const call = (sourceCollection: string, timestampKey: string) =>
      admin
        .post('/api/v1/source/validate-timestamp-key')
        .set('x-csrf-token', token)
        .send({ sourceCollection, timestampKey });
    const ok = await call('razor_pay_webhook_data', 'dCreatedAt');
    expect(ok.body).toHaveProperty('data.valid', true);
    expect(ok.body).toHaveProperty('data.hasTimestampIndex', true);
    expect(JSON.stringify(ok.body)).not.toContain('SECRET');
    expect((await call('bad_ts_webhooks', 'dCreatedAt')).body).toHaveProperty('data.valid', false);
    expect((await call('empty_webhooks', 'dCreatedAt')).body).toHaveProperty('data.warning');
    expect((await call('amazon_pay_webhook_data', 'dCreatedAt')).body).toHaveProperty(
      'data.hasTimestampIndex',
      false,
    );
  });

  it('rejects an injection attempt in the key with a 400 envelope', async () => {
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const res = await admin
      .post('/api/v1/source/validate-timestamp-key')
      .set('x-csrf-token', token)
      .send({ sourceCollection: 'razor_pay_webhook_data', timestampKey: '$where' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error.code', 'VALIDATION_FAILED');
  });

  it('needs an admin session', async () => {
    expect((await t.anonymous().get('/api/v1/source/collections')).status).toBe(401);
  });
});

describe('when the Source DB is unreachable', () => {
  it('still renders the form (manual collection entry) and reports a 502 on save instead of crashing', async () => {
    const dead = new MongoClient('mongodb://127.0.0.1:1/x', { serverSelectionTimeoutMS: 300 });
    const down = await startTestApp({ mongo, sourceDb: dead.db('x') });
    const admin = await down.loginAs(ADMIN);
    const page = await admin.get('/webhook-monitors/new');
    expect(page.status).toBe(200);
    expect(page.text).toContain('could not be loaded from the source database');
    const token = await csrfFor(admin, '/webhook-monitors/new');
    const res = await admin
      .post('/webhook-monitors/new')
      .type('form')
      .send({ _csrf: token, ...form({ name: 'While down' }) });
    expect(res.status).toBe(502);
    expect(res.text).toContain('could not');
    expect(res.text).not.toMatch(/127\.0\.0\.1/);
    await dead.close();
  }, 30_000);
});
