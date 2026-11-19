import { parseSourceTimestamp, type TimestampFailure } from '../../utils/timestamp.js';
import type { LatestDoc } from '../sourceData/sourceData.service.js';

export type NoDataReason = 'EMPTY_COLLECTION' | TimestampFailure;

export type StalenessOutcome =
  | { result: 'OK' | 'STALE'; lastDocId: string; lastDocTimestamp: Date; ageMs: number }
  | { result: 'NO_DATA'; reason: NoDataReason; lastDocId?: string };

/**
 * FR-W3, pure: age = now - timestamp. OK when age <= threshold, STALE when older.
 * NO_DATA when the collection is empty or the key is missing/invalid on the newest document.
 * (ERROR is decided by the runner when the source query itself fails.)
 */
export function evaluateStaleness(input: {
  latest: LatestDoc | null;
  thresholdMs: number;
  now: Date;
}): StalenessOutcome {
  const { latest, thresholdMs, now } = input;
  if (!latest) return { result: 'NO_DATA', reason: 'EMPTY_COLLECTION' };

  const parsed = parseSourceTimestamp(latest.rawValue, now);
  if (!parsed.ok) return { result: 'NO_DATA', reason: parsed.reason, lastDocId: latest.id };

  // A timestamp slightly ahead of our clock (skew under a day) counts as age 0.
  const ageMs = Math.max(0, now.getTime() - parsed.date.getTime());
  return {
    result: ageMs <= thresholdMs ? 'OK' : 'STALE',
    lastDocId: latest.id,
    lastDocTimestamp: parsed.date,
    ageMs,
  };
}
