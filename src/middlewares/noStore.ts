import type { RequestHandler } from 'express';

/** Authenticated HTML must never be cached (ejs-frontend rules). */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
