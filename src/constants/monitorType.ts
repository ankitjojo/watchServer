import { z } from 'zod';

export const MONITOR_TYPE = {
  WEBHOOK: 'WEBHOOK',
  ENDPOINT: 'ENDPOINT',
} as const;

export type MonitorType = (typeof MONITOR_TYPE)[keyof typeof MONITOR_TYPE];
export const monitorTypeSchema = z.enum(MONITOR_TYPE);
