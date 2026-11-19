import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { requireRole } from '../../middlewares/requireRole.js';
import type { UsersController } from './users.controller.js';
import { createUserValidation, idValidation, updateUserValidation } from './users.schemas.js';

/** Mounted at /users. Every route is admin only (api-standards 1). */
export function createUsersRouter(controller: UsersController): Router {
  const router = Router();
  router.use(requireAuth, requireRole('ADMIN'));
  router.get('/', controller.list);
  router.get('/new', controller.newForm);
  router.post('/new', createUserValidation.handler('form'), controller.create);
  router.get('/:id/edit', idValidation.handler(), controller.editForm);
  router.post('/:id/edit', updateUserValidation.handler('form'), controller.update);
  router.post('/:id/delete', idValidation.handler(), controller.remove);
  return router;
}
