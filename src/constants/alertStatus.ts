import { z } from 'zod';

export const ALERT_STATUS = {
  PENDING: 'PENDING',
  RETRYING: 'RETRYING',
  SENT: 'SENT',
  FAILED: 'FAILED',
} as const;

export type AlertStatus = (typeof ALERT_STATUS)[keyof typeof ALERT_STATUS];
export const alertStatusSchema = z.enum(ALERT_STATUS);
