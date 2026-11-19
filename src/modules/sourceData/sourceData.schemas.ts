import { z } from 'zod';
import { defineValidation } from '../../middlewares/validate.js';
import { collectionNameSchema, timestampKeySchema } from './sourceData.validation.js';

export const validateKeyBody = z
  .object({ sourceCollection: collectionNameSchema, timestampKey: timestampKeySchema })
  .strict();

export const validateKeyValidation = defineValidation({ body: validateKeyBody });
