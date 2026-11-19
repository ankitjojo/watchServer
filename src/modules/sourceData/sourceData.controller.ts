import type { RequestHandler } from 'express';
import { sendData } from '../../utils/response.js';
import { validateKeyValidation } from './sourceData.schemas.js';
import { describeInvalidKey, type SourceDataService } from './sourceData.service.js';

export interface SourceDataController {
  collections: RequestHandler;
  validateTimestampKey: RequestHandler;
}

export function createSourceDataController(deps: { sourceData: SourceDataService }): SourceDataController {
  const { sourceData } = deps;
  return {
    async collections(_req, res) {
      sendData(res, { collections: await sourceData.listCollections() });
    },

    async validateTimestampKey(_req, res) {
      const { body } = validateKeyValidation.read(res);
      const inspection = await sourceData.inspectTimestampKey(body.sourceCollection, body.timestampKey);
      const indexWarning = inspection.hasIndex
        ? undefined
        : `No index starts with "${body.timestampKey}": every check scans the collection. Ask the source backend owners to add { ${body.timestampKey}: -1 }.`;
      switch (inspection.status) {
        case 'VALID':
          sendData(res, {
            valid: true,
            latestTimestamp: inspection.latestTimestamp.toISOString(),
            hasTimestampIndex: inspection.hasIndex,
            ...(indexWarning === undefined ? {} : { warning: indexWarning }),
          });
          return;
        case 'EMPTY_COLLECTION':
          sendData(res, {
            valid: true,
            hasTimestampIndex: inspection.hasIndex,
            warning: 'The collection is empty, so the key cannot be validated yet.',
          });
          return;
        case 'INVALID':
          sendData(res, {
            valid: false,
            reason: describeInvalidKey(body.timestampKey, inspection.reason),
            hasTimestampIndex: inspection.hasIndex,
          });
          return;
      }
    },
  };
}
