import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { requireRole } from '../../middlewares/requireRole.js';
import type { WebhookMonitorsController } from './webhookMonitors.controller.js';
import type { WebhookMonitorValidations } from './webhookMonitors.schemas.js';

/** Mounted at /webhook-monitors. Viewers may read; everything that changes or reads the Source DB is admin only. */
export function createWebhookMonitorsRouter(
  controller: WebhookMonitorsController,
  validations: WebhookMonitorValidations,
): Router {
  const router = Router();
  const admin = requireRole('ADMIN');
  router.use(requireAuth);

  router.get('/', controller.list);
  // Literal paths first so "new" is never read as an :id.
  router.get('/new', admin, controller.newForm);
  router.post('/new', admin, validations.create.handler('form'), controller.create);
  router.get('/:id/edit', admin, validations.id.handler(), controller.editForm);
  router.post('/:id/edit', admin, validations.update.handler('form'), controller.update);
  router.post('/:id/delete', admin, validations.id.handler(), controller.remove);
  router.get('/:id', validations.detail.handler(), controller.detail);
  return router;
}
