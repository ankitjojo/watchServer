import { z } from 'zod';
import { checkResultSchema } from '../../constants/checkResult.js';
import { defineValidation } from '../../middlewares/validate.js';
import { objectIdSchema } from '../../utils/objectId.js';

/** `:type` in URLs; mapped to the stored MonitorType by the service. */
export const monitorTypeParam = z.enum(['webhook', 'endpoint']);
export type MonitorTypeParam = z.infer<typeof monitorTypeParam>;

const monitorParams = z.object({ type: monitorTypeParam, id: objectIdSchema }).strict();

const MAX_RANGE_MS = 90 * 86_400_000;

const isoDate = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const checksQuery = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    result: checkResultSchema.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  });

export const seriesQuery = z
  .object({
    range: z.enum(['24h', '7d', '30d', 'custom']),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.range !== 'custom') return;
    if (!q.from || !q.to) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'from and to are required for a custom range',
      });
    } else if (q.from > q.to) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'from must not be after to' });
    } else if (q.to.getTime() - q.from.getTime() > MAX_RANGE_MS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'the range may span at most 90 days' });
    }
  });

export const actionValidation = defineValidation({ params: monitorParams });
export const checksValidation = defineValidation({ params: monitorParams, query: checksQuery });
export const seriesValidation = defineValidation({ params: monitorParams, query: seriesQuery });
