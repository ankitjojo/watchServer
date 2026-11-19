import type { ErrorRequestHandler, Request } from 'express';
import { ZodError } from 'zod';
import { AppError, CsrfError, InternalError, ValidationError } from '../errors/appError.js';
import { ERROR_CODE } from '../errors/errorCodes.js';
import type { Logger } from '../logger/index.js';
import { renderPage } from '../utils/renderPage.js';
import '../types/express.js';

function errorCodeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    if ('code' in err && typeof err.code === 'string') return err.code;
    if ('type' in err && typeof err.type === 'string') return err.type;
  }
  return undefined;
}

/** Turns anything thrown into an AppError with a client-safe message. */
function normalise(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new ValidationError('Invalid input', {
      details: err.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  const code = errorCodeOf(err);
  if (code === 'EBADCSRFTOKEN') return new CsrfError();
  if (code === 'entity.too.large') {
    return new AppError(ERROR_CODE.VALIDATION_FAILED, 'The request is too large', 413);
  }
  if (code === 'entity.parse.failed' || code === 'encoding.unsupported' || code === 'request.aborted') {
    return new ValidationError('The request body could not be read');
  }
  return new InternalError('Something went wrong', { cause: err });
}

function isApiRequest(req: Request): boolean {
  return req.originalUrl.startsWith('/api/');
}

const PAGE_TITLES: Record<number, string> = {
  403: 'Not allowed',
  404: 'Page not found',
};

/**
 * One central handler: JSON envelope for /api/v1, an error page for everything else.
 * Never exposes stack traces, driver messages or hostnames (api-standards 2).
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const appError = normalise(err);
    const context = {
      event: 'http.error',
      requestId: req.requestId,
      code: appError.code,
      status: appError.httpStatus,
    };
    if (appError.httpStatus >= 500) {
      logger.error({ ...context, err }, 'Request failed');
    } else if ([401, 403, 429].includes(appError.httpStatus)) {
      logger.warn(context, 'Request rejected');
    } else {
      logger.debug(context, 'Request invalid');
    }

    if (isApiRequest(req)) {
      res.status(appError.httpStatus).json({
        success: false,
        error: {
          code: appError.code,
          message: appError.message,
          ...(appError.details === undefined ? {} : { details: appError.details }),
          requestId: req.requestId,
        },
      });
      return;
    }

    if (appError.httpStatus === 401) {
      res.redirect(302, '/login');
      return;
    }

    const status = appError.httpStatus;
    const view = status === 403 ? 'errors/403' : status === 404 ? 'errors/404' : 'errors/500';
    renderPage(
      res,
      view,
      { pageTitle: PAGE_TITLES[status] ?? 'Something went wrong', status, message: appError.message },
      status,
    ).catch((renderErr: unknown) => {
      logger.error(
        { event: 'http.errorPageFailed', requestId: req.requestId, err: renderErr },
        'Error page failed',
      );
      res.status(status).type('text').send(`Something went wrong. Request ID: ${req.requestId}`);
    });
  };
}
