import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { RateLimitConfig } from '../config/loadConfig.js';
import { RateLimitedError } from '../errors/appError.js';
import '../types/express.js';

function limiter(options: RateLimitConfig, key: (req: Request) => string | undefined): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    // Count failed attempts only, so a successful login never locks someone out.
    skipSuccessfulRequests: true,
    skip: (req) => key(req) === undefined,
    keyGenerator: (req) => key(req) ?? 'none',
    handler: (_req, _res, next) => {
      next(new RateLimitedError());
    },
  });
}

function bodyEmail(req: Request): string | undefined {
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null && 'email' in body && typeof body.email === 'string') {
    const email = body.email.trim().toLowerCase();
    return email === '' ? undefined : `email:${email.slice(0, 254)}`;
  }
  return undefined;
}

/** POST /login: limited per IP and per email (api-standards 6). */
export function createLoginLimiters(options: RateLimitConfig): RequestHandler[] {
  return [
    limiter(options, (req) => `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`),
    limiter(options, bodyEmail),
  ];
}

/** Run-now and test-email hit the Source DB and SMTP, so they are limited per user. */
export function createActionLimiter(options: RateLimitConfig): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.user?.id ?? ipKeyGenerator(req.ip ?? 'unknown')}`,
    handler: (_req, _res, next) => {
      next(new RateLimitedError());
    },
  });
}
