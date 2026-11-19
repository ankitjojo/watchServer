import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import request from 'supertest';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { connectMonitorDb } from '../../../src/database/monitorDb.js';
import { createLogger } from '../../../src/logger/index.js';
import {
  createLeaderHooks,
  hardExitTimeoutMs,
  startRuntime,
  type HttpListener,
  type Runtime,
  type RuntimeDeps,
} from '../../../src/runtime.js';
import { systemClock } from '../../../src/types/clock.js';
import { createPasswordHasher } from '../../../src/utils/password.js';
import { createFakeMailer, type FakeMailer } from '../../helpers/fakeMailer.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { makeTestConfig } from '../../helpers/testConfig.js';

// Review M10: the production wiring (startup order, lease -> scheduler/dispatcher, shutdown) that
// server.ts used to hold, driven for real against a memory MongoDB.
let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo();
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

interface Harness {
  deps: RuntimeDeps;
  events: string[];
  exits: number[];
  mailer: FakeMailer;
  /** Human-readable log messages by event name (last one wins). */
  messages: Map<string, string>;
  dbName: string;
  sourceName: string;
}

function harness(over: Partial<RuntimeDeps> = {}, env: Record<string, string> = {}): Harness {
  const events: string[] = [];
  const messages = new Map<string, string>();
  const exits: number[] = [];
  const mailer = createFakeMailer();
  const dbName = `runtime_${Math.random().toString(36).slice(2)}`;
  const sourceName = `${dbName}_source`;
  const config = makeTestConfig({
    MONGO_DB_NAME: dbName,
    SEED_ADMIN_EMAIL: 'seed-admin@x.test',
    SEED_ADMIN_PASSWORD: 'seed-admin-password-1',
    MASTER_ALERT_EMAIL: 'master@x.test',
    LEASE_TTL_MS: '5000',
    LEASE_RENEW_MS: '1000',
    SHUTDOWN_TIMEOUT_MS: '1000',
    DISPATCHER_POLL_MS: '1000',
    ...env,
  });
  const logger = createLogger({
    level: 'info',
    destination: {
      write(line: string) {
        const parsed = JSON.parse(line) as { event?: string; msg?: string };
        if (parsed.event) events.push(parsed.event);
        if (parsed.event && parsed.msg) messages.set(parsed.event, parsed.msg);
      },
    },
  });
  const deps: RuntimeDeps = {
    config,
    logger,
    clock: systemClock,
    connectMonitorDb: () => connectMonitorDb({ uri: mongo.uri, name: dbName }, logger),
    sourceDb: {
      db: mongo.client.db(sourceName),
      tryConnect: () => Promise.resolve(true),
      ping: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    },
    exit: (code) => {
      exits.push(code);
    },
    listen: listenOnFreePort,
    services: { mailer, hasher: createPasswordHasher(4) },
    ...over,
  };
  return { deps, events, messages, exits, mailer, dbName, sourceName };
}

function listenOnFreePort(app: Express): Promise<HttpListener> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
            server.closeIdleConnections();
          }),
      });
    });
  });
}

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Startup has really finished: the scheduler runs and the session store's TTL index exists. */
async function settled(runtime: Runtime, dbName: string): Promise<void> {
  await waitFor(async () => {
    if (!runtime.services.scheduler.isActive()) return false;
    const indexes = await mongo.client
      .db(dbName)
      .collection('sessions')
      .indexes()
      .catch(() => []);
    return indexes.some((index) => index.key['expires'] === 1);
  });
}

const lockDoc = (dbName: string) =>
  mongo.client
    .db(dbName)
    .collection(COLLECTIONS.SCHEDULER_LOCKS)
    .findOne({ _id: 'scheduler' as never });

const before = (events: string[], a: string, b: string): boolean =>
  events.includes(a) && events.includes(b) && events.indexOf(a) < events.indexOf(b);

describe('startup (architecture 5.5, review M4/M10)', () => {
  let runtime: Runtime | undefined;
  afterEach(async () => {
    await runtime?.shutdown('test', 0);
    runtime = undefined;
  });

  it('in PRODUCTION: indexes, seeds, listen, then the lease starts the scheduler and the dispatcher', async () => {
    const h = harness(
      {},
      {
        NODE_ENV: 'production',
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
      },
    );
    // The source has one old document, so the first check is STALE and must be emailed.
    await mongo.client
      .db(h.sourceName)
      .collection('razor_pay_webhook_data')
      .insertOne({ dCreatedAt: new Date(Date.now() - 3_600_000) });
    runtime = await startRuntime(h.deps);

    // TD-31: indexes exist in production too (they used to be created outside production only).
    const alertIndexes = await mongo.client.db(h.dbName).collection(COLLECTIONS.ALERTS).indexes();
    expect(alertIndexes.find((i) => i.key['sDedupeKey'] === 1)?.unique).toBe(true);

    await waitFor(() => runtime?.services.scheduler.isActive() === true);
    expect(before(h.events, 'monitorDb.connected', 'monitorDb.indexesEnsured')).toBe(true);
    expect(before(h.events, 'monitorDb.indexesEnsured', 'seed.admin')).toBe(true);
    expect(before(h.events, 'seed.master', 'app.started')).toBe(true);
    expect(before(h.events, 'app.started', 'lease.acquired')).toBe(true);
    expect(before(h.events, 'lease.acquired', 'scheduler.started')).toBe(true);

    const port = (runtime.http.server.address() as AddressInfo).port;
    const ready = await request(`http://127.0.0.1:${port}`).get('/readyz');
    expect(ready.body).toMatchObject({ status: 'ready', scheduler: 'leader' });

    // The leader really runs checks and sends email: create a monitor, get the STALE mail.
    const admin = (await runtime.services.users.list())[0];
    await runtime.services.webhookMonitors.create(
      {
        name: 'Razorpay',
        gatewayName: 'Razorpay',
        sourceCollection: 'razor_pay_webhook_data',
        timestampKey: 'dCreatedAt',
        checkInterval: { value: 10, unit: 'MINUTE' },
        threshold: { value: 1, unit: 'MINUTE' },
        alertMode: 'ONCE_WITH_RECOVERY',
        isEnabled: true,
      },
      { id: admin?.id ?? '', email: admin?.email ?? '' },
    );
    await waitFor(() => h.mailer.sent.length === 1);
    expect(h.mailer.sent[0]?.subject).toBe('[payMonitor] WEBHOOK_STALE – Razorpay');
  }, 60_000);

  it('the startup log message names the product from APP_NAME; the event name stays app.started (plan app-name-from-env)', async () => {
    const custom = harness({}, { APP_NAME: 'Acme Watch' });
    const started = await startRuntime(custom.deps);
    expect(custom.messages.get('app.started')).toBe('Acme Watch started');
    expect(custom.events).toContain('app.started');
    // Let startup settle before stopping: lease taken, scheduler running, and connect-mongo's background
    // creation of the sessions index finished (closing the client mid-way rejects it, a known shutdown flake).
    await settled(started, custom.dbName);
    await started.shutdown('test', 0);

    const standard = harness();
    const defaults = await startRuntime(standard.deps);
    expect(standard.messages.get('app.started')).toBe('payMonitor started');
    await settled(defaults, standard.dbName);
    await defaults.shutdown('test', 0);
  }, 60_000);

  it('refuses to start when the indexes cannot be created, and never listens (TD-31)', async () => {
    let listened = false;
    const h = harness({
      ensureIndexes: () => Promise.reject(new Error('not authorized to create indexes')),
      listen: (app) => {
        listened = true;
        return listenOnFreePort(app);
      },
    });
    await expect(startRuntime(h.deps)).rejects.toThrow('not authorized');
    expect(listened).toBe(false);
    expect(h.events).toContain('app.indexesFailed');
    expect(h.events).not.toContain('app.started');
    expect(h.events).not.toContain('lease.acquired');
  }, 60_000);
});

describe('shutdown (architecture 5.5, review M9/M10)', () => {
  it('stops checks, releases the lease, closes the databases, then exits with the code', async () => {
    const h = harness();
    const runtime = await startRuntime(h.deps);
    await waitFor(() => runtime.services.scheduler.isActive());
    expect(await lockDoc(h.dbName)).not.toBeNull();

    await runtime.shutdown('SIGTERM', 0);

    expect(h.exits).toEqual([0]);
    expect(runtime.services.scheduler.isActive()).toBe(false);
    expect(runtime.lease.isHeld()).toBe(false);
    expect(await lockDoc(h.dbName)).toBeNull();
    expect(before(h.events, 'app.stopping', 'scheduler.stopped')).toBe(true);
    expect(before(h.events, 'scheduler.stopped', 'app.stopped')).toBe(true);
    expect(h.events.at(-1)).toBe('app.stopped');
  }, 60_000);

  it('hands the lease over even while an HTTP request keeps the server from closing (review M9)', async () => {
    const h = harness({
      listen: async (app) => {
        const real = await listenOnFreePort(app);
        // A request that never finishes: close() never resolves.
        return { server: real.server, close: () => new Promise<void>(() => undefined) };
      },
    });
    const runtime = await startRuntime(h.deps);
    await waitFor(() => runtime.services.scheduler.isActive());

    void runtime.shutdown('SIGTERM', 0);
    await waitFor(async () => (await lockDoc(h.dbName)) === null, 5000);
    expect(runtime.services.scheduler.isActive()).toBe(false);
    // Still waiting for HTTP: the hard-exit timer (not the lease) bounds this.
    expect(h.exits).toEqual([]);
    runtime.http.server.closeAllConnections();
    runtime.http.server.close();
  }, 60_000);

  it('the hard-exit timer outlasts everything shutdown waits for (checks + one email send)', () => {
    const config = makeTestConfig({ SHUTDOWN_TIMEOUT_MS: '15000', SMTP_TIMEOUT_MS: '15000' });
    expect(hardExitTimeoutMs(config)).toBeGreaterThan(config.shutdownTimeoutMs + config.alerts.sendTimeoutMs);
  });
});

describe('leader hooks (TD-05, review H3)', () => {
  it('starts the scheduler before the dispatcher, and a failed scheduler start never leaves the dispatcher running', async () => {
    const calls: string[] = [];
    const hooks = createLeaderHooks(() => ({
      scheduler: {
        start: () => {
          calls.push('scheduler.start');
          return Promise.reject(new Error('loadEnabled failed'));
        },
        stop: () => Promise.resolve(),
      } as never,
      dispatcher: {
        start: () => {
          calls.push('dispatcher.start');
        },
        stop: () => Promise.resolve(),
      } as never,
    }));
    await expect(hooks.onAcquired()).rejects.toThrow('loadEnabled failed');
    expect(calls).toEqual(['scheduler.start']);
  });
});
