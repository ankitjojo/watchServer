import type { Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { ValidationError } from '../errors/appError.js';
import type { FormFailure } from '../types/express.js';
import '../types/express.js';

type AnySchema = z.ZodType;
type Out<S extends AnySchema | undefined> = S extends AnySchema ? z.output<S> : undefined;

interface Schemas {
  params?: AnySchema;
  query?: AnySchema;
  body?: AnySchema;
}

export interface Validation<S extends Schemas> {
  /** 'api' (default) forwards a ValidationError. 'form' records the failure so the page can re-render. */
  handler(mode?: 'api' | 'form'): RequestHandler;
  /** Typed validated input. Call only after `handler()` ran and `formFailure` is undefined. */
  read(res: Response): { params: Out<S['params']>; query: Out<S['query']>; body: Out<S['body']> };
  formFailure(res: Response): FormFailure | undefined;
}

const SENSITIVE_FIELD = /pass(word)?/i;

function stripCsrf(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body ?? {};
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== '_csrf'));
}

function entered(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  return Object.fromEntries(Object.entries(body).filter(([key]) => !SENSITIVE_FIELD.test(key)));
}

function input(req: Request, key: keyof Schemas): unknown {
  if (key === 'body') return stripCsrf(req.body);
  return key === 'params' ? req.params : req.query;
}

/**
 * Parses params / query / body with Zod. Express 5 makes req.query a getter, so parsed values are
 * stored on res.locals.validated instead of mutating the request. `_csrf` is removed before
 * parsing so `.strict()` schemas accept form posts.
 */
export function defineValidation<S extends Schemas>(schemas: S): Validation<S> {
  return {
    handler(mode = 'api'): RequestHandler {
      return (req, res, next) => {
        const parsed: Record<string, unknown> = {};
        const issues: { path: string[]; message: string }[] = [];
        for (const key of ['params', 'query', 'body'] as const) {
          const schema = schemas[key];
          if (!schema) continue;
          const result = schema.safeParse(input(req, key));
          if (result.success) {
            parsed[key] = result.data;
          } else {
            for (const issue of result.error.issues) {
              issues.push({ path: issue.path.map(String), message: issue.message });
            }
          }
        }

        if (issues.length === 0) {
          res.locals.validated = { params: parsed['params'], query: parsed['query'], body: parsed['body'] };
          next();
          return;
        }
        if (mode === 'form') {
          const errors: Record<string, string> = {};
          for (const issue of issues) {
            const field = issue.path.join('.') || '_form';
            errors[field] ??= issue.message;
          }
          res.locals.formFailure = { errors, values: entered(req.body) };
          next();
          return;
        }
        next(new ValidationError('Invalid input', { details: issues }));
      };
    },
    read(res) {
      const validated = res.locals.validated;
      if (!validated) throw new Error('validate() middleware did not run for this route');
      return validated as ReturnType<Validation<S>['read']>;
    },
    formFailure: (res) => res.locals.formFailure,
  };
}
