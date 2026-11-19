import { z } from 'zod';

export const ALERT_TYPE = {
  WEBHOOK_STALE: 'WEBHOOK_STALE',
  WEBHOOK_NO_DATA: 'WEBHOOK_NO_DATA',
  ENDPOINT_DOWN: 'ENDPOINT_DOWN',
  RECOVERED: 'RECOVERED',
  MONITOR_ERROR: 'MONITOR_ERROR',
  TEST: 'TEST',
} as const;

export type AlertType = (typeof ALERT_TYPE)[keyof typeof ALERT_TYPE];
export const alertTypeSchema = z.enum(ALERT_TYPE);
