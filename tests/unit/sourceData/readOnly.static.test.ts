import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { createSourceDataService } from '../../../src/modules/sourceData/sourceData.service.js';

const SRC = path.resolve(import.meta.dirname, '../../../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Acceptance criterion 13: no write call to the Source DB exists in the code.
const FORBIDDEN =
  /\b(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|drop|dropCollection|dropDatabase|dropIndex|dropIndexes|createIndex|createIndexes|createCollection|bulkWrite|aggregate|findOneAndUpdate|findOneAndDelete|findOneAndReplace|renameCollection|rename|command|runCommand|watch)\s*\(/;

describe('Source DB boundary (static scan)', () => {
  it('the sourceData module contains no write or admin operation', () => {
    const offenders = files(path.join(SRC, 'modules/sourceData')).filter((file) =>
      FORBIDDEN.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('the service exposes exactly four read methods and is frozen', () => {
    // A stub Db is enough: nothing runs until a method is called.
    const service = createSourceDataService({
      db: new MongoClient('mongodb://127.0.0.1:1').db('x'),
      queryTimeoutMs: 1,
      clock: { now: () => new Date() },
    });
    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.keys(service).sort()).toEqual([
      'getLatestTimestamp',
      'hasTimestampIndex',
      'inspectTimestampKey',
      'listCollections',
    ]);
    // (collection, key) at most: there is no parameter that could carry a filter, a document or an update.
    for (const name of Object.keys(service) as (keyof typeof service)[]) {
      expect(service[name].length).toBeLessThanOrEqual(2);
    }
  });

  it('only the process entry point imports the Source DB client', () => {
    const importers = files(SRC)
      .filter((file) => /from\s+['"][^'"]*database\/sourceDb\.js['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(importers).toEqual(['server.ts']);
  });

  it('only the entry point creates or holds the Source DB client handle', () => {
    const offenders = files(SRC)
      .filter((file) => !/database\/sourceDb\.ts$|server\.ts$/.test(file))
      .filter((file) => /\b(createSourceDb|SourceDbHandle)\b/.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
