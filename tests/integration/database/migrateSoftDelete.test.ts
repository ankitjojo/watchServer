import type { Db } from 'mongodb';
import { migrateSoftDelete } from '../../../scripts/migrate-soft-delete.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startTestMongo();
}, 180_000);
afterAll(async () => {
  await mongo.stop();
}, 60_000);

/** A DB shaped like production before this change: plain unique sEmail index, no bIsDeleted. */
async function legacyDb(): Promise<Db> {
  const db = mongo.newDb('migrate');
  for (const name of ['users', 'recipients']) {
    await db.collection(name).createIndex({ sEmail: 1 }, { unique: true }, undefined);
    await db.collection(name).insertMany([{ sEmail: 'a@x.com' }, { sEmail: 'b@x.com' }]);
  }
  return db;
}
const names = async (db: Db, c: string): Promise<string[]> =>
  (await db.collection(c).indexes()).map((i) => i.name ?? '');

describe('migrateSoftDelete', () => {
  it('dry-run reports counts and writes nothing', async () => {
    const db = await legacyDb();
    const lines: string[] = [];
    const r = await migrateSoftDelete(db, { dryRun: true, log: (l) => lines.push(l) });
    expect(r.aborted).toBe(false);
    expect(r.collections[0]).toMatchObject({
      missingFlag: 2,
      backfilled: 0,
      newIndex: 'would-create',
      oldIndex: 'would-drop',
    });
    expect(await db.collection('users').countDocuments({ bIsDeleted: { $exists: true } })).toBe(0);
    expect(await names(db, 'users')).toContain('sEmail_1');
    expect(lines.join('\n')).not.toContain('@x.com');
  });

  it('backfills, adds the partial unique index, then drops the old one; re-run is a no-op', async () => {
    const db = await legacyDb();
    const r = await migrateSoftDelete(db, { dryRun: false });
    expect(r.collections.map((c) => [c.backfilled, c.newIndex, c.oldIndex])).toEqual([
      [2, 'created', 'dropped'],
      [2, 'created', 'dropped'],
    ]);
    expect(await names(db, 'recipients')).toEqual(['_id_', 'sEmail_1_active_unique']);
    const again = await migrateSoftDelete(db, { dryRun: false });
    expect(again.collections.map((c) => [c.backfilled, c.newIndex, c.oldIndex])).toEqual([
      [0, 'exists', 'absent'],
      [0, 'exists', 'absent'],
    ]);
  });

  it('after migrating: active emails stay unique, a deleted email can be reused', async () => {
    const db = await legacyDb();
    await migrateSoftDelete(db, { dryRun: false });
    const users = db.collection('users');
    await expect(users.insertOne({ sEmail: 'a@x.com', bIsDeleted: false })).rejects.toMatchObject({
      code: 11000,
    });
    await users.updateOne({ sEmail: 'a@x.com' }, { $set: { bIsDeleted: true } });
    await expect(users.insertOne({ sEmail: 'a@x.com', bIsDeleted: false })).resolves.toBeDefined();
  });

  it('aborts with no writes when active duplicates exist (case/space variants count)', async () => {
    const db = mongo.newDb('migrate');
    await db.collection('users').insertMany([{ sEmail: 'a@x.com' }, { sEmail: ' A@x.com' }]);
    await db.collection('recipients').insertOne({ sEmail: 'c@x.com' });
    const r = await migrateSoftDelete(db, { dryRun: false });
    expect(r.aborted).toBe(true);
    expect(r.collections[0]?.duplicateGroups).toBe(1);
    expect(await db.collection('recipients').countDocuments({ bIsDeleted: { $exists: true } })).toBe(0);
    expect(await names(db, 'recipients')).not.toContain('sEmail_1_active_unique');
  });

  it('does not drop the old index when creating the new one fails', async () => {
    const db = await legacyDb();
    // Same name, different shape: the script must stop, leaving the old index in place.
    await db.collection('users').createIndex({ sName: 1 }, { name: 'sEmail_1_active_unique' }, undefined);
    await expect(migrateSoftDelete(db, { dryRun: false })).rejects.toThrow(/unexpected options/);
    expect(await names(db, 'users')).toContain('sEmail_1');
  });

  it('normalises non-normalised emails before indexing, so variants cannot slip past the unique index', async () => {
    const db = mongo.newDb('migrate');
    await db.collection('users').insertMany([{ sEmail: '  Mixed@X.com ' }, { sEmail: 'ok@x.com' }]);
    const dry = await migrateSoftDelete(db, { dryRun: true });
    expect(dry.collections[0]).toMatchObject({ notNormalized: 1, normalized: 0 });
    expect(await db.collection('users').countDocuments({ sEmail: '  Mixed@X.com ' })).toBe(1);

    const r = await migrateSoftDelete(db, { dryRun: false });
    expect(r.collections[0]).toMatchObject({ notNormalized: 1, normalized: 1 });
    expect(await db.collection('users').countDocuments({ sEmail: 'mixed@x.com' })).toBe(1);
    await expect(
      db.collection('users').insertOne({ sEmail: 'mixed@x.com', bIsDeleted: false }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('reports existing index names (no emails) in the log', async () => {
    const db = await legacyDb();
    const lines: string[] = [];
    await migrateSoftDelete(db, { dryRun: true, log: (l) => lines.push(l) });
    expect(lines[0]).toContain('indexes=[_id_, sEmail_1]');
  });
});
