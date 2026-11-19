import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { hostname } from 'node:os';
import { MongoStore } from 'connect-mongo';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import { createApp } from './app.js';
import { buildServices, type ServiceDeps, type Services } from './compositionRoot.js';
import type { Config } from './config/loadConfig.js';
import { ensureMonitorDbIndexes } from './database/indexes.js';
import type { MonitorDbHandle } from './database/monitorDb.js';
import type { Logger } from './logger/index.js';
import { seedFirstAdmin } from './modules/auth/auth.seed.js';
import { seedMasterRecipient } from './modules/recipients/recipients.seed.js';
import { createLeaseLock, type LeaseLock } from './scheduler/leaseLock.js';
import type { Clock } from './types/clock.js';

/** What the runtime needs from the Source DB connection. server.ts owns the client itself. */
export interface SourceDbConnection {
  /** READ ONLY handle; only modules/sourceData uses it. */
  db: Db;
  tryConnect(): Promise<boolean>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface HttpListener {
  server: Server;
  /** Stops accepting connections and resolves when the open ones are done. */
  close(): Promise<void>;
}

export interface RuntimeDeps {
  config: Config;
  logger: Logger;
  clock: Clock;
  connectMonitorDb(): Promise<MonitorDbHandle>;
  sourceDb: SourceDbConnection;
  exit(code: number): void;
  /** Defaults to the real index creation (TD-31). Tests inject a failure. */
  ensureIndexes?: (db: Db) => Promise<void>;
  /** Defaults to listening on config.http.port. Tests use port 0. */
  listen?: (app: Express) => Promise<HttpListener>;
  /** Test seams passed through to buildServices (fake mailer, fast hasher, probe). */
  services?: Pick<ServiceDeps, 'mailer' | 'hasher' | 'probeDeps'>;
}

export interface Runtime {
  services: Services;
  lease: LeaseLock;
  http: HttpListener;
  /** Graceful stop (architecture 5.5). A second call forces exit(1). Resolves when it has finished. */
  shutdown(reason: string, exitCode: number): Promise<void>;
}

/** Extra time on top of the inner timeouts before the process is killed regardless (review M9). */
export const SHUTDOWN_GRACE_MS = 5000;

/**
 * Review M9: the hard exit must come after everything shutdown legitimately waits for: running checks
 * (SHUTDOWN_TIMEOUT_MS) and then the one email being sent (the send deadline), plus closing clients.
 */
export function hardExitTimeoutMs(config: Config): number {
  return config.shutdownTimeoutMs + config.alerts.sendTimeoutMs + SHUTDOWN_GRACE_MS;
}

/**
 * Lease callbacks (TD-05). The scheduler starts first: if that fails, the dispatcher never starts and
 * the rejection makes the lease release itself so the start is retried (review H3).
 */
export function createLeaderHooks(target: () => Pick<Services, 'scheduler' | 'dispatcher'> | undefined): {
  onAcquired(): Promise<void>;
  onLost(): Promise<void>;
} {
  return {
    async onAcquired() {
      const services = target();
      if (!services) throw new Error('Services are not built yet');
      await services.scheduler.start();
      services.dispatcher.start();
    },
    async onLost() {
      const services = target();
      if (!services) return;
      await services.scheduler.stop();
      await services.dispatcher.stop();
    },
  };
}

function defaultListen(port: number): (app: Express) => Promise<HttpListener> {
  return (app) =>
    new Promise((resolve, reject) => {
      const server = app.listen(port);
      server.once('error', reject);
      server.once('listening', () => {
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

/**
 * Startup (architecture 5.5): Monitor DB (fatal) → Source DB (non-blocking) → indexes (fatal, every
 * environment, TD-31) → services → seeds → listen → lease. Rejects on any fatal step.
 */
export async function startRuntime(deps: RuntimeDeps): Promise<Runtime> {
  const { config, logger, clock } = deps;
  const monitorDb = await deps.connectMonitorDb();
  await deps.sourceDb.tryConnect();

  try {
    await (deps.ensureIndexes ?? ensureMonitorDbIndexes)(monitorDb.db);
    logger.info({ event: 'monitorDb.indexesEnsured' }, 'Monitor DB indexes are in place');
  } catch (err) {
    // TD-31: dedupe keys and "one open incident" rely on unique indexes; never run without them.
    logger.fatal(
      { event: 'app.indexesFailed', errorName: err instanceof Error ? err.name : 'unknown' },
      'Could not create the Monitor DB indexes: refusing to start',
    );
    await Promise.allSettled([monitorDb.close(), deps.sourceDb.close()]);
    throw err;
  }

  const holder: { services?: Services } = {};
  const lease = createLeaseLock({
    db: monitorDb.db,
    clock,
    logger,
    ownerId: `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
    settings: { ttlMs: config.scheduler.leaseTtlMs, renewMs: config.scheduler.leaseRenewMs },
    ...createLeaderHooks(() => holder.services),
  });

  const services = buildServices({
    config,
    logger,
    monitorDb: monitorDb.db,
    sourceDb: deps.sourceDb.db,
    clock,
    canDispatch: () => lease.isHeld(),
    ...deps.services,
  });
  holder.services = services;
  await seedFirstAdmin({ users: services.users, seed: config.seed, logger });
  await seedMasterRecipient({ recipients: services.recipients, seed: config.seed, logger });

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
    sessionStore: MongoStore.create({
      client: monitorDb.client,
      dbName: config.monitorDb.name,
      collectionName: 'sessions',
      ttl: Math.floor(config.session.maxAgeMs / 1000),
    }),
    health: {
      monitorDbPing: () =>
        monitorDb.db.command({ ping: 1 }).then(
          () => true,
          () => false,
        ),
      sourceDbPing: () => deps.sourceDb.ping(),
      schedulerState: () =>
        services.scheduler.isActive() ? 'leader' : lease.isRunning() ? 'standby' : 'stopped',
    },
  });

  const http = await (deps.listen ?? defaultListen(config.http.port))(app);
  logger.info({ event: 'app.started', port: config.http.port, env: config.env }, `${config.appName} started`);
  // Listening first, so /healthz answers while the lease is being acquired.
  lease.start();

  let stopping: Promise<void> | undefined;
  function shutdown(reason: string, exitCode: number): Promise<void> {
    if (stopping) {
      deps.exit(1);
      return stopping;
    }
    logger.info({ event: 'app.stopping', reason }, 'Shutting down');
    const hardExit = setTimeout(() => {
      logger.error({ event: 'app.shutdownTimeout' }, 'Shutdown took too long: exiting now');
      deps.exit(exitCode || 1);
    }, hardExitTimeoutMs(config));
    hardExit.unref();
    // Review M9: stop the scheduler and dispatcher and release the lease WHILE the HTTP server drains,
    // so a long request can never keep this instance from handing over (architecture 5.5).
    stopping = Promise.all([http.close(), lease.stop()])
      .then(() => Promise.all([monitorDb.close(), deps.sourceDb.close()]))
      .then(
        () => undefined,
        (err: unknown) => {
          logger.error({ event: 'app.shutdownFailed', err }, 'Error while shutting down');
        },
      )
      .finally(() => {
        clearTimeout(hardExit);
        logger.info({ event: 'app.stopped' }, 'Stopped');
        deps.exit(exitCode);
      });
    return stopping;
  }

  return { services, lease, http, shutdown };
}
