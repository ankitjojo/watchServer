import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { requireRole } from '../../middlewares/requireRole.js';
import type { SourceDataController } from './sourceData.controller.js';
import { validateKeyValidation } from './sourceData.schemas.js';

/** Mounted at /api/v1/source. Admin only: these calls read the Source DB (api-standards 1). */
export function createSourceDataRouter(controller: SourceDataController): Router {
  const router = Router();
  router.use(requireAuth, requireRole('ADMIN'));
  router.get('/collections', controller.collections);
  router.post('/validate-timestamp-key', validateKeyValidation.handler(), controller.validateTimestampKey);
  return router;
}
