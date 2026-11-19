import { z } from 'zod';
import { recipientTypeSchema } from '../../constants/recipientType.js';
import { defineValidation } from '../../middlewares/validate.js';
import { objectIdSchema } from '../../utils/objectId.js';
import { boundedString, checkboxSchema, emailSchema } from '../../utils/validation.js';

const idParams = z.object({ id: objectIdSchema }).strict();

export const recipientBody = z
  .object({
    name: boundedString(1, 100),
    email: emailSchema,
    type: recipientTypeSchema,
    isActive: checkboxSchema,
  })
  .strict();

export const createRecipientValidation = defineValidation({ body: recipientBody });
export const idValidation = defineValidation({ params: idParams });
export const updateRecipientValidation = defineValidation({ params: idParams, body: recipientBody });
