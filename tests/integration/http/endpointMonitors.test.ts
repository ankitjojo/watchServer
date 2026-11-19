import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { ADMIN, VIEWER, csrfFor, startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;

const form = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  serverName: 'Subscription API – prod',
  url: 'https://api.example.com/health?token=SECRET-TOKEN',
  checkInterval: { value: '5', unit: 'MINUTE' },
  retryCount: '2',
  alertMode: 'ONCE_WITH_RECOVERY',
  repeatInterval: { value: '', unit: 'MINUTE' },
  isEnabled: 'on',
  ...over,
});

beforeAll(async () => {
  mongo = await startTestMongo();
  t = await startTestApp({ mongo });
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

async function post(
  agent: Awaited<ReturnType<TestApp['loginAs']>>,
  url: string,
  body: Record<string, unknown>,
) {
  const token = await csrfFor(agent, '/endpoint-monitors/new');
  return agent
    .post(url)
    .type('form')
    .send({ _csrf: token, ...body });
}

describe('endpoint monitors', () => {
  it('pre-fills the retry count default from config and the form works', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await admin.get('/endpoint-monitors/new');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/name="retryCount"[^>]*value="2"/);
  });

  it('creates a monitor, audits it and lists it', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(admin, '/endpoint-monitors/new', form());
    expect(res.status).toBe(303);
    const stored = await t.db
      .collection(COLLECTIONS.ENDPOINT_MONITORS)
      .findOne({ sServerName: 'Subscription API – prod' });
    expect(stored).toMatchObject({
      nRetryCount: 2,
      oCheckInterval: { nMs: 300_000 },
      dDeletedAt: null,
      bIsEnabled: true,
    });
    expect(
      await t.db
        .collection(COLLECTIONS.AUDIT_LOGS)
        .countDocuments({ eEntityType: 'ENDPOINT_MONITOR', eAction: 'CREATE' }),
    ).toBe(1);
    expect((await admin.get('/endpoint-monitors')).text).toContain('Subscription API – prod');
  });

  it('masks URL query values in lists and details but shows the full URL in the admin edit form', async () => {
    const admin = await t.loginAs(ADMIN);
    const stored = await t.db
      .collection(COLLECTIONS.ENDPOINT_MONITORS)
      .findOne({ sServerName: 'Subscription API – prod' });
    const id = String(stored?.['_id']);
    const list = await admin.get('/endpoint-monitors');
    expect(list.text).toContain('token=***');
    expect(list.text).not.toContain('SECRET-TOKEN');
    expect((await admin.get(`/endpoint-monitors/${id}`)).text).not.toContain('SECRET-TOKEN');
    expect((await admin.get(`/endpoint-monitors/${id}/edit`)).text).toContain('SECRET-TOKEN');
    const viewer = await t.loginAs(VIEWER);
    expect((await viewer.get(`/endpoint-monitors/${id}`)).text).not.toContain('SECRET-TOKEN');
  });

  it.each([
    ['ftp://example.com/x', 'url'],
    ['https://user:pw@example.com/x', 'url'],
    ['not a url', 'url'],
  ])('rejects the URL %s with a field error and keeps the entered values', async (url) => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(admin, '/endpoint-monitors/new', form({ serverName: 'Bad URL', url }));
    expect(res.status).toBe(400);
    expect(res.text).toContain('valid http:// or https:// URL');
    expect(res.text).toContain('value="Bad URL"');
  });

  it('rejects a retry count above the configured maximum', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(
      admin,
      '/endpoint-monitors/new',
      form({ serverName: 'Too many', retryCount: '6' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a check interval above 24 hours through the form and stores nothing (review H1)', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(
      admin,
      '/endpoint-monitors/new',
      form({ serverName: 'Too slow', checkInterval: { value: '1000', unit: 'HOUR' } }),
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain('must be at most 1440 minutes');
    expect(
      await t.db.collection(COLLECTIONS.ENDPOINT_MONITORS).findOne({ sServerName: 'Too slow' }),
    ).toBeNull();
  });

  it('rejects a duplicate server name with 409', async () => {
    const admin = await t.loginAs(ADMIN);
    const res = await post(admin, '/endpoint-monitors/new', form());
    expect(res.status).toBe(409);
    expect(res.text).toContain('already exists');
  });

  it('edits a monitor and keeps its state', async () => {
    const admin = await t.loginAs(ADMIN);
    const stored = await t.db
      .collection(COLLECTIONS.ENDPOINT_MONITORS)
      .findOne({ sServerName: 'Subscription API – prod' });
    const id = String(stored?.['_id']);
    await t.db
      .collection(COLLECTIONS.ENDPOINT_MONITORS)
      .updateOne({ _id: new ObjectId(id) }, { $set: { 'oState.eLastResult': 'DOWN' } });
    const res = await post(
      admin,
      `/endpoint-monitors/${id}/edit`,
      form({ retryCount: '4', alertMode: 'REPEAT_EVERY', repeatInterval: { value: '30', unit: 'MINUTE' } }),
    );
    expect(res.status).toBe(303);
    const after = await t.db.collection(COLLECTIONS.ENDPOINT_MONITORS).findOne({ _id: new ObjectId(id) });
    expect(after).toMatchObject({ nRetryCount: 4, oRepeatInterval: { nMs: 1_800_000 } });
    expect((after?.['oState'] as Record<string, unknown>)['eLastResult']).toBe('DOWN');
  });

  it('soft-deletes and frees the name', async () => {
    const admin = await t.loginAs(ADMIN);
    await post(admin, '/endpoint-monitors/new', form({ serverName: 'Temp server' }));
    const stored = await t.db
      .collection(COLLECTIONS.ENDPOINT_MONITORS)
      .findOne({ sServerName: 'Temp server' });
    const id = String(stored?.['_id']);
    const token = await csrfFor(admin, '/endpoint-monitors');
    expect(
      (await admin.post(`/endpoint-monitors/${id}/delete`).type('form').send({ _csrf: token })).status,
    ).toBe(303);
    expect((await admin.get(`/endpoint-monitors/${id}`)).status).toBe(404);
    expect((await admin.get('/endpoint-monitors')).text).not.toContain('Temp server');
    expect(
      (await t.db.collection(COLLECTIONS.ENDPOINT_MONITORS).findOne({ sServerName: 'Temp server' }))?.[
        'dDeletedAt'
      ],
    ).toEqual(expect.any(Date));
    expect((await post(admin, '/endpoint-monitors/new', form({ serverName: 'Temp server' }))).status).toBe(
      303,
    );
  });

  it('lets a viewer read but shows no admin controls', async () => {
    const viewer = await t.loginAs(VIEWER);
    const list = await viewer.get('/endpoint-monitors');
    expect(list.status).toBe(200);
    expect(list.text).not.toContain('New endpoint monitor');
  });

  it('escapes the server name', async () => {
    const admin = await t.loginAs(ADMIN);
    await post(admin, '/endpoint-monitors/new', form({ serverName: '<img src=x onerror=alert(1)>' }));
    const list = await admin.get('/endpoint-monitors');
    expect(list.text).not.toContain('<img src=x');
    expect(list.text).toContain('&lt;img');
  });
});
