import type { Db } from 'mongodb';
import { ensureMonitorDbIndexes } from '../../../src/database/indexes.js';
import { isDuplicateKeyError } from '../../../src/errors/mongoErrors.js';
import { toRecipientDoc } from '../../../src/modules/recipients/recipients.mapper.js';
import {
  createRecipientsRepository,
  type RecipientsRepository,
} from '../../../src/modules/recipients/recipients.repository.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';

let mongo: TestMongo;
let db: Db;
let repo: RecipientsRepository;
const now = new Date('2026-11-18T10:00:00Z');
const add = (email: string, type: 'NORMAL' | 'MASTER', isActive: boolean, name = email) =>
  repo.insert(toRecipientDoc({ name, email, type, isActive }, { now }));

beforeAll(async () => {
  mongo = await startTestMongo();
  db = mongo.newDb('recipients');
  await ensureMonitorDbIndexes(db);
  repo = createRecipientsRepository(db);
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

describe('recipients repository', () => {
  it('rejects a duplicate email through the unique index', async () => {
    await add('dup@x.test', 'NORMAL', true);
    let duplicate = false;
    try {
      await add('dup@x.test', 'NORMAL', true);
    } catch (err) {
      duplicate = isDuplicateKeyError(err);
    }
    expect(duplicate).toBe(true);
  });

  it('findAudience: ALL = active normal + all masters; MASTERS_ONLY = masters', async () => {
    await add('m@x.test', 'MASTER', true, 'Master');
    await add('active@x.test', 'NORMAL', true);
    await add('inactive@x.test', 'NORMAL', false);
    const all = (await repo.findAudience('ALL')).map((r) => r.email);
    expect(all).toEqual(expect.arrayContaining(['m@x.test', 'active@x.test']));
    expect(all).not.toContain('inactive@x.test');
    expect((await repo.findAudience('MASTERS_ONLY')).map((r) => r.email)).toEqual(['m@x.test']);
  });

  it('list puts masters first', async () => {
    const list = await repo.list();
    expect(list[0]?.type).toBe('MASTER');
  });

  it('counts masters and updates / deletes by id', async () => {
    expect(await repo.countMasters()).toBe(1);
    const created = await add('edit@x.test', 'NORMAL', true);
    expect(await repo.update(created.id, { sName: 'Edited' })).toMatchObject({ name: 'Edited' });
    expect(await repo.delete(created.id)).toBe(true);
    expect(await repo.findById(created.id)).toBeNull();
  });
});
