import type { RequestHandler } from 'express';
import type { Role } from '../constants/roles.js';
import { ForbiddenError, UnauthorizedError } from '../errors/appError.js';
import '../types/express.js';

/** Server-side role check. Hiding a button is not access control (security rules). */
export function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(new UnauthorizedError());
      return;
    }
    if (req.user.role !== role) {
      next(new ForbiddenError());
      return;
    }
    next();
  };
}
