import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { requireRole } from '../../middlewares/requireRole.js';
import type { EndpointMonitorsController } from './endpointMonitors.controller.js';
import type { EndpointMonitorValidations } from './endpointMonitors.schemas.js';

/** Mounted at /endpoint-monitors. Viewers may read; everything that changes anything is admin only. */
export function createEndpointMonitorsRouter(
  controller: EndpointMonitorsController,
  validations: EndpointMonitorValidations,
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
