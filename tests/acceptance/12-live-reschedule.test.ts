import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../src/constants/collections.js';
import { csrfFor } from '../helpers/testApp.js';
import { FakeTimers } from '../helpers/fakeTimers.js';
import { FakeClock } from '../helpers/fakeClock.js';
import {
  MIN,
  createViaForm,
  endpointForm,
  startFakeEndpoint,
  startWorld,
  stopWorld,
  type FakeEndpoint,
  type World,
} from './support.js';

// Criterion 12: creating, editing or pausing a monitor takes effect without restarting the server.
let w: World;
let endpoint: FakeEndpoint;
let timers: FakeTimers;
const clock = new FakeClock('2026-11-18T12:00:00.000Z');

beforeAll(async () => {
  timers = new FakeTimers(clock);
  endpoint = await startFakeEndpoint();
  w = await startWorld({ timers });
  // startWorld has its own clock: drive the scheduler with this shared one by aligning both.
  w.clock.set(clock.now());
  await w.t.services.scheduler.start();
}, 180_000);

afterAll(async () => {
  await endpoint.close();
  await stopWorld(w);
});

const sync = async (ms: number): Promise<void> => {
  // One virtual clock for the scheduler's timers and the app.
  w.clock.advance(ms);
  clock.advance(ms);
  await timers.advance(ms);
};
const checksOf = (id: string): Promise<number> =>
  w.t.db.collection(COLLECTIONS.CHECKS).countDocuments({ iMonitorId: new ObjectId(id) });
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

it('create: the first check runs at once, without waiting for the interval', async () => {
  const admin = await w.admin();
  const id = await createViaForm(
    admin,
    'endpoint',
    endpointForm({
      serverName: 'Live',
      url: `${endpoint.base}/ok`,
      retryCount: '0',
      checkInterval: { value: '5', unit: 'MINUTE' },
    }),
  );
  await sync(0);
  await settle();
  expect(await checksOf(id)).toBe(1);
  expect((await w.t.services.endpointMonitors.getById(id)).state.nextCheckAt).not.toBeNull();

  await sync(5 * MIN);
  await settle();
  expect(await checksOf(id)).toBe(2);
  (globalThis as Record<string, unknown>)['__live'] = id;
});

it('edit: a new interval applies from the next run, no restart', async () => {
  const id = String((globalThis as Record<string, unknown>)['__live']);
  const admin = await w.admin();
  const token = await csrfFor(admin, `/endpoint-monitors/${id}/edit`);
  const before = await checksOf(id);
  const res = await admin
    .post(`/endpoint-monitors/${id}/edit`)
    .type('form')
    .send({
      _csrf: token,
      ...endpointForm({
        serverName: 'Live',
        url: `${endpoint.base}/ok`,
        retryCount: '0',
        checkInterval: { value: '2', unit: 'MINUTE' },
      }),
    });
  expect(res.status).toBe(303);
  await sync(2 * MIN);
  await settle();
  expect(await checksOf(id)).toBeGreaterThan(before);
  const afterFirst = await checksOf(id);
  await sync(2 * MIN);
  await settle();
  expect(await checksOf(id)).toBe(afterFirst + 1);
});

it('pause: no more scheduled checks, and the dashboard shows PAUSED', async () => {
  const id = String((globalThis as Record<string, unknown>)['__live']);
  const admin = await w.admin();
  const token = await csrfFor(admin, '/');
  expect((await admin.post(`/api/v1/monitors/endpoint/${id}/pause`).set('x-csrf-token', token)).status).toBe(
    200,
  );
  await settle();
  const paused = await checksOf(id);
  await sync(30 * MIN);
  await settle();
  expect(await checksOf(id)).toBe(paused);
  expect((await admin.get('/endpoint-monitors')).text).toContain('badge-paused');
});

it('resume: a check runs at once and the schedule starts again', async () => {
  const id = String((globalThis as Record<string, unknown>)['__live']);
  const admin = await w.admin();
  const token = await csrfFor(admin, '/');
  const paused = await checksOf(id);
  expect((await admin.post(`/api/v1/monitors/endpoint/${id}/resume`).set('x-csrf-token', token)).status).toBe(
    200,
  );
  await sync(0);
  await settle();
  expect(await checksOf(id)).toBe(paused + 1);
  await sync(2 * MIN);
  await settle();
  expect(await checksOf(id)).toBe(paused + 2);
});

it('delete: scheduling stops and the history is kept', async () => {
  const id = String((globalThis as Record<string, unknown>)['__live']);
  const admin = await w.admin();
  const token = await csrfFor(admin, '/endpoint-monitors');
  const before = await checksOf(id);
  await admin.post(`/endpoint-monitors/${id}/delete`).type('form').send({ _csrf: token }).expect(303);
  await sync(20 * MIN);
  await settle();
  expect(await checksOf(id)).toBe(before);
});
