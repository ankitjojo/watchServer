import { z } from 'zod';

// What the dashboard shows as a monitor's status: a check result, or one of two display-only states.
export const DISPLAY_STATUS = {
  OK: 'OK',
  STALE: 'STALE',
  NO_DATA: 'NO_DATA',
  DOWN: 'DOWN',
  ERROR: 'ERROR',
  PAUSED: 'PAUSED',
  PENDING_FIRST_CHECK: 'PENDING_FIRST_CHECK',
} as const;

export type DisplayStatus = (typeof DISPLAY_STATUS)[keyof typeof DISPLAY_STATUS];
export const displayStatusSchema = z.enum(DISPLAY_STATUS);
