import type { Express } from 'express';
import request from 'supertest';
import type { Db } from 'mongodb';
import { createApp } from '../../src/app.js';
import { buildServices, type Services } from '../../src/compositionRoot.js';
import type { Config } from '../../src/config/loadConfig.js';
import { ensureMonitorDbIndexes } from '../../src/database/indexes.js';
import { createLogger } from '../../src/logger/index.js';
import { createPasswordHasher } from '../../src/utils/password.js';
import { systemClock, type Clock } from '../../src/types/clock.js';
import type { AlertsPort } from '../../src/modules/alerts/alerts.port.js';
import type { ProbeDeps } from '../../src/modules/endpointMonitors/httpProbe.js';
import type { Timers } from '../../src/scheduler/scheduler.js';
import type { Mailer } from '../../src/notifications/email/transport.js';
import { createFakeMailer } from './fakeMailer.js';
import { makeTestConfig } from './testConfig.js';
import { startTestMongo, type TestMongo } from './memoryMongo.js';

export const ADMIN = { email: 'admin@test.local', password: 'admin-password-123' };
export const VIEWER = { email: 'viewer@test.local', password: 'viewer-password-123' };

export interface TestApp {
  app: Express;
  config: Config;
  db: Db;
  /** The fake Source DB (a second database on the same memory server). Seed it, never the app. */
  sourceDb: Db;
  services: Services;
  stop(): Promise<void>;
  /** A fresh, not-logged-in client. */
  anonymous(): request.Agent;
  /** A client logged in through the real login form. */
  loginAs(creds: { email: string; password: string }): Promise<request.Agent>;
}

export function extractCsrf(html: string): string {
  const match = /<meta name="csrf-token" content="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error('csrf token not found in page');
  return match[1];
}

/** Current CSRF token for an agent's session (read from a rendered page). */
export async function csrfFor(agent: request.Agent, path = '/login'): Promise<string> {
  const res = await agent.get(path);
  return extractCsrf(res.text);
}

export async function startTestApp(
  options: {
    config?: Record<string, string>;
    mongo?: TestMongo;
    sourceDb?: Db;
    alerts?: AlertsPort;
    mailer?: Mailer;
    probeDeps?: ProbeDeps;
    clock?: Clock;
    timers?: Timers;
  } = {},
): Promise<TestApp> {
  const mongo = options.mongo ?? (await startTestMongo());
  const db = mongo.newDb('app');
  const sourceDb = options.sourceDb ?? mongo.newDb('source');
  await ensureMonitorDbIndexes(db);
  const config = makeTestConfig(options.config);
  const logger = createLogger({ level: 'silent' });
  // Cost 4 keeps tests fast; production uses 12.
  const services = buildServices({
    config,
    logger,
    monitorDb: db,
    sourceDb,
    clock: options.clock ?? systemClock,
    mailer: options.mailer ?? createFakeMailer(),
    ...(options.alerts ? { alerts: options.alerts } : {}),
    ...(options.probeDeps ? { probeDeps: options.probeDeps } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
    hasher: createPasswordHasher(4),
  });
  await services.users.create({
    name: 'Admin',
    email: ADMIN.email,
    role: 'ADMIN',
    password: ADMIN.password,
    isActive: true,
  });
  await services.users.create({
    name: 'Viewer',
    email: VIEWER.email,
    role: 'VIEWER',
    password: VIEWER.password,
    isActive: true,
  });

  const app = createApp({
    config,
    logger,
    auth: services.auth,
    users: services.users,
    recipients: services.recipients,
    sourceData: services.sourceData,
    webhookMonitors: services.webhookMonitors,
    endpointMonitors: services.endpointMonitors,
    alerts: services.alerts,
    monitorActions: services.monitorActions,
    dashboard: services.dashboard,
    monitorDetail: services.monitorDetail,
    health: {
      monitorDbPing: () => Promise.resolve(true),
      sourceDbPing: () => Promise.resolve(false),
      schedulerState: () => 'stopped',
    },
  });

  return {
    app,
    config,
    db,
    sourceDb,
    services,
    stop: async () => {
      if (!options.mongo) await mongo.stop();
    },
    anonymous: () => request.agent(app),
    async loginAs(creds) {
      const agent = request.agent(app);
      const token = await csrfFor(agent);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ _csrf: token, ...creds });
      if (res.status !== 303) throw new Error(`login failed with status ${res.status}`);
      return agent;
    },
  };
}
