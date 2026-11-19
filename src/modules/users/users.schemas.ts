import { z } from 'zod';
import { roleSchema } from '../../constants/roles.js';
import { defineValidation } from '../../middlewares/validate.js';
import { objectIdSchema } from '../../utils/objectId.js';
import { boundedString, checkboxSchema, emailSchema } from '../../utils/validation.js';

/** D3: at least 12 characters, at most 72 bytes (bcrypt silently ignores anything beyond 72 bytes). */
export const passwordSchema = z
  .string()
  .min(12, 'must be at least 12 characters')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'must be at most 72 bytes');

const idParams = z.object({ id: objectIdSchema }).strict();

export const createUserBody = z
  .object({
    name: boundedString(1, 100),
    email: emailSchema,
    role: roleSchema,
    password: passwordSchema,
    isActive: checkboxSchema,
  })
  .strict();

export const updateUserBody = z
  .object({
    name: boundedString(1, 100),
    email: emailSchema,
    role: roleSchema,
    // Blank means "keep the current password" (D16).
    password: z
      .union([z.literal(''), passwordSchema])
      .optional()
      .transform((v) => (v === '' ? undefined : v)),
    isActive: checkboxSchema,
  })
  .strict();

export const createUserValidation = defineValidation({ body: createUserBody });
export const idValidation = defineValidation({ params: idParams });
export const updateUserValidation = defineValidation({ params: idParams, body: updateUserBody });
