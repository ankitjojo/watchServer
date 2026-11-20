/**
 * One-off, idempotent Monitor DB migration for soft delete (docs/implementation_plans/deleted-monitors.md §5).
 *
 *   npm run db:migrate-soft-delete             dry-run (default): counts only, writes nothing
 *   npm run db:migrate-soft-delete -- --apply  runs it (database rule: scripts default to dry-run)
 *
 * For `users` and `recipients` it:
 *   1. aborts (before any write) if two NON-deleted documents share an email, compared trimmed + lower-cased;
 *   2. backfills `bIsDeleted: false` ONLY where the field is missing (a partial index ignores missing fields);
 *   3. normalises `sEmail` (trim + lower-case) on non-deleted documents that are not already normalised, because
 *      the unique index compares exact bytes and would not catch case/space variants of those emails
 *      (step 1 already guarantees this cannot create a duplicate);
 *   4. creates the new unique index on `sEmail` (partial: `bIsDeleted: false`) under a new name;
 *   5. only after (4) succeeded, drops the old plain unique index `sEmail_1`.
 * Both unique indexes coexist between (4) and (5), so uniqueness is never off. If (4) fails, nothing is dropped.
 * Safe to re-run: every step checks the current state first.
 *
 * Safety: touches the Monitor DB only (never connects to the Source DB), logs counts only (never emails), and the CLI
 * refuses any host that is not localhost. Shared or production databases need fresh approval (see git-and-change-safety).
 * Run it before starting the new app version, with the old app stopped: old code inserts documents without
 * `bIsDeleted`, and those would not be covered by the new index.
 *
 * Rollback: the backfilled field is harmless, keep it. To go back to the old index:
 *   db.users.createIndex({ sEmail: 1 }, { unique: true, name: 'sEmail_1' })   (same for recipients)
 * That fails if a deleted record shares its email with an active one; resolve those first. Then drop
 * `sEmail_1_active_unique`.
 */
import { pathToFileURL } from 'node:url';
import type { Collection, Db, Document } from 'mongodb';
import { COLLECTIONS } from '../src/constants/collections.js';

const OLD_INDEX = 'sEmail_1';
const NEW_INDEX = 'sEmail_1_active_unique';
const TARGETS = [COLLECTIONS.USERS, COLLECTIONS.RECIPIENTS] as const;
// Missing field counts as "not deleted" (old documents), exactly like the repositories will treat it.
const ACTIVE = { bIsDeleted: { $ne: true } } as const;

export interface CollectionReport {
  collection: string;
  total: number;
  missingFlag: number;
  /** Groups of non-deleted documents sharing a trimmed, lower-cased email. */
  duplicateGroups: number;
  /** Non-deleted emails that are not already trimmed + lower-cased (rewritten by --apply). */
  notNormalized: number;
  /** Index names present before the run. */
  indexes: string[];
  backfilled: number;
  normalized: number;
  newIndex: 'exists' | 'created' | 'would-create';
  oldIndex: 'absent' | 'dropped' | 'would-drop';
}

export interface MigrationReport {
  dryRun: boolean;
  aborted: boolean;
  collections: CollectionReport[];
}

interface Options {
  dryRun: boolean;
  log?: (line: string) => void;
}

async function inspect(
  col: Collection,
): Promise<Omit<CollectionReport, 'newIndex' | 'oldIndex' | 'backfilled' | 'normalized'>> {
  const [total, missingFlag, notNormalized, groups, indexes] = await Promise.all([
    col.countDocuments({}),
    col.countDocuments({ bIsDeleted: { $exists: false } }),
    col.countDocuments({
      ...ACTIVE,
      $expr: { $ne: ['$sEmail', { $toLower: { $trim: { input: '$sEmail' } } }] },
    }),
    col
      .aggregate<{ n: number }>([
        { $match: ACTIVE },
        { $group: { _id: { $toLower: { $trim: { input: '$sEmail' } } }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $count: 'n' },
      ])
      .toArray(),
    // A missing collection has no indexes; listIndexes then throws NamespaceNotFound.
    col.indexes().catch(() => [] as Document[]),
  ]);
  return {
    indexes: indexes.map((i) => String(i['name'])),
    collection: col.collectionName,
    total,
    missingFlag,
    notNormalized,
    duplicateGroups: groups[0]?.n ?? 0,
  };
}

async function indexByName(col: Collection, name: string): Promise<Document | undefined> {
  // A missing collection has no indexes; listIndexes then throws NamespaceNotFound.
  const all = await col.indexes().catch(() => [] as Document[]);
  return all.find((i) => i['name'] === name);
}

function isNewIndexShape(index: Document): boolean {
  const filter = index['partialFilterExpression'] as Document | undefined;
  return index['unique'] === true && filter?.['bIsDeleted'] === false;
}

export async function migrateSoftDelete(db: Db, options: Options): Promise<MigrationReport> {
  const log = options.log ?? (() => undefined);
  const mode = options.dryRun ? 'dry-run' : 'run';
  const reports: CollectionReport[] = [];

  // Pass 1: read-only. Abort before ANY write if a duplicate would make the new index impossible.
  const before = new Map<string, Awaited<ReturnType<typeof inspect>>>();
  for (const name of TARGETS) {
    const found = await inspect(db.collection(name));
    before.set(name, found);
    log(
      `[${mode}] ${name}: total=${found.total} missingFlag=${found.missingFlag} duplicateGroups=${found.duplicateGroups} notNormalized=${found.notNormalized} indexes=[${found.indexes.join(', ')}]`,
    );
  }
  const blocked = [...before.values()].filter((r) => r.duplicateGroups > 0);
  if (blocked.length > 0) {
    log(
      `[${mode}] ABORTED, nothing written: duplicate emails among non-deleted documents. Fix them, then re-run.`,
    );
    return {
      dryRun: options.dryRun,
      aborted: true,
      collections: [...before.values()].map((r) => ({
        ...r,
        backfilled: 0,
        normalized: 0,
        newIndex: 'would-create',
        oldIndex: 'would-drop',
      })),
    };
  }

  // Pass 2: write (or just describe, in dry-run).
  for (const name of TARGETS) {
    const col = db.collection(name);
    const found = before.get(name);
    if (found === undefined) continue;

    let backfilled = 0;
    if (found.missingFlag > 0 && !options.dryRun) {
      backfilled = (await col.updateMany({ bIsDeleted: { $exists: false } }, { $set: { bIsDeleted: false } }))
        .modifiedCount;
    }

    let normalized = 0;
    if (found.notNormalized > 0 && !options.dryRun) {
      normalized = (
        await col.updateMany(
          { ...ACTIVE, $expr: { $ne: ['$sEmail', { $toLower: { $trim: { input: '$sEmail' } } }] } },
          [{ $set: { sEmail: { $toLower: { $trim: { input: '$sEmail' } } } } }],
        )
      ).modifiedCount;
    }

    const existingNew = await indexByName(col, NEW_INDEX);
    if (existingNew !== undefined && !isNewIndexShape(existingNew)) {
      throw new Error(`${name}.${NEW_INDEX} exists with unexpected options; inspect it by hand`);
    }
    let newIndex: CollectionReport['newIndex'] = 'exists';
    if (existingNew === undefined) {
      newIndex = 'would-create';
      if (!options.dryRun) {
        await col.createIndex(
          { sEmail: 1 },
          { name: NEW_INDEX, unique: true, partialFilterExpression: { bIsDeleted: false } },
          undefined,
        );
        newIndex = 'created';
      }
    }

    // Drop the old plain unique index only once the new one is known to exist.
    const old = await indexByName(col, OLD_INDEX);
    let oldIndex: CollectionReport['oldIndex'] = 'absent';
    if (old !== undefined) {
      oldIndex = 'would-drop';
      if (!options.dryRun && newIndex !== 'would-create') {
        await col.dropIndex(OLD_INDEX);
        oldIndex = 'dropped';
      }
    }

    log(
      `[${mode}] ${name}: backfilled=${backfilled} normalized=${normalized} newIndex=${newIndex} oldIndex=${oldIndex}`,
    );
    reports.push({ ...found, backfilled, normalized, newIndex, oldIndex });
  }

  if (!options.dryRun) {
    // Old-code inserts that slipped in during the run lack the flag and are not covered by the new index.
    for (const name of TARGETS) {
      const late = await db.collection(name).countDocuments({ bIsDeleted: { $exists: false } });
      if (late > 0)
        log(`WARNING ${name}: ${late} document(s) still lack bIsDeleted; stop the old app and re-run.`);
    }
  }
  return { dryRun: options.dryRun, aborted: false, collections: reports };
}

// ---- CLI ----
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalUri(uri: string): boolean {
  if (uri.startsWith('mongodb+srv://')) return false;
  const match = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri);
  const hosts = (match?.[1] ?? '').split(',');
  return hosts.every(
    (h) => LOCAL_HOSTS.has(h.replace(/:\d+$/, '').toLowerCase()) || LOCAL_HOSTS.has(h.toLowerCase()),
  );
}

async function main(): Promise<void> {
  // Imported lazily so tests can import migrateSoftDelete without loading (and validating) the app config.
  const { config } = await import('../src/config/index.js');
  const { connectMonitorDb } = await import('../src/database/monitorDb.js');
  const { createLogger } = await import('../src/logger/index.js');

  if (!isLocalUri(config.monitorDb.uri)) {
    process.stderr.write(
      'Refusing: MONGO_URI is not a localhost database. Shared/production needs fresh approval.\n',
    );
    process.exitCode = 2;
    return;
  }
  const dryRun = !process.argv.includes('--apply') || process.argv.includes('--dry-run');
  const handle = await connectMonitorDb(config.monitorDb, createLogger({ level: config.log.level }));
  try {
    const report = await migrateSoftDelete(handle.db, {
      dryRun,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    if (report.aborted) process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
