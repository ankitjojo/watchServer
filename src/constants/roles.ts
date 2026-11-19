import { z } from 'zod';

export const ROLE = {
  ADMIN: 'ADMIN',
  VIEWER: 'VIEWER',
} as const;

export type Role = (typeof ROLE)[keyof typeof ROLE];
export const roleSchema = z.enum(ROLE);
