import { evaluateStaleness } from '../../../src/modules/webhookMonitors/staleness.evaluator.js';

const now = new Date('2026-11-18T12:00:00.000Z');
const HOUR = 3_600_000;
const doc = (rawValue: unknown) => ({ id: 'a'.repeat(24), rawValue });

describe('evaluateStaleness (FR-W3)', () => {
  it('age == threshold is OK', () => {
    const result = evaluateStaleness({
      latest: doc(new Date(now.getTime() - 2 * HOUR)),
      thresholdMs: 2 * HOUR,
      now,
    });
    expect(result).toMatchObject({ result: 'OK', ageMs: 2 * HOUR });
  });

  it('threshold + 1 ms is STALE', () => {
    const result = evaluateStaleness({
      latest: doc(new Date(now.getTime() - 2 * HOUR - 1)),
      thresholdMs: 2 * HOUR,
      now,
    });
    expect(result).toMatchObject({ result: 'STALE', ageMs: 2 * HOUR + 1 });
  });

  it('a fresh document is OK with its id, timestamp and age', () => {
    const ts = new Date(now.getTime() - 60_000);
    expect(evaluateStaleness({ latest: doc(ts), thresholdMs: HOUR, now })).toEqual({
      result: 'OK',
      lastDocId: 'a'.repeat(24),
      lastDocTimestamp: ts,
      ageMs: 60_000,
    });
  });

  it('an empty collection is NO_DATA', () => {
    expect(evaluateStaleness({ latest: null, thresholdMs: HOUR, now })).toEqual({
      result: 'NO_DATA',
      reason: 'EMPTY_COLLECTION',
    });
  });

  it.each([
    [undefined, 'MISSING'],
    [null, 'MISSING'],
    ['not-a-date', 'INVALID_DATE'],
    [{ nested: true }, 'INVALID_TYPE'],
    [new Date(now.getTime() + 3 * 86_400_000), 'FUTURE'],
  ])('a %j timestamp is NO_DATA (%s) and keeps the document id', (rawValue, reason) => {
    expect(evaluateStaleness({ latest: doc(rawValue), thresholdMs: HOUR, now })).toEqual({
      result: 'NO_DATA',
      reason,
      lastDocId: 'a'.repeat(24),
    });
  });

  it('understands ISO strings and epoch seconds / milliseconds', () => {
    const base = now.getTime() - 30 * 60_000;
    for (const raw of [new Date(base).toISOString(), Math.floor(base / 1000), base]) {
      const result = evaluateStaleness({ latest: doc(raw), thresholdMs: HOUR, now });
      expect(result.result).toBe('OK');
    }
    const seconds = evaluateStaleness({
      latest: doc(Math.floor((now.getTime() - 3 * HOUR) / 1000)),
      thresholdMs: HOUR,
      now,
    });
    expect(seconds.result).toBe('STALE');
  });

  it('treats a timestamp a little ahead of our clock as age 0, not negative', () => {
    const result = evaluateStaleness({ latest: doc(new Date(now.getTime() + 5000)), thresholdMs: HOUR, now });
    expect(result).toMatchObject({ result: 'OK', ageMs: 0 });
  });
});
