import type { RequestHandler } from 'express';
import { UnauthorizedError } from '../errors/appError.js';
import '../types/express.js';

/** Pages redirect to /login; the JSON API answers 401 (the error handler decides by URL). */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(new UnauthorizedError());
    return;
  }
  next();
};
