import { z } from 'zod';

export const CHECK_TRIGGER = {
  SCHEDULE: 'SCHEDULE',
  MANUAL: 'MANUAL',
} as const;

export type CheckTrigger = (typeof CHECK_TRIGGER)[keyof typeof CHECK_TRIGGER];
export const checkTriggerSchema = z.enum(CHECK_TRIGGER);
