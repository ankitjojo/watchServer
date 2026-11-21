import { z } from 'zod';
import { alertStatusSchema } from '../../constants/alertStatus.js';
import { alertTypeSchema } from '../../constants/alertType.js';
import { defineValidation } from '../../middlewares/validate.js';
import { objectIdSchema } from '../../utils/objectId.js';

const isoDay = z.iso.date();

/** FR-D5 filters. Dates are plain days in the display zone (dayBounds); every key is whitelisted. */
export const alertListQuery = z
  .object({
    monitorId: z.union([z.literal(''), objectIdSchema]).optional(),
    type: z.union([z.literal(''), alertTypeSchema]).optional(),
    status: z.union([z.literal(''), alertStatusSchema]).optional(),
    from: z.union([z.literal(''), isoDay]).optional(),
    to: z.union([z.literal(''), isoDay]).optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const alertListValidation = defineValidation({ query: alertListQuery });

export const alertIdValidation = defineValidation({ params: z.object({ id: objectIdSchema }).strict() });
