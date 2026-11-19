import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../src/constants/collections.js';
import { ROUTE_MANIFEST } from '../helpers/routeManifest.js';
import { csrfFor } from '../helpers/testApp.js';
import {
  MIN,
  createViaForm,
  endpointForm,
  startWorld,
  stopWorld,
  webhookForm,
  type World,
} from './support.js';

// Criterion 11: a viewer can see everything and cannot change anything (UI and API both enforce this).
let w: World;
let webhookId: string;
let endpointId: string;

beforeAll(async () => {
  w = await startWorld();
  await w.seedSource('razor_pay_webhook_data', [10 * MIN]);
  const admin = await w.admin();
  webhookId = await createViaForm(admin, 'webhook', webhookForm());
  endpointId = await createViaForm(admin, 'endpoint', endpointForm());
  await w.check('WEBHOOK', webhookId);
}, 180_000);

afterAll(async () => {
  await stopWorld(w);
});

const snapshot = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    await Promise.all(
      Object.values(COLLECTIONS).map(
        async (c) => [c, await w.t.db.collection(c).countDocuments({})] as const,
      ),
    ),
  );

it('can read every page that is not admin management', async () => {
  const viewer = await w.viewer();
  for (const path of [
    '/',
    '/webhook-monitors',
    `/webhook-monitors/${webhookId}`,
    '/endpoint-monitors',
    `/endpoint-monitors/${endpointId}`,
    '/alerts',
  ]) {
    const res = await viewer.get(path);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/data-action=|data-resend=|id="monitor-actions"/);
  }
  const data = await viewer.get(`/api/v1/monitors/webhook/${webhookId}/checks`);
  expect(data.status).toBe(200);
  expect((await viewer.get(`/api/v1/monitors/webhook/${webhookId}/series?range=24h`)).status).toBe(200);
});

it('is refused (403) on every admin route, in the UI and the API, and nothing changes', async () => {
  const viewer = await w.viewer();
  const before = await snapshot();
  const token = await csrfFor(viewer, '/');
  const statuses: [string, number][] = [];
  for (const route of ROUTE_MANIFEST) {
    const url = route.path.replace(':id', new ObjectId().toHexString());
    const res =
      route.method === 'get'
        ? await viewer.get(url)
        : await viewer.post(url).set('x-csrf-token', token).type('form').send({ _csrf: token, name: 'x' });
    statuses.push([`${route.method.toUpperCase()} ${route.path}`, res.status]);
  }
  expect(statuses.filter(([, status]) => status !== 403)).toEqual([]);
  expect(statuses.length).toBeGreaterThan(30);
  expect(await snapshot()).toEqual(before);
});

it('cannot change a real monitor either (the ids exist, so 403 is not hiding a 404)', async () => {
  const viewer = await w.viewer();
  const token = await csrfFor(viewer, '/');
  for (const path of [
    `/webhook-monitors/${webhookId}/delete`,
    `/endpoint-monitors/${endpointId}/delete`,
    `/api/v1/monitors/webhook/${webhookId}/pause`,
    `/api/v1/monitors/webhook/${webhookId}/run`,
    `/api/v1/monitors/endpoint/${endpointId}/test-email`,
  ]) {
    expect(
      (await viewer.post(path).set('x-csrf-token', token).type('form').send({ _csrf: token })).status,
    ).toBe(403);
  }
  expect((await w.t.services.webhookMonitors.getById(webhookId)).isEnabled).toBe(true);
});
