import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth.js';
import type { AlertsPageController } from './alerts.pages.controller.js';
import { alertListValidation } from './alerts.schemas.js';

/** Mounted at /alerts (FR-D5). Any logged-in user may read the log; resending is a separate admin API call. */
export function createAlertsPageRouter(controller: AlertsPageController): Router {
  const router = Router();
  router.get('/', requireAuth, alertListValidation.handler(), controller.list);
  return router;
}
