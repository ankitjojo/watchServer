import { z } from 'zod';
import { alertModeSchema } from '../../constants/alertMode.js';
import { INTERVAL_UNITS, REPEAT_UNITS, THRESHOLD_UNITS } from '../../constants/durationUnit.js';
import { defineValidation } from '../../middlewares/validate.js';
import { addIntervalIssues, optionalDuration, type DurationLimits } from '../../utils/monitorValidation.js';
import { detailValidationParts } from '../monitors/monitorDetail.js';
import { objectIdSchema } from '../../utils/objectId.js';
import { boundedString, checkboxSchema, durationSchema } from '../../utils/validation.js';
import { collectionNameSchema, timestampKeySchema } from '../sourceData/sourceData.validation.js';

/** FR-W1 body. Cross-field rules need config (minimum interval, days per month), so this is a factory. */
export function createWebhookMonitorBody(limits: DurationLimits) {
  return (
    z
      .object({
        name: boundedString(1, 100),
        gatewayName: boundedString(1, 60),
        sourceCollection: collectionNameSchema,
        timestampKey: timestampKeySchema,
        checkInterval: durationSchema(INTERVAL_UNITS),
        threshold: durationSchema(THRESHOLD_UNITS),
        alertMode: alertModeSchema,
        repeatInterval: optionalDuration(REPEAT_UNITS),
        isEnabled: checkboxSchema,
      })
      .strict()
      .superRefine((body, ctx) => {
        addIntervalIssues(body, limits, ctx);
      })
      // Outside REPEAT_EVERY the repeat interval has no meaning, so it is dropped.
      .transform((body) => ({
        ...body,
        repeatInterval: body.alertMode === 'REPEAT_EVERY' ? body.repeatInterval : undefined,
      }))
  );
}

const idParams = z.object({ id: objectIdSchema }).strict();

export function createWebhookMonitorValidations(limits: DurationLimits) {
  const body = createWebhookMonitorBody(limits);
  return {
    create: defineValidation({ body }),
    update: defineValidation({ params: idParams, body }),
    id: defineValidation({ params: idParams }),
    detail: detailValidationParts(idParams),
  };
}

export type WebhookMonitorValidations = ReturnType<typeof createWebhookMonitorValidations>;
