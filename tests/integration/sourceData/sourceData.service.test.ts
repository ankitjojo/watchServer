import { MongoClient, type CommandStartedEvent, type Db } from 'mongodb';
import { ValidationError } from '../../../src/errors/appError.js';
import { SourceDataError } from '../../../src/modules/sourceData/sourceData.errors.js';
import {
  createSourceDataService,
  type SourceDataService,
} from '../../../src/modules/sourceData/sourceData.service.js';
import { FakeClock } from '../../helpers/fakeClock.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';

let mongo: TestMongo;
let client: MongoClient;
let db: Db;
let service: SourceDataService;
const commands: CommandStartedEvent[] = [];
const clock = new FakeClock('2026-11-18T12:00:00Z');
const QUERY_TIMEOUT_MS = 4321;

beforeAll(async () => {
  mongo = await startTestMongo();
  // A separate client with command monitoring, to prove what the service sends to the server.
  client = new MongoClient(mongo.uri, { monitorCommands: true });
  client.on('commandStarted', (event) => commands.push(event));
  await client.connect();
  db = client.db('source_sandbox');
  const seed = mongo.client.db('source_sandbox');

  await seed.collection('razor_pay_webhook_data').insertMany([
    {
      dCreatedAt: new Date('2026-11-18T09:00:00Z'),
      payload: { card: '4111-SECRET' },
      headers: { auth: 'SECRET' },
    },
    {
      dCreatedAt: new Date('2026-11-18T11:00:00Z'),
      payload: { card: '4222-SECRET' },
      headers: { auth: 'SECRET' },
    },
    { dCreatedAt: new Date('2026-11-18T10:00:00Z'), payload: { card: '4333-SECRET' } },
  ]);
  await seed.collection('razor_pay_webhook_data').createIndex({ dCreatedAt: -1 });
  await seed.collection('asc_indexed').insertOne({ dCreatedAt: new Date() });
  await seed.collection('asc_indexed').createIndex({ dCreatedAt: 1 });
  await seed.collection('compound').insertOne({ dCreatedAt: new Date(), a: 1 });
  await seed.collection('compound').createIndex({ dCreatedAt: -1, a: 1 });
  await seed.collection('compound_second').insertOne({ dCreatedAt: new Date(), a: 1 });
  await seed.collection('compound_second').createIndex({ a: 1, dCreatedAt: -1 });
  await seed.collection('hashed').insertOne({ dCreatedAt: new Date() });
  await seed.collection('hashed').createIndex({ dCreatedAt: 'hashed' });
  await seed.collection('no_index').insertOne({ dCreatedAt: new Date() });
  await seed.createCollection('empty_webhooks');
  await seed.collection('bad_ts').insertOne({ dCreatedAt: 'not-a-date' });
  await seed.collection('missing_key').insertOne({ other: 1 });
  await seed.collection('nested').insertOne({ meta: { createdAt: new Date('2026-11-18T08:00:00Z') } });
  await seed.collection('seconds').insertOne({ dCreatedAt: Date.UTC(2026, 10, 18, 7) / 1000 });
  await seed.createCollection('a_view', { viewOn: 'no_index', pipeline: [] });

  service = createSourceDataService({ db, queryTimeoutMs: QUERY_TIMEOUT_MS, clock });
}, 180_000);

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

describe('listCollections', () => {
  it('lists real collections, sorted, without views or system collections', async () => {
    const names = await service.listCollections();
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(['razor_pay_webhook_data', 'empty_webhooks']));
    expect(names).not.toContain('a_view');
    expect(names.some((n) => n.startsWith('system.'))).toBe(false);
  });
});

describe('getLatestTimestamp', () => {
  it('returns only the _id and the key value of the newest document', async () => {
    const latest = await service.getLatestTimestamp('razor_pay_webhook_data', 'dCreatedAt');
    expect(latest).not.toBeNull();
    expect(Object.keys(latest ?? {}).sort()).toEqual(['id', 'rawValue']);
    expect(latest?.rawValue).toEqual(new Date('2026-11-18T11:00:00Z'));
    expect(JSON.stringify(latest)).not.toContain('SECRET');
  });

  it('asks the server for a projection of _id + key only, with maxTimeMS and a limit of 1', async () => {
    commands.length = 0;
    await service.getLatestTimestamp('razor_pay_webhook_data', 'dCreatedAt');
    const find = commands.find((c) => c.commandName === 'find');
    expect(find?.command['projection']).toEqual({ _id: 1, dCreatedAt: 1 });
    expect(find?.command['maxTimeMS']).toBe(QUERY_TIMEOUT_MS);
    expect(find?.command['limit']).toBe(1);
    const sort: unknown = find?.command['sort'];
    expect(sort instanceof Map ? Object.fromEntries(sort) : sort).toEqual({ dCreatedAt: -1 });
    expect(find?.command['filter']).toEqual({});
  });

  it('sends exactly ONE command (the find) per check of a collection with documents (review M8, requirements 5)', async () => {
    commands.length = 0;
    await service.getLatestTimestamp('razor_pay_webhook_data', 'dCreatedAt');
    expect(commands.map((c) => c.commandName)).toEqual(['find']);
  });

  it('checks existence only when the find came back empty, with a name filter and maxTimeMS', async () => {
    commands.length = 0;
    await expect(service.getLatestTimestamp('empty_webhooks', 'dCreatedAt')).resolves.toBeNull();
    expect(commands.map((c) => c.commandName)).toEqual(['find', 'listCollections']);
    const list = commands[1]?.command;
    expect(list?.['filter']).toEqual({ name: 'empty_webhooks' });
    expect(list?.['maxTimeMS']).toBe(QUERY_TIMEOUT_MS);
  });

  it('returns null for an empty collection', async () => {
    await expect(service.getLatestTimestamp('empty_webhooks', 'dCreatedAt')).resolves.toBeNull();
  });

  it('reads nested paths for dotted keys', async () => {
    const latest = await service.getLatestTimestamp('nested', 'meta.createdAt');
    expect(latest?.rawValue).toEqual(new Date('2026-11-18T08:00:00Z'));
  });

  it.each(['$where', 'a..b', 'a.', '', '1abc', 'x'.repeat(65), 'a b', 'a$b', '{"$gt":1}'])(
    'rejects the key %j before any query',
    async (key) => {
      await expect(service.getLatestTimestamp('razor_pay_webhook_data', key)).rejects.toBeInstanceOf(
        ValidationError,
      );
    },
  );

  it.each(['system.users', '../etc', 'a b', '', '$cmd'])('rejects the collection name %j', async (name) => {
    await expect(service.getLatestTimestamp(name, 'dCreatedAt')).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a collection that is not in the live list', async () => {
    await expect(service.getLatestTimestamp('does_not_exist', 'dCreatedAt')).rejects.toMatchObject({
      kind: 'COLLECTION_NOT_FOUND',
    });
  });
});

describe('hasTimestampIndex (D9)', () => {
  it.each([
    ['razor_pay_webhook_data', true],
    ['asc_indexed', true],
    ['compound', true],
    ['compound_second', false],
    ['hashed', false],
    ['no_index', false],
  ])('%s -> %s', async (collection, expected) => {
    await expect(service.hasTimestampIndex(collection, 'dCreatedAt')).resolves.toBe(expected);
  });
});

describe('inspectTimestampKey (FR-W2)', () => {
  it('accepts a BSON Date and reports the newest timestamp and index', async () => {
    await expect(service.inspectTimestampKey('razor_pay_webhook_data', 'dCreatedAt')).resolves.toEqual({
      status: 'VALID',
      latestTimestamp: new Date('2026-11-18T11:00:00Z'),
      hasIndex: true,
    });
  });
  it('accepts epoch seconds', async () => {
    const result = await service.inspectTimestampKey('seconds', 'dCreatedAt');
    expect(result).toMatchObject({ status: 'VALID', latestTimestamp: new Date('2026-11-18T07:00:00Z') });
  });
  it('flags an empty collection (allowed with a warning)', async () => {
    await expect(service.inspectTimestampKey('empty_webhooks', 'dCreatedAt')).resolves.toMatchObject({
      status: 'EMPTY_COLLECTION',
    });
  });
  it.each([
    ['bad_ts', 'dCreatedAt', 'INVALID_DATE'],
    ['missing_key', 'dCreatedAt', 'MISSING'],
  ])('rejects %s / %s as %s', async (collection, key, reason) => {
    await expect(service.inspectTimestampKey(collection, key)).resolves.toMatchObject({
      status: 'INVALID',
      reason,
    });
  });
});

describe('read-only guarantee at runtime', () => {
  it('only ever sent read commands to the server', async () => {
    commands.length = 0;
    await service.listCollections();
    await service.inspectTimestampKey('razor_pay_webhook_data', 'dCreatedAt');
    await service.hasTimestampIndex('no_index', 'dCreatedAt');
    const names = new Set(commands.map((c) => c.commandName));
    const allowed = new Set([
      'find',
      'listCollections',
      'listIndexes',
      'hello',
      'isMaster',
      'ping',
      'endSessions',
    ]);
    for (const name of names) expect(allowed.has(name)).toBe(true);
    expect(names.has('find')).toBe(true);
  });
});

describe('an unreachable Source DB', () => {
  it('fails with a safe SourceDataError (kind UNAVAILABLE) that does not leak the host', async () => {
    const dead = new MongoClient('mongodb://127.0.0.1:1/x', { serverSelectionTimeoutMS: 300 });
    const unreachable = createSourceDataService({ db: dead.db('x'), queryTimeoutMs: 1000, clock });
    const error = await unreachable.listCollections().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceDataError);
    expect(error).toMatchObject({ kind: 'UNAVAILABLE' });
    expect((error as Error).message).not.toMatch(/127\.0\.0\.1|mongodb/);
    await dead.close();
  });
});
