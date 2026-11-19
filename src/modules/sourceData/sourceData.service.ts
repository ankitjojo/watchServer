import type { Db } from 'mongodb';
import { ValidationError } from '../../errors/appError.js';
import type { Clock } from '../../types/clock.js';
import { parseSourceTimestamp, type TimestampFailure } from '../../utils/timestamp.js';
import { SourceDataError, toSourceDataError } from './sourceData.errors.js';
import { isValidCollectionName, isValidTimestampKey } from './sourceData.validation.js';

/** Newest document of a collection, reduced to what payMonitor is allowed to see. */
export interface LatestDoc {
  /** The source document's `_id` as text. */
  id: string;
  /** The raw value of the timestamp key. Untrusted: parse with parseSourceTimestamp. */
  rawValue: unknown;
}

export type KeyInspection =
  | { status: 'VALID'; latestTimestamp: Date; hasIndex: boolean }
  | { status: 'EMPTY_COLLECTION'; hasIndex: boolean }
  | { status: 'INVALID'; reason: TimestampFailure; hasIndex: boolean };

/**
 * Read-only access to the JOJO subscription DB (requirements section 5, security rules).
 * Allowed operations, the whole list: listCollections, find().sort().limit(1) with an
 * `_id` + key projection, and indexes(). There is deliberately no method that takes a filter,
 * a document or an update.
 */
export interface SourceDataService {
  listCollections(): Promise<string[]>;
  getLatestTimestamp(collection: string, key: string): Promise<LatestDoc | null>;
  /** D9: true when any index has `key` as its first field, ascending or descending. */
  hasTimestampIndex(collection: string, key: string): Promise<boolean>;
  /** FR-W2: reads the newest document and checks that the key holds a valid date. */
  inspectTimestampKey(collection: string, key: string): Promise<KeyInspection>;
}

function readPath(doc: Record<string, unknown>, key: string): unknown {
  let current: unknown = doc;
  for (const part of key.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function idToText(id: unknown): string {
  if (typeof id === 'object' && id !== null && 'toHexString' in id && typeof id.toHexString === 'function') {
    return (id as { toHexString(): string }).toHexString();
  }
  return String(id);
}

export function createSourceDataService(deps: {
  db: Db;
  queryTimeoutMs: number;
  clock: Clock;
}): SourceDataService {
  const { db, queryTimeoutMs, clock } = deps;

  async function listCollections(): Promise<string[]> {
    try {
      const infos = await db.listCollections({}, { nameOnly: true, maxTimeMS: queryTimeoutMs }).toArray();
      return infos
        .filter((info) => info.type === 'collection' && !info.name.startsWith('system.'))
        .map((info) => info.name)
        .sort();
    } catch (err) {
      throw toSourceDataError(err, 'list its collections');
    }
  }

  function assertCollectionName(collection: string): void {
    if (!isValidCollectionName(collection)) throw new ValidationError('Invalid collection name');
  }

  /** One `listCollections` filtered by name (database-design A.2): is it a real collection? */
  async function collectionExists(collection: string): Promise<boolean> {
    try {
      const infos = await db
        .listCollections({ name: collection }, { nameOnly: true, maxTimeMS: queryTimeoutMs })
        .toArray();
      return infos.some((info) => info.name === collection && info.type === 'collection');
    } catch (err) {
      throw toSourceDataError(err, 'list its collections');
    }
  }

  const notFound = (): SourceDataError =>
    new SourceDataError('COLLECTION_NOT_FOUND', 'The collection does not exist in the source database');

  /** The collection must exist in the live list (database-design A.2). */
  async function assertCollectionExists(collection: string): Promise<void> {
    assertCollectionName(collection);
    if (!(await collectionExists(collection))) throw notFound();
  }

  function assertKey(key: string): void {
    if (!isValidTimestampKey(key)) throw new ValidationError('Invalid timestamp key');
  }

  /**
   * Requirements 5 / review M8: ONE indexed find per check. Reading a missing collection is harmless
   * (empty result, nothing is created), so existence is checked only when the find came back empty,
   * to tell an empty collection (NO_DATA) from a missing one (the monitor's own error, TD-29).
   */
  async function getLatestTimestamp(collection: string, key: string): Promise<LatestDoc | null> {
    assertKey(key);
    assertCollectionName(collection);
    let doc: Record<string, unknown> | undefined;
    try {
      const docs = await db
        .collection(collection)
        .find({}, { projection: { _id: 1, [key]: 1 }, maxTimeMS: queryTimeoutMs })
        .sort({ [key]: -1 })
        .limit(1)
        .toArray();
      doc = docs[0];
    } catch (err) {
      throw toSourceDataError(err, 'read the latest document');
    }
    if (!doc) {
      if (!(await collectionExists(collection))) throw notFound();
      return null;
    }
    return { id: idToText(doc['_id']), rawValue: readPath(doc, key) };
  }

  async function hasTimestampIndex(collection: string, key: string): Promise<boolean> {
    assertKey(key);
    await assertCollectionExists(collection);
    try {
      const indexes = await db.collection(collection).indexes();
      return indexes.some((index) => {
        const fields = Object.entries(index.key as Record<string, unknown>);
        const [first] = fields;
        return first !== undefined && first[0] === key && (first[1] === 1 || first[1] === -1);
      });
    } catch (err) {
      throw toSourceDataError(err, 'read its indexes');
    }
  }

  async function inspectTimestampKey(collection: string, key: string): Promise<KeyInspection> {
    const [latest, hasIndex] = await Promise.all([
      getLatestTimestamp(collection, key),
      hasTimestampIndex(collection, key),
    ]);
    if (!latest) return { status: 'EMPTY_COLLECTION', hasIndex };
    const parsed = parseSourceTimestamp(latest.rawValue, clock.now());
    return parsed.ok
      ? { status: 'VALID', latestTimestamp: parsed.date, hasIndex }
      : { status: 'INVALID', reason: parsed.reason, hasIndex };
  }

  return Object.freeze({ listCollections, getLatestTimestamp, hasTimestampIndex, inspectTimestampKey });
}

/** Plain-language reasons shown to admins (FR-W2). They never include source values. */
export function describeInvalidKey(key: string, reason: TimestampFailure): string {
  switch (reason) {
    case 'MISSING':
      return `The newest document has no field "${key}".`;
    case 'INVALID_TYPE':
      return `The field "${key}" is not a date, an ISO-8601 string or an epoch number.`;
    case 'INVALID_DATE':
      return `The field "${key}" on the newest document does not hold a valid date.`;
    case 'FUTURE':
      return `The field "${key}" on the newest document is more than a day in the future.`;
  }
}
