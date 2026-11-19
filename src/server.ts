import { config } from './config/index.js';
import { connectMonitorDb } from './database/monitorDb.js';
import { createSourceDb } from './database/sourceDb.js';
import { createLogger } from './logger/index.js';
import { startRuntime } from './runtime.js';
import { systemClock } from './types/clock.js';

const logger = createLogger({ level: config.log.level });
const SOURCE_PING_TIMEOUT_MS = 2000;

/**
 * Process entry point: real clients, signals and exit only. Startup order, the lease → scheduler /
 * dispatcher wiring and shutdown live in runtime.ts, where tests can drive them (review M10).
 */
async function main(): Promise<void> {
  // The Source DB must NOT block startup: a down source is reported as MONITOR_ERROR (FR-A4a).
  const source = createSourceDb(config.sourceDb, logger);
  const runtime = await startRuntime({
    config,
    logger,
    clock: systemClock,
    // The Monitor DB is required: without it nothing can be stored. Fail fast; the process manager restarts us.
    connectMonitorDb: () => connectMonitorDb(config.monitorDb, logger),
    sourceDb: {
      db: source.db,
      tryConnect: () => source.tryConnect(),
      close: () => source.close(),
      ping: () =>
        Promise.race([
          source.db.command({ ping: 1 }).then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            setTimeout(() => {
              resolve(false);
            }, SOURCE_PING_TIMEOUT_MS).unref();
          }),
        ]),
    },
    exit: (code) => process.exit(code),
  });

  const stop = (reason: string, exitCode: number): void => {
    void runtime.shutdown(reason, exitCode);
  };
  process.on('SIGTERM', () => {
    stop('SIGTERM', 0);
  });
  process.on('SIGINT', () => {
    stop('SIGINT', 0);
  });
  process.on('unhandledRejection', (err) => {
    logger.fatal({ event: 'process.unhandledRejection', err }, 'Unhandled rejection');
    stop('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ event: 'process.uncaughtException', err }, 'Uncaught exception');
    stop('uncaughtException', 1);
  });
}

main().catch((err: unknown) => {
  logger.fatal({ event: 'app.startFailed', err }, 'Startup failed');
  process.exit(1);
});
