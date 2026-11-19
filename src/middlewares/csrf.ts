import type { Request, RequestHandler } from 'express';
import { csrfSync } from 'csrf-sync';
import '../types/express.js';

function tokenFromRequest(req: Request): string | undefined {
  const header = req.headers['x-csrf-token'];
  if (typeof header === 'string') return header;
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null && '_csrf' in body && typeof body._csrf === 'string') {
    return body._csrf;
  }
  return undefined;
}

const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: tokenFromRequest,
  size: 32,
});

/** Synchroniser-token CSRF protection on every state-changing request (TD-11). */
export const csrfProtection: RequestHandler = csrfSynchronisedProtection;

/** Exposes the token to templates (hidden `_csrf` field and `<meta name="csrf-token">`). */
export const exposeCsrfToken: RequestHandler = (req, res, next) => {
  res.locals.csrfToken = generateToken(req);
  next();
};
