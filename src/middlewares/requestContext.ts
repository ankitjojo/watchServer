import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import '../types/express.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Gives every request an id (from x-request-id when it is safe, else a new UUID) and echoes it back. */
export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const requestId = incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
};
