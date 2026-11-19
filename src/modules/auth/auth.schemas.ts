import { z } from 'zod';
import { defineValidation } from '../../middlewares/validate.js';

// Deliberately loose: any failure produces the same generic message (security 2.3).
export const loginBody = z
  .object({
    email: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(200),
  })
  .strict();

export const loginValidation = defineValidation({ body: loginBody });
