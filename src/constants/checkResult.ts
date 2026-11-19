import { z } from 'zod';

export const CHECK_RESULT = {
  OK: 'OK',
  STALE: 'STALE',
  NO_DATA: 'NO_DATA',
  DOWN: 'DOWN',
  ERROR: 'ERROR',
} as const;

export type CheckResult = (typeof CHECK_RESULT)[keyof typeof CHECK_RESULT];
export const checkResultSchema = z.enum(CHECK_RESULT);
