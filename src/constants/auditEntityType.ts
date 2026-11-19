import { z } from 'zod';

export const AUDIT_ENTITY_TYPE = {
  USER: 'USER',
  RECIPIENT: 'RECIPIENT',
  WEBHOOK_MONITOR: 'WEBHOOK_MONITOR',
  ENDPOINT_MONITOR: 'ENDPOINT_MONITOR',
  ALERT: 'ALERT',
} as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPE)[keyof typeof AUDIT_ENTITY_TYPE];
export const auditEntityTypeSchema = z.enum(AUDIT_ENTITY_TYPE);
