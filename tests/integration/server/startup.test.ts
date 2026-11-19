import { createSourceDb } from '../../../src/database/sourceDb.js';
import { createLogger } from '../../../src/logger/index.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;

beforeAll(async () => {
  mongo = await startTestMongo();
  t = await startTestApp({ mongo });
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

describe('startup with an unreachable Source DB (FR-A4a)', () => {
  it('tryConnect reports false instead of throwing', async () => {
    const source = createSourceDb(
      { uri: 'mongodb://127.0.0.1:1/x?serverSelectionTimeoutMS=500', name: 'x' },
      createLogger({ level: 'silent' }),
    );
    await expect(source.tryConnect()).resolves.toBe(false);
    await source.close();
  }, 30_000);

  it('serves /healthz and reports the Source DB as down on /readyz without hostnames', async () => {
    const health = await t.anonymous().get('/healthz');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
    const ready = await t.anonymous().get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready', monitorDb: 'up', sourceDb: 'down', scheduler: 'stopped' });
    expect(JSON.stringify(ready.body)).not.toMatch(/mongodb|127\.0\.0\.1|localhost/);
  });
});
