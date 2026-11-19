import { ERROR_CODE, type ErrorCode } from './errorCodes.js';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** Safe, structured details for clients (for example Zod issues). Never driver messages. */
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus: number,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    if (options?.details !== undefined) this.details = options.details;
  }
}

type Opts = { details?: unknown; cause?: unknown };

export class ValidationError extends AppError {
  constructor(message: string, options?: Opts) {
    super(ERROR_CODE.VALIDATION_FAILED, message, 400, options);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', options?: Opts) {
    super(ERROR_CODE.UNAUTHENTICATED, message, 401, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this', options?: Opts) {
    super(ERROR_CODE.FORBIDDEN, message, 403, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', options?: Opts) {
    super(ERROR_CODE.NOT_FOUND, message, 404, options);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = ERROR_CODE.CONFLICT, options?: Opts) {
    super(code, message, 409, options);
  }
}

export class ExternalServiceError extends AppError {
  constructor(message: string, options?: Opts) {
    super(ERROR_CODE.EXTERNAL_SERVICE_ERROR, message, 502, options);
  }
}

export class InternalError extends AppError {
  constructor(message = 'Something went wrong', options?: Opts) {
    super(ERROR_CODE.INTERNAL_ERROR, message, 500, options);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests. Please try again later.', options?: Opts) {
    super(ERROR_CODE.RATE_LIMITED, message, 429, options);
  }
}

export class CsrfError extends AppError {
  constructor(message = 'Your session expired or the form is invalid. Reload the page and try again.') {
    super(ERROR_CODE.CSRF_INVALID, message, 403);
  }
}
