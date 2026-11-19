import { z } from 'zod';
import { alertModeSchema } from '../../constants/alertMode.js';
import { INTERVAL_UNITS, REPEAT_UNITS } from '../../constants/durationUnit.js';
import { defineValidation } from '../../middlewares/validate.js';
import { addIntervalIssues, optionalDuration, type DurationLimits } from '../../utils/monitorValidation.js';
import { detailValidationParts } from '../monitors/monitorDetail.js';
import { objectIdSchema } from '../../utils/objectId.js';
import { boundedString, checkboxSchema, durationSchema } from '../../utils/validation.js';

export interface EndpointLimits extends DurationLimits {
  maxRetryCount: number;
}

/** FR-E1: http(s) only, no credentials in the URL (security 2.9). */
export const endpointUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hostname !== '' &&
        url.username === '' &&
        url.password === ''
      );
    } catch {
      return false;
    }
  }, 'must be a valid http:// or https:// URL without a username or password');

export function createEndpointMonitorBody(limits: EndpointLimits) {
  return z
    .object({
      serverName: boundedString(1, 100),
      url: endpointUrlSchema,
      checkInterval: durationSchema(INTERVAL_UNITS),
      // A blank field must be an error, not a silent 0 (z.coerce.number turns '' into 0).
      retryCount: z.preprocess(
        (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
        z.coerce.number().int().min(0).max(limits.maxRetryCount),
      ),
      alertMode: alertModeSchema,
      repeatInterval: optionalDuration(REPEAT_UNITS),
      isEnabled: checkboxSchema,
    })
    .strict()
    .superRefine((body, ctx) => {
      addIntervalIssues(body, limits, ctx);
    })
    .transform((body) => ({
      ...body,
      repeatInterval: body.alertMode === 'REPEAT_EVERY' ? body.repeatInterval : undefined,
    }));
}

const idParams = z.object({ id: objectIdSchema }).strict();

export function createEndpointMonitorValidations(limits: EndpointLimits) {
  const body = createEndpointMonitorBody(limits);
  return {
    create: defineValidation({ body }),
    update: defineValidation({ params: idParams, body }),
    id: defineValidation({ params: idParams }),
    detail: detailValidationParts(idParams),
  };
}

export type EndpointMonitorValidations = ReturnType<typeof createEndpointMonitorValidations>;
