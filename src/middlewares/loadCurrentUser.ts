import type { RequestHandler } from 'express';
import type { AuthUser } from '../types/express.js';
import '../types/express.js';

/**
 * Reloads the user on every request, so deactivating or demoting someone takes effect
 * immediately, even in an open session (security 2.3).
 */
export function createLoadCurrentUser(resolve: (userId: string) => Promise<AuthUser | null>): RequestHandler {
  return async (req, res, next) => {
    const userId = req.session.userId;
    if (userId === undefined) {
      next();
      return;
    }
    const user = await resolve(userId);
    if (user) {
      req.user = user;
      res.locals.currentUser = user;
    } else {
      delete req.session.userId;
    }
    next();
  };
}
