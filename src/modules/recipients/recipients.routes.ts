import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { requireRole } from '../../middlewares/requireRole.js';
import type { RecipientsController } from './recipients.controller.js';
import { createRecipientValidation, idValidation, updateRecipientValidation } from './recipients.schemas.js';

/** Mounted at /recipients. Every route is admin only (api-standards 1). */
export function createRecipientsRouter(controller: RecipientsController): Router {
  const router = Router();
  router.use(requireAuth, requireRole('ADMIN'));
  router.get('/', controller.list);
  router.get('/new', controller.newForm);
  router.post('/new', createRecipientValidation.handler('form'), controller.create);
  router.get('/:id/edit', idValidation.handler(), controller.editForm);
  router.post('/:id/edit', updateRecipientValidation.handler('form'), controller.update);
  router.post('/:id/delete', idValidation.handler(), controller.remove);
  return router;
}
