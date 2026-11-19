import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { requireRole } from '../../middlewares/requireRole.js';
import type { MonitorActionsController } from './monitorActions.controller.js';
import { actionValidation, checksValidation, seriesValidation } from './monitorActions.schemas.js';

/**
 * Mounted at /api/v1/monitors. Actions are admin only; history and chart data are readable by viewers.
 * `actionLimiter` guards the two calls that hit the Source DB or SMTP (api-standards 6).
 */
export function createMonitorActionsRouter(deps: {
  controller: MonitorActionsController;
  actionLimiter: RequestHandler;
}): Router {
  const { controller, actionLimiter } = deps;
  const router = Router();
  const admin = requireRole('ADMIN');
  router.use(requireAuth);

  router.get('/:type/:id/checks', checksValidation.handler(), controller.checks);
  router.get('/:type/:id/series', seriesValidation.handler(), controller.series);
  router.post('/:type/:id/run', admin, actionLimiter, actionValidation.handler(), controller.run);
  router.post('/:type/:id/pause', admin, actionValidation.handler(), controller.pause);
  router.post('/:type/:id/resume', admin, actionValidation.handler(), controller.resume);
  router.post(
    '/:type/:id/test-email',
    admin,
    actionLimiter,
    actionValidation.handler(),
    controller.testEmail,
  );
  return router;
}
