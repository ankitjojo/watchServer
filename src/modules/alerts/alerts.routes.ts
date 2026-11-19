import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { requireRole } from '../../middlewares/requireRole.js';
import type { AlertsController } from './alerts.controller.js';
import { alertIdValidation } from './alerts.schemas.js';

/** Mounted at /api/v1/alerts. Resending sends email, so it is admin only. */
export function createAlertsApiRouter(controller: AlertsController): Router {
  const router = Router();
  router.use(requireAuth, requireRole('ADMIN'));
  router.post('/:id/resend', alertIdValidation.handler(), controller.resend);
  return router;
}
