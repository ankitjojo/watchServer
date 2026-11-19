import type { Duration, DurationInput, StoredDuration } from '../types/duration.js';

export const UNIT_MS = {
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
  WEEK: 604_800_000,
} as const;

/** 1 month = daysPerMonth days (requirements FR-W1, config DAYS_PER_MONTH). */
export function toMs(input: DurationInput, daysPerMonth: number): number {
  const unitMs = input.unit === 'MONTH' ? daysPerMonth * UNIT_MS.DAY : UNIT_MS[input.unit];
  return input.value * unitMs;
}

export function toDuration(input: DurationInput, daysPerMonth: number): Duration {
  return { value: input.value, unit: input.unit, ms: toMs(input, daysPerMonth) };
}

/** TD-08: keep what the admin typed plus the milliseconds computed at save time. */
export function toStoredDuration(input: DurationInput, daysPerMonth: number): StoredDuration {
  return { nValue: input.value, eUnit: input.unit, nMs: toMs(input, daysPerMonth) };
}

export function fromStoredDuration(stored: StoredDuration): Duration {
  return { value: stored.nValue, unit: stored.eUnit, ms: stored.nMs };
}

/** "3 h 12 min", "2 d 4 h", "45 s". At most two parts; negative values count as 0. */
export function formatHumanDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const parts: [number, string][] = [
    [Math.floor(totalSeconds / 86_400), 'd'],
    [Math.floor((totalSeconds % 86_400) / 3600), 'h'],
    [Math.floor((totalSeconds % 3600) / 60), 'min'],
    [totalSeconds % 60, 's'],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first === -1) return '0 s';
  const [firstValue, firstLabel] = parts[first] ?? [0, 's'];
  const next = parts[first + 1];
  if (next && next[0] > 0) return `${firstValue} ${firstLabel} ${next[0]} ${next[1]}`;
  return `${firstValue} ${firstLabel}`;
}

/** "10 minute", "2 hour": what the admin typed, for lists and emails. */
export function formatDurationInput(input: { value: number; unit: string }): string {
  return `${input.value} ${input.unit.toLowerCase()}`;
}
