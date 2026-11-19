import type { MongoClient } from 'mongodb';
import { COLLECTIONS } from '../../src/constants/collections.js';
import { startTestMongo, type TestMongo } from '../helpers/memoryMongo.js';
import {
  MIN,
  createViaForm,
  startWorld,
  stopWorld,
  switchableSource,
  webhookForm,
  type World,
} from './support.js';

// Criterion 7: when the source DB is unreachable, only master recipients get a single MONITOR_ERROR
// email listing the affected monitors, a RECOVERED email follows when it answers again, and no STALE
// alerts are sent during the outage.
let sourceMongo: TestMongo;
let w: World;
let source: ReturnType<typeof switchableSource>;
let probeClient: MongoClient;
const ids: string[] = [];
const names = ['Razorpay', 'Apple Pay', 'Google Play'];

beforeAll(async () => {
  sourceMongo = await startTestMongo();
  probeClient = sourceMongo.client;
  source = switchableSource(sourceMongo.newDb('source'));
  w = await startWorld({ sourceDb: source.db });
  for (const [i, name] of names.entries()) {
    const collection = `gw_${i}`;
    await source.db
      .collection(collection)
      .insertOne({ dCreatedAt: new Date(w.clock.now().getTime() - 3 * 60 * MIN) });
    await source.db.collection(collection).createIndex({ dCreatedAt: -1 });
    ids.push(
      await createViaForm(
        await w.admin(),
        'webhook',
        webhookForm({ name, sourceCollection: collection, threshold: { value: '1', unit: 'HOUR' } }),
      ),
    );
  }
}, 180_000);

afterAll(async () => {
  await source.close();
  await stopWorld(w);
  await sourceMongo.stop();
  expect(probeClient).toBeDefined();
});

it('during the outage: one grouped MONITOR_ERROR to masters only, no STALE emails, monitors untouched', async () => {
  // One monitor already has its own (gateway) incident before the outage.
  await w.check('WEBHOOK', ids[0] ?? '');
  await w.dispatch();
  expect(w.subjects()).toEqual(['[payMonitor] WEBHOOK_STALE – Razorpay']);
  w.mailer.sent.length = 0;

  source.setDown(true);
  for (const id of ids) {
    const check = await w.check('WEBHOOK', id);
    expect(check?.result).toBe('ERROR');
    expect(check?.error?.message).not.toMatch(/127\.0\.0\.1|mongodb/);
  }
  // Inside the grouping window nothing has been sent yet.
  await w.dispatch();
  expect(w.mailer.sent).toHaveLength(0);

  w.clock.advance(60_000);
  await w.dispatch();
  expect(w.mailer.sent).toHaveLength(1);
  const [mail] = w.mailer.sent;
  expect(mail?.subject).toBe('[payMonitor] MONITOR_ERROR – Source DB (3 monitors)');
  expect(mail?.to).toEqual(['master@x.test']);
  for (const name of names) expect(mail?.text).toContain(name);

  // Further failing checks add nothing.
  w.clock.advance(10 * MIN);
  for (const id of ids) await w.check('WEBHOOK', id);
  await w.dispatch();
  expect(w.mailer.sent).toHaveLength(1);
  expect(await w.alerts({ eType: 'WEBHOOK_STALE' })).toHaveLength(1); // only the pre-outage one

  // The monitor's own incident and status were left alone by the outage.
  const first = await w.t.services.webhookMonitors.getById(ids[0] ?? '');
  expect(first.state).toMatchObject({ lastResult: 'ERROR', currentStatus: 'STALE' });
  expect(await w.t.services.incidents.findOpen(ids[0] ?? '')).not.toBeNull();
});

it('when the source answers again: one RECOVERED to masters, and normal alerting resumes', async () => {
  source.setDown(false);
  w.mailer.sent.length = 0;
  w.clock.advance(10 * MIN);
  for (const id of ids) await w.check('WEBHOOK', id);
  // The recovery mail is due 1 ms after it is stored (so it cannot overtake the outage mail); real time always passes that.
  w.clock.advance(10);
  await w.dispatch();

  const recovered = w.mailer.sent.filter((m) => m.subject === '[payMonitor] RECOVERED – Source DB');
  expect(recovered).toHaveLength(1);
  expect(recovered[0]?.to).toEqual(['master@x.test']);
  expect(await w.t.services.incidents.findOpenSourceError()).toBeNull();
  expect(await w.t.db.collection(COLLECTIONS.INCIDENTS).countDocuments({ eKind: 'SOURCE_ERROR' })).toBe(1);
  // The gateway problem is real (3 hours old data with a 1 hour threshold), so STALE incidents now open for the others.
  expect(w.mailer.sent.filter((m) => m.subject.includes('WEBHOOK_STALE')).length).toBeGreaterThanOrEqual(2);
});
