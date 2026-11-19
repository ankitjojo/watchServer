import { config } from '../src/config/index.js';
import { connectMonitorDb } from '../src/database/monitorDb.js';
import { ensureMonitorDbIndexes } from '../src/database/indexes.js';
import { createLogger } from '../src/logger/index.js';

// Creates Monitor DB indexes only. It never connects to the Source DB.
const logger = createLogger({ level: config.log.level });
const monitorDb = await connectMonitorDb(config.monitorDb, logger);
try {
  await ensureMonitorDbIndexes(monitorDb.db);
  logger.info({ event: 'indexes.ensured' }, 'Monitor DB indexes are in place');
} finally {
  await monitorDb.close();
}
