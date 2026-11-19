import { parseSourceTimestamp } from '../../../src/utils/timestamp.js';

const now = new Date('2026-11-18T12:00:00.000Z');

describe('parseSourceTimestamp', () => {
  it('accepts a BSON Date', () => {
    const d = new Date('2026-11-18T10:00:00Z');
    expect(parseSourceTimestamp(d, now)).toEqual({ ok: true, date: d });
  });

  it('accepts ISO-8601 strings, treating a missing zone as UTC', () => {
    expect(parseSourceTimestamp('2026-11-18T10:00:00Z', now)).toEqual({
      ok: true,
      date: new Date('2026-11-18T10:00:00Z'),
    });
    expect(parseSourceTimestamp('2026-11-18T10:00:00', now)).toEqual({
      ok: true,
      date: new Date('2026-11-18T10:00:00Z'),
    });
    expect(parseSourceTimestamp('2026-11-18T15:30:00+05:30', now)).toEqual({
      ok: true,
      date: new Date('2026-11-18T10:00:00Z'),
    });
  });

  it('treats numbers below 1e11 as seconds and others as milliseconds', () => {
    const seconds = Date.UTC(2026, 10, 18, 10) / 1000;
    expect(parseSourceTimestamp(seconds, now)).toEqual({ ok: true, date: new Date(seconds * 1000) });
    const ms = Date.UTC(2026, 10, 18, 10);
    expect(parseSourceTimestamp(ms, now)).toEqual({ ok: true, date: new Date(ms) });
  });

  it('switches from seconds to milliseconds exactly at 1e11', () => {
    const farPast = new Date('1971-01-01T00:00:00Z');
    expect(parseSourceTimestamp(1e11 - 1, farPast)).toMatchObject({ ok: false, reason: 'FUTURE' });
    const atLimit = parseSourceTimestamp(1e11, new Date('1973-06-01T00:00:00Z'));
    expect(atLimit).toEqual({ ok: true, date: new Date(1e11) });
  });

  it.each([
    [undefined, 'MISSING'],
    [null, 'MISSING'],
    [{}, 'INVALID_TYPE'],
    [true, 'INVALID_TYPE'],
    ['not-a-date', 'INVALID_DATE'],
    ['2026-13-45T00:00:00Z', 'INVALID_DATE'],
    [-5, 'INVALID_DATE'],
    [Number.NaN, 'INVALID_DATE'],
    [new Date('nope'), 'INVALID_DATE'],
  ])('rejects %j as %s', (value, reason) => {
    expect(parseSourceTimestamp(value, now)).toEqual({ ok: false, reason });
  });

  it('rejects dates more than a day in the future as clock skew', () => {
    expect(parseSourceTimestamp(new Date('2026-11-19T12:00:01Z'), now)).toEqual({
      ok: false,
      reason: 'FUTURE',
    });
    expect(parseSourceTimestamp(new Date('2026-11-19T11:59:59Z'), now).ok).toBe(true);
  });
});
