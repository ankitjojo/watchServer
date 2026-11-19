import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { MongoClient, type CommandStartedEvent } from 'mongodb';
import { startTestMongo, type TestMongo } from '../helpers/memoryMongo.js';
import {
  MIN,
  createViaForm,
  endpointForm,
  startFakeEndpoint,
  startWorld,
  stopWorld,
  switchableSource,
  webhookForm,
  type FakeEndpoint,
  type World,
} from './support.js';

// Criterion 13: the source DB user has the read role only, and no write call to the source DB exists in the code.
// Here: the code contains no write call, and a full run leaves the Source DB byte-for-byte unchanged.
let sourceMongo: TestMongo;
let monitoredClient: MongoClient;
let w: World;
let endpoint: FakeEndpoint;
let source: ReturnType<typeof switchableSource>;
const commands: CommandStartedEvent[] = [];

beforeAll(async () => {
  sourceMongo = await startTestMongo();
  monitoredClient = new MongoClient(sourceMongo.uri, { monitorCommands: true });
  monitoredClient.on('commandStarted', (event) => commands.push(event));
  await monitoredClient.connect();
  const seeded = monitoredClient.db('source_acceptance');
  for (const name of ['razor_pay_webhook_data', 'apple_pay_webhook_data']) {
    await seeded.collection(name).insertMany(
      [1, 2, 3].map((i) => ({
        dCreatedAt: new Date(Date.now() - i * MIN),
        oPayload: { sCardLast4: '4242' },
      })),
    );
  }
  await seeded.collection('razor_pay_webhook_data').createIndex({ dCreatedAt: -1 });
  source = switchableSource(seeded);
  endpoint = await startFakeEndpoint();
  w = await startWorld({ sourceDb: source.db });
}, 180_000);

afterAll(async () => {
  await endpoint.close();
  await source.close();
  await stopWorld(w);
  await monitoredClient.close();
  await sourceMongo.stop();
});

async function fingerprint(): Promise<string> {
  const db = monitoredClient.db('source_acceptance');
  const hash = createHash('sha256');
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  for (const name of names) {
    hash.update(name);
    hash.update(JSON.stringify(await db.collection(name).find({}).sort({ _id: 1 }).toArray()));
    hash.update(JSON.stringify((await db.collection(name).indexes()).map((i) => i.key)));
  }
  return hash.digest('hex');
}

it('a full run (create, check, outage, recovery, alerts) leaves the Source DB unchanged and only reads', async () => {
  const before = await fingerprint();
  commands.length = 0;

  const admin = await w.admin();
  const razor = await createViaForm(
    admin,
    'webhook',
    webhookForm({ name: 'Razor', sourceCollection: 'razor_pay_webhook_data' }),
  );
  const apple = await createViaForm(
    admin,
    'webhook',
    webhookForm({ name: 'Apple', sourceCollection: 'apple_pay_webhook_data' }),
  );
  const ep = await createViaForm(
    admin,
    'endpoint',
    endpointForm({ serverName: 'API', url: `${endpoint.base}/ok` }),
  );
  for (let i = 0; i < 3; i++) {
    await w.check('WEBHOOK', razor);
    await w.check('WEBHOOK', apple);
    await w.check('ENDPOINT', ep);
    w.clock.advance(10 * MIN);
  }
  source.setDown(true);
  await w.check('WEBHOOK', razor);
  source.setDown(false);
  w.clock.advance(MIN);
  await w.check('WEBHOOK', razor);
  await w.dispatch();

  const sent = new Set(commands.map((c) => c.commandName));
  const allowed = new Set([
    'find',
    'listCollections',
    'listIndexes',
    'hello',
    'isMaster',
    'ping',
    'endSessions',
  ]);
  expect([...sent].filter((name) => !allowed.has(name))).toEqual([]);
  expect(sent.has('find')).toBe(true);
  for (const find of commands.filter(
    (c) => c.commandName === 'find' && c.databaseName === 'source_acceptance',
  )) {
    const projection = find.command['projection'] as Record<string, number> | undefined;
    expect(Object.keys(projection ?? {}).sort()).toEqual(['_id', 'dCreatedAt']);
    expect(find.command['limit']).toBe(1);
    expect(find.command['maxTimeMS']).toEqual(expect.any(Number));
  }
  expect(await fingerprint()).toBe(before);
});

describe('no write call exists in the code', () => {
  const SRC = path.resolve(import.meta.dirname, '../../src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const full = path.join(dir, n);
      return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
    });
  const code = (file: string): string =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const WRITE =
    /\b(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|createIndex|createIndexes|createCollection|dropCollection|dropDatabase|dropIndex|renameCollection|runCommand|aggregate)\s*\(/;

  it('modules/sourceData contains none', () => {
    expect(files(path.join(SRC, 'modules/sourceData')).filter((f) => WRITE.test(code(f)))).toEqual([]);
  });

  it('only the entry point can even reach the Source DB client', () => {
    const importers = files(SRC)
      .filter((f) => /database\/sourceDb\.js/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(importers).toEqual(['server.ts']);
  });
});
