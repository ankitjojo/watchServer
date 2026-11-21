import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { createLogger } from '../../../src/logger/index.js';
import { systemClock } from '../../../src/types/clock.js';
import { createEndpointRunner } from '../../../src/modules/endpointMonitors/endpointMonitors.runner.js';
import { systemProbeDeps } from '../../../src/modules/endpointMonitors/httpProbe.deps.js';
import { createRecordingAlerts, type RecordingAlerts } from '../../helpers/fakeAlerts.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;
let server: Server;
let base: string;
let alerts: RecordingAlerts;
let actor: { id: string; email: string };
const hits: Record<string, number> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === '/ok') res.writeHead(200).end('ok');
    else if (path === '/flaky') res.writeHead(hits[path] === 1 ? 500 : 200).end();
    else res.writeHead(500).end('SECRET-BODY');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  mongo = await startTestMongo();
  alerts = createRecordingAlerts();
  t = await startTestApp({
    mongo,
    alerts,
    probeDeps: { ...systemProbeDeps, sleep: () => Promise.resolve() },
  });
  const admin = (await t.services.users.list()).find((u) => u.role === 'ADMIN');
  actor = { id: admin?.id ?? '', email: admin?.email ?? '' };
}, 180_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await mongo.stop();
});

beforeEach(() => {
  alerts.outcomes.length = 0;
  delete alerts.failWith;
  for (const key of Object.keys(hits)) hits[key] = 0;
});

const create = (name: string, path: string, retryCount = 2, over: Record<string, unknown> = {}) =>
  t.services.endpointMonitors.create(
    {
      serverName: name,
      url: `${base}${path}`,
      checkInterval: { value: 5, unit: 'MINUTE' },
      retryCount,
      alertMode: 'ONCE_WITH_RECOVERY',
      isEnabled: true,
      ...over,
    },
    actor,
  );

const run = (id: string, trigger: 'SCHEDULE' | 'MANUAL' = 'SCHEDULE') =>
  t.services.runners.ENDPOINT.run(id, trigger);

describe('endpoint runner (FR-E2, FR-H1)', () => {
  it('is OK on a 200, with one stored attempt and updated state', async () => {
    const monitor = await create('Healthy', '/ok');
    const check = await run(monitor.id);
    expect(check).toMatchObject({ monitorType: 'ENDPOINT', result: 'OK', trigger: 'SCHEDULE' });
    expect(check?.endpoint?.attempts).toHaveLength(1);
    expect(check?.endpoint?.attempts[0]).toMatchObject({ attempt: 1, statusCode: 200 });
    const state = (await t.services.endpointMonitors.getById(monitor.id)).state;
    expect(state).toMatchObject({ lastResult: 'OK', currentStatus: 'OK', lastCheckId: check?.id });
    expect(state.lastResponseTimeMs).toBe(check?.endpoint?.attempts[0]?.responseTimeMs);
  });

  it('is DOWN only after retryCount + 1 failed attempts, all stored (acceptance 4)', async () => {
    const monitor = await create('Broken', '/fail', 2);
    const check = await run(monitor.id);
    expect(check?.result).toBe('DOWN');
    expect(check?.endpoint?.attempts.map((a) => a.statusCode)).toEqual([500, 500, 500]);
    expect(hits['/fail']).toBe(3);
    expect(JSON.stringify(check)).not.toContain('SECRET-BODY');
    expect((await t.services.endpointMonitors.getById(monitor.id)).state).toMatchObject({
      lastResult: 'DOWN',
      currentStatus: 'DOWN',
    });
  });

  it('is OK when it fails once and then returns 200: the failed attempt is kept, no DOWN', async () => {
    const monitor = await create('Flaky', '/flaky', 2);
    const check = await run(monitor.id);
    expect(check?.result).toBe('OK');
    expect(check?.endpoint?.attempts.map((a) => a.statusCode)).toEqual([500, 200]);
  });

  it('hands alerts a snapshot with a masked URL and no credentials', async () => {
    const monitor = await create('Tokened', '/ok?token=SECRET-TOKEN');
    await run(monitor.id);
    const snapshot = alerts.outcomes[0]?.monitor;
    expect(snapshot).toMatchObject({
      monitorType: 'ENDPOINT',
      name: 'Tokened',
      checkIntervalMs: 300_000,
      alertMode: 'ONCE_WITH_RECOVERY',
    });
    expect(snapshot?.url).toBe(`${base}/ok?token=***`);
    expect(JSON.stringify(alerts.outcomes)).not.toContain('SECRET-TOKEN');
    expect(snapshot).not.toHaveProperty('thresholdMs');
  });

  it('a failing endpoint is DOWN, never ERROR', async () => {
    const monitor = await create('Down', '/fail', 0);
    expect((await run(monitor.id))?.result).toBe('DOWN');
    expect(alerts.outcomes).toHaveLength(1);
  });

  it('skips a paused monitor on schedule, runs it manually, and ignores deleted ones', async () => {
    const paused = await create('Paused', '/ok', 0, { isEnabled: false });
    expect(await run(paused.id, 'SCHEDULE')).toBeNull();
    expect(await run(paused.id, 'MANUAL')).toMatchObject({ trigger: 'MANUAL', result: 'OK' });
    await t.services.endpointMonitors.remove(paused.id, actor);
    expect(await run(paused.id, 'MANUAL')).toBeNull();
    expect(
      await t.db.collection(COLLECTIONS.CHECKS).countDocuments({ iMonitorId: new ObjectId(paused.id) }),
    ).toBe(1);
  });

  it('still stores the check and state when alerting fails, then rethrows', async () => {
    const monitor = await create('Alert fails', '/fail', 0);
    alerts.failWith = new Error('alerts database down');
    await expect(run(monitor.id)).rejects.toThrow('alerts database down');
    expect(
      await t.db.collection(COLLECTIONS.CHECKS).countDocuments({ iMonitorId: new ObjectId(monitor.id) }),
    ).toBe(1);
    expect((await t.services.endpointMonitors.getById(monitor.id)).state.lastResult).toBe('DOWN');
  });
});

describe('deleted while a check is running (review L4, T3)', () => {
  it('stores the check but creates no alert and changes no monitor state', async () => {
    const monitor = await create('Deleted mid-check', '/fail', 0);
    const runner = createEndpointRunner({
      monitors: t.services.endpointMonitors,
      checks: {
        ...t.services.checks,
        record: async (input) => {
          await t.services.endpointMonitors.remove(monitor.id, actor);
          return t.services.checks.record(input);
        },
      },
      alerts,
      clock: systemClock,
      logger: createLogger({ level: 'silent' }),
      probeDeps: { ...systemProbeDeps, sleep: () => Promise.resolve() },
      probeOptions: { retryDelayMs: 0, timeoutMs: 2000, maxRedirects: 2 },
      downAfterChecks: 1,
    });
    const check = await runner.run(monitor.id, 'SCHEDULE');
    expect(check?.result).toBe('DOWN');
    expect(
      await t.db.collection(COLLECTIONS.CHECKS).countDocuments({ iMonitorId: new ObjectId(monitor.id) }),
    ).toBe(1);
    expect(alerts.outcomes).toHaveLength(0);
    const kept = await t.services.endpointMonitors.getByIdIncludingDeleted(monitor.id);
    expect(kept.state.lastResult ?? null).toBeNull();
  });
});

describe('ENDPOINT_DOWN_AFTER_CHECKS (TD-39)', () => {
  const runnerWith = (downAfterChecks: number) =>
    createEndpointRunner({
      monitors: t.services.endpointMonitors,
      checks: t.services.checks,
      alerts,
      clock: systemClock,
      logger: createLogger({ level: 'silent' }),
      probeDeps: { ...systemProbeDeps, sleep: () => Promise.resolve() },
      probeOptions: { retryDelayMs: 0, timeoutMs: 2000, maxRedirects: 2 },
      downAfterChecks,
    });
  const downOutcomes = () => alerts.outcomes.filter((o) => o.check.result === 'DOWN');

  it('with 2: one failed check stores DOWN but sends nothing; the second failed check in a row alerts', async () => {
    const monitor = await create('Confirm two', '/fail', 0);
    const runner = runnerWith(2);
    expect((await runner.run(monitor.id, 'SCHEDULE'))?.result).toBe('DOWN');
    expect(downOutcomes()).toHaveLength(0);
    const state = (await t.services.endpointMonitors.getById(monitor.id)).state;
    expect(state).toMatchObject({ lastResult: 'DOWN', currentStatus: 'DOWN', consecutiveFailures: 1 });
    await runner.run(monitor.id, 'SCHEDULE');
    expect(downOutcomes()).toHaveLength(1);
    expect((await t.services.endpointMonitors.getById(monitor.id)).state.consecutiveFailures).toBe(2);
  });

  it('an OK check in between resets the count (a blip never alerts)', async () => {
    const monitor = await create('Blip', '/fail', 0);
    const runner = runnerWith(2);
    await runner.run(monitor.id, 'SCHEDULE');
    await t.services.endpointMonitors.update(
      monitor.id,
      {
        serverName: 'Blip',
        url: `${base}/ok`,
        checkInterval: { value: 5, unit: 'MINUTE' },
        retryCount: 0,
        alertMode: 'ONCE_WITH_RECOVERY',
        isEnabled: true,
      },
      actor,
    );
    await runner.run(monitor.id, 'SCHEDULE');
    expect((await t.services.endpointMonitors.getById(monitor.id)).state.consecutiveFailures).toBe(0);
    expect(downOutcomes()).toHaveLength(0);
  });

  it('loads an old monitor document without the counter as 0', async () => {
    const monitor = await create('Old doc', '/fail', 0);
    await t.db
      .collection(COLLECTIONS.ENDPOINT_MONITORS)
      .updateOne({ _id: new ObjectId(monitor.id) }, { $unset: { 'oState.nConsecutiveFailures': '' } });
    expect((await t.services.endpointMonitors.getById(monitor.id)).state.consecutiveFailures).toBe(0);
    await runnerWith(2).run(monitor.id, 'SCHEDULE');
    expect(downOutcomes()).toHaveLength(0);
  });
});
