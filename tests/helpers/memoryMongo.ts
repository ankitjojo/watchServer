import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';

export interface TestMongo {
  /** Connection string of the in-memory server (never a real database). */
  uri: string;
  client: MongoClient;
  /** A database unique to this call, so test files never share data. */
  newDb(prefix?: string): Db;
  stop(): Promise<void>;
}

/** Starts a real in-memory MongoDB. Never connects to MONGO_URI / SOURCE_MONGO_URI. */
export async function startTestMongo(): Promise<TestMongo> {
  // Many test files start a server at once; occasionally mongod loses a startup race, so retry.
  let server: MongoMemoryServer | undefined;
  for (let attempt = 1; server === undefined; attempt++) {
    try {
      // The default 10 s launch timeout can be exceeded when many suites start mongod at once.
      server = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  const client = await MongoClient.connect(server.getUri());
  return {
    uri: server.getUri(),
    client,
    newDb: (prefix = 'test') => client.db(`${prefix}_${randomUUID().replace(/-/g, '')}`),
    async stop(): Promise<void> {
      await client.close();
      await server.stop();
    },
  };
}
