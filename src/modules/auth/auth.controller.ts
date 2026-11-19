import type { RequestHandler } from 'express';
import { renderPage } from '../../utils/renderPage.js';
import type { AuthService } from './auth.service.js';
import { loginValidation } from './auth.schemas.js';

const GENERIC_LOGIN_ERROR = 'Invalid email or password';

function regenerate(req: Parameters<RequestHandler>[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error('session regenerate failed'));
      else resolve();
    });
  });
}

function save(req: Parameters<RequestHandler>[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error('session save failed'));
      else resolve();
    });
  });
}

function destroy(req: Parameters<RequestHandler>[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error('session destroy failed'));
      else resolve();
    });
  });
}

export interface AuthController {
  showLogin: RequestHandler;
  login: RequestHandler;
  logout: RequestHandler;
}

export function createAuthController(deps: { auth: AuthService }): AuthController {
  const { auth } = deps;

  return {
    async showLogin(req, res) {
      if (req.user) {
        res.redirect(303, '/');
        return;
      }
      await renderPage(res, 'pages/auth/login', { pageTitle: 'Sign in', email: '', error: undefined });
    },

    async login(req, res) {
      const failure = loginValidation.formFailure(res);
      if (failure) {
        await renderPage(
          res,
          'pages/auth/login',
          { pageTitle: 'Sign in', email: '', error: 'Enter your email and password' },
          400,
        );
        return;
      }
      const { body } = loginValidation.read(res);
      const user = await auth.login(body.email, body.password);
      if (!user) {
        await renderPage(
          res,
          'pages/auth/login',
          { pageTitle: 'Sign in', email: body.email, error: GENERIC_LOGIN_ERROR },
          400,
        );
        return;
      }
      // Prevents session fixation: a new session id after authentication.
      await regenerate(req);
      req.session.userId = user.id;
      await save(req);
      res.redirect(303, '/');
    },

    async logout(req, res) {
      await destroy(req);
      res.clearCookie('pm.sid');
      res.redirect(303, '/login');
    },
  };
}
