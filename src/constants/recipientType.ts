import { z } from 'zod';

export const RECIPIENT_TYPE = {
  NORMAL: 'NORMAL',
  MASTER: 'MASTER',
} as const;

export type RecipientType = (typeof RECIPIENT_TYPE)[keyof typeof RECIPIENT_TYPE];
export const recipientTypeSchema = z.enum(RECIPIENT_TYPE);
