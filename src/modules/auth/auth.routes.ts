import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../../middlewares/requireAuth.js';
import type { AuthController } from './auth.controller.js';
import { loginValidation } from './auth.schemas.js';

export function createAuthRouter(deps: {
  controller: AuthController;
  loginLimiters: RequestHandler[];
}): Router {
  const { controller, loginLimiters } = deps;
  const router = Router();
  router.get('/login', controller.showLogin);
  router.post('/login', ...loginLimiters, loginValidation.handler('form'), controller.login);
  router.post('/logout', requireAuth, controller.logout);
  return router;
}
