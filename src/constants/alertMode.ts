import { z } from 'zod';

export const ALERT_MODE = {
  ONCE_WITH_RECOVERY: 'ONCE_WITH_RECOVERY',
  EVERY_CHECK: 'EVERY_CHECK',
  REPEAT_EVERY: 'REPEAT_EVERY',
} as const;

export type AlertMode = (typeof ALERT_MODE)[keyof typeof ALERT_MODE];
export const alertModeSchema = z.enum(ALERT_MODE);
