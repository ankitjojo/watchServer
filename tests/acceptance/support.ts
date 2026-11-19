import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MongoClient, type Db } from 'mongodb';
import type request from 'supertest';
import { COLLECTIONS } from '../../src/constants/collections.js';
import { systemProbeDeps } from '../../src/modules/endpointMonitors/httpProbe.deps.js';
import type { Timers } from '../../src/scheduler/scheduler.js';
import { FakeClock } from '../helpers/fakeClock.js';
import { createFakeMailer, type FakeMailer } from '../helpers/fakeMailer.js';
import { startTestMongo, type TestMongo } from '../helpers/memoryMongo.js';
import { ADMIN, VIEWER, csrfFor, startTestApp, type TestApp } from '../helpers/testApp.js';

export const MIN = 60_000;
export const HOUR = 3_600_000;

export interface World {
  t: TestApp;
  clock: FakeClock;
  mailer: FakeMailer;
  actor: { id: string; email: string };
  mongo: TestMongo;
  /** Runs one SCHEDULED check, as the scheduler would. */
  check(
    type: 'WEBHOOK' | 'ENDPOINT',
    id: string,
  ): ReturnType<TestApp['services']['runners']['WEBHOOK']['run']>;
  /** Lets the dispatcher send everything that is due. */
  dispatch(): Promise<number>;
  subjects(): string[];
  admin(): Promise<request.Agent>;
  viewer(): Promise<request.Agent>;
  /** Inserts documents into a Source DB collection, each `ages[i]` ms older than the fake "now". */
  seedSource(collection: string, ages: number[], index?: boolean): Promise<void>;
  alerts(filter?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

export interface WorldOptions {
  config?: Record<string, string>;
  sourceDb?: Db;
  timers?: Timers;
  /** Default: master + one active normal + one inactive normal (the acceptance criteria use all three). */
  recipients?: boolean;
}

export async function startWorld(options: WorldOptions = {}): Promise<World> {
  const mongo = await startTestMongo();
  const clock = new FakeClock('2026-11-18T12:00:00.000Z');
  const mailer = createFakeMailer();
  const t = await startTestApp({
    mongo,
    clock,
    mailer,
    // Retry delays must not make tests slow.
    probeDeps: { ...systemProbeDeps, sleep: () => Promise.resolve() },
    ...(options.config ? { config: options.config } : {}),
    ...(options.sourceDb ? { sourceDb: options.sourceDb } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
  });
  const admin = (await t.services.users.list()).find((u) => u.role === 'ADMIN');
  const actor = { id: admin?.id ?? '', email: admin?.email ?? '' };
  if (options.recipients !== false) {
    await t.services.recipients.create({
      name: 'Master',
      email: 'master@x.test',
      type: 'MASTER',
      isActive: true,
    });
    await t.services.recipients.create({ name: 'Ops', email: 'ops@x.test', type: 'NORMAL', isActive: true });
    await t.services.recipients.create({ name: 'Off', email: 'off@x.test', type: 'NORMAL', isActive: false });
  }
  return {
    t,
    clock,
    mailer,
    actor,
    mongo,
    check: (type, id) => t.services.runners[type].run(id, 'SCHEDULE'),
    dispatch: () => t.services.dispatcher.runOnce(),
    subjects: () => mailer.sent.map((m) => m.subject),
    admin: () => t.loginAs(ADMIN),
    viewer: () => t.loginAs(VIEWER),
    async seedSource(collection, ages, index = true) {
      const target = t.sourceDb.collection(collection);
      if (ages.length === 0) {
        await t.sourceDb.createCollection(collection);
        return;
      }
      await target.insertMany(
        ages.map((age) => ({
          dCreatedAt: new Date(clock.now().getTime() - age),
          oPayload: { sCardLast4: '4242' },
        })),
      );
      if (index) await target.createIndex({ dCreatedAt: -1 });
    },
    alerts: (filter = {}) =>
      t.db.collection(COLLECTIONS.ALERTS).find(filter).sort({ dCreatedAt: 1, _id: 1 }).toArray(),
  };
}

export async function stopWorld(world: World | undefined): Promise<void> {
  await world?.t.services.scheduler.stop();
  await world?.mongo.stop();
}

/** Form body for a webhook monitor (the same fields the page posts). */
export function webhookForm(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Razorpay webhooks',
    gatewayName: 'Razorpay',
    sourceCollection: 'razor_pay_webhook_data',
    timestampKey: 'dCreatedAt',
    checkInterval: { value: '10', unit: 'MINUTE' },
    threshold: { value: '1', unit: 'MINUTE' },
    alertMode: 'ONCE_WITH_RECOVERY',
    repeatInterval: { value: '', unit: 'MINUTE' },
    isEnabled: 'on',
    ...over,
  };
}

export function endpointForm(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverName: 'Subscription API – prod',
    url: 'http://127.0.0.1:1/health',
    checkInterval: { value: '5', unit: 'MINUTE' },
    retryCount: '2',
    alertMode: 'ONCE_WITH_RECOVERY',
    repeatInterval: { value: '', unit: 'MINUTE' },
    isEnabled: 'on',
    ...over,
  };
}

/** Creates a monitor through the real form and returns its id. */
export async function createViaForm(
  agent: request.Agent,
  kind: 'webhook' | 'endpoint',
  body: Record<string, unknown>,
): Promise<string> {
  const token = await csrfFor(agent, `/${kind}-monitors/new`);
  const res = await agent
    .post(`/${kind}-monitors/new`)
    .type('form')
    .send({ _csrf: token, ...body });
  if (res.status !== 303)
    throw new Error(`create ${kind} monitor failed: ${res.status} ${res.text.slice(0, 300)}`);
  const list = await agent.get(`/${kind}-monitors`);
  const name = String(body['name'] ?? body['serverName']).replace(/&/g, '&amp;');
  const match = new RegExp(
    `href="/${kind}-monitors/([a-f0-9]{24})">${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}<`,
  ).exec(list.text);
  if (!match?.[1]) throw new Error('created monitor not found in the list');
  return match[1];
}

/** A local HTTP server whose behaviour tests can switch. Counts hits per path. */
export interface FakeEndpoint {
  base: string;
  hits: Record<string, number>;
  switchStatus: number;
  close(): Promise<void>;
}

export async function startFakeEndpoint(): Promise<FakeEndpoint> {
  const fake: FakeEndpoint = { base: '', hits: {}, switchStatus: 200, close: () => Promise.resolve() };
  const hanging = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    fake.hits[path] = (fake.hits[path] ?? 0) + 1;
    if (path === '/ok') res.writeHead(200).end('ok');
    else if (path === '/fail') res.writeHead(500).end('SECRET-BODY');
    else if (path === '/flaky') res.writeHead(fake.hits[path] === 1 ? 500 : 200).end();
    else if (path === '/switch') res.writeHead(fake.switchStatus).end();
    else if (path === '/slow') {
      hanging.add(res);
      res.on('close', () => hanging.delete(res));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  return fake;
}

/** A Source DB handle that can be switched between the real (seeded) database and an unreachable one. */
export function switchableSource(real: Db): { db: Db; setDown(down: boolean): void; close(): Promise<void> } {
  const deadClient = new MongoClient('mongodb://127.0.0.1:1/x', { serverSelectionTimeoutMS: 200 });
  const dead = deadClient.db('x');
  let down = false;
  const current = (): Db => (down ? dead : real);
  const db = {
    listCollections: (...args: Parameters<Db['listCollections']>) => current().listCollections(...args),
    collection: (name: string) => current().collection(name),
  } as unknown as Db;
  return { db, setDown: (value) => (down = value), close: () => deadClient.close() };
}
