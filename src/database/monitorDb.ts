import { MongoClient, type Db } from 'mongodb';
import type { Logger } from '../logger/index.js';
import { uriHost } from '../utils/uriHost.js';

export interface MonitorDbHandle {
  client: MongoClient;
  db: Db;
  close(): Promise<void>;
}

/** payMonitor's own database (read/write). Fails fast so the process manager can restart us. */
export async function connectMonitorDb(
  options: { uri: string; name: string },
  logger: Logger,
): Promise<MonitorDbHandle> {
  const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 10_000, appName: 'payMonitor' });
  await client.connect();
  logger.info({ event: 'monitorDb.connected', host: uriHost(options.uri) }, 'Monitor DB connected');
  return { client, db: client.db(options.name), close: () => client.close() };
}
