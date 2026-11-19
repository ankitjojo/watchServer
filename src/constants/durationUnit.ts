import { z } from 'zod';

export const DURATION_UNIT = {
  MINUTE: 'MINUTE',
  HOUR: 'HOUR',
  DAY: 'DAY',
  WEEK: 'WEEK',
  MONTH: 'MONTH',
} as const;

export type DurationUnit = (typeof DURATION_UNIT)[keyof typeof DURATION_UNIT];
export const durationUnitSchema = z.enum(DURATION_UNIT);

// Allowed unit sets per field (requirements FR-W1, FR-E1).
export const INTERVAL_UNITS = ['MINUTE', 'HOUR'] as const;
export const THRESHOLD_UNITS = ['MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH'] as const;
export const REPEAT_UNITS = ['MINUTE', 'HOUR', 'DAY'] as const;
