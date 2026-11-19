export type TimestampFailure = 'MISSING' | 'INVALID_TYPE' | 'INVALID_DATE' | 'FUTURE';

export type TimestampParse = { ok: true; date: Date } | { ok: false; reason: TimestampFailure };

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;
const ONE_DAY_MS = 86_400_000;
// Numbers below this are epoch seconds, otherwise milliseconds (FR-W2).
const SECONDS_LIMIT = 1e11;

/**
 * Accepts BSON Date, ISO-8601 string, epoch milliseconds or epoch seconds (FR-W2).
 * A date more than one day in the future is rejected as clock skew.
 */
export function parseSourceTimestamp(value: unknown, now: Date): TimestampParse {
  if (value === undefined || value === null) return { ok: false, reason: 'MISSING' };

  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!ISO_PATTERN.test(text)) return { ok: false, reason: 'INVALID_DATE' };
    // No zone in the text means UTC, never the server's local zone.
    const normalised = text.includes('T') || text.includes(' ') ? text.replace(' ', 'T') : `${text}T00:00:00`;
    date = new Date(HAS_ZONE.test(normalised) ? normalised : `${normalised}Z`);
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return { ok: false, reason: 'INVALID_DATE' };
    date = new Date(value < SECONDS_LIMIT ? value * 1000 : value);
  } else {
    return { ok: false, reason: 'INVALID_TYPE' };
  }

  if (Number.isNaN(date.getTime())) return { ok: false, reason: 'INVALID_DATE' };
  if (date.getTime() > now.getTime() + ONE_DAY_MS) return { ok: false, reason: 'FUTURE' };
  return { ok: true, date };
}
