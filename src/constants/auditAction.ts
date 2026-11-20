import { z } from 'zod';

export const AUDIT_ACTION = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  RESTORE: 'RESTORE',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  RESEND: 'RESEND',
  LOGIN: 'LOGIN',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];
export const auditActionSchema = z.enum(AUDIT_ACTION);
