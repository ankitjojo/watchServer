import { formatHumanDuration, toMs, toStoredDuration } from '../../../src/utils/duration.js';

describe('toMs', () => {
  it.each([
    [{ value: 5, unit: 'MINUTE' }, 300_000],
    [{ value: 2, unit: 'HOUR' }, 7_200_000],
    [{ value: 3, unit: 'DAY' }, 259_200_000],
    [{ value: 1, unit: 'WEEK' }, 604_800_000],
  ] as const)('%j = %d ms', (input, expected) => {
    expect(toMs(input, 30)).toBe(expected);
  });

  it('converts a month with DAYS_PER_MONTH', () => {
    expect(toMs({ value: 1, unit: 'MONTH' }, 30)).toBe(30 * 86_400_000);
    expect(toMs({ value: 2, unit: 'MONTH' }, 31)).toBe(62 * 86_400_000);
  });
});

describe('toStoredDuration', () => {
  it('keeps what was typed plus normalised ms (TD-08)', () => {
    expect(toStoredDuration({ value: 2, unit: 'HOUR' }, 30)).toEqual({
      nValue: 2,
      eUnit: 'HOUR',
      nMs: 7_200_000,
    });
  });
});

describe('formatHumanDuration', () => {
  it.each([
    [0, '0 s'],
    [-5, '0 s'],
    [999, '0 s'],
    [45_000, '45 s'],
    [60_000, '1 min'],
    [3_720_000, '1 h 2 min'],
    [11_520_000, '3 h 12 min'],
    [3_600_000, '1 h'],
    [187_200_000, '2 d 4 h'],
    [86_400_000 + 5 * 60_000, '1 d'],
  ])('%d ms -> %s', (ms, expected) => {
    expect(formatHumanDuration(ms)).toBe(expected);
  });
});
