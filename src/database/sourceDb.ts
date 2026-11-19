import { MongoClient, type Db } from 'mongodb';
import type { Logger } from '../logger/index.js';
import { uriHost } from '../utils/uriHost.js';

export interface SourceDbHandle {
  client: MongoClient;
  db: Db;
  /** Tries to connect once. Never throws: a down Source DB must not stop payMonitor (FR-A4a). */
  tryConnect(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * The JOJO subscription DB. READ ONLY: use a MongoDB user with the `read` role.
 * Only modules/sourceData may import this file (ESLint rule); it is the sole reader of this client.
 */
export function createSourceDb(options: { uri: string; name: string }, logger: Logger): SourceDbHandle {
  const client = new MongoClient(options.uri, {
    maxPoolSize: 5,
    readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: 5000,
    appName: 'payMonitor-source-reader',
  });
  const host = uriHost(options.uri);

  return {
    client,
    db: client.db(options.name),
    async tryConnect(): Promise<boolean> {
      try {
        await client.connect();
        logger.info({ event: 'sourceDb.connected', host }, 'Source DB connected');
        return true;
      } catch (err) {
        logger.warn(
          { event: 'sourceDb.unavailable', host, errorName: err instanceof Error ? err.name : 'unknown' },
          'Source DB unavailable at startup; webhook checks will report ERROR',
        );
        return false;
      }
    },
    close: () => client.close(),
  };
}
