import { AppError, ConflictError, ExternalServiceError, InternalError } from './appError.js';

/** MongoDB duplicate key error (code 11000). Duck-typed so this file needs no driver import. */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
}

function isMongoError(err: unknown): boolean {
  return err instanceof Error && err.name.startsWith('Mongo');
}

/**
 * Maps a thrown value to a safe AppError. Raw driver messages can contain hostnames,
 * so they are kept only as `cause` and never shown to clients.
 */
export function toAppError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err;
  if (isDuplicateKeyError(err))
    return new ConflictError('This value already exists', undefined, { cause: err });
  if (isMongoError(err)) return new ExternalServiceError(`${context} is unavailable`, { cause: err });
  return new InternalError('Something went wrong', { cause: err });
}
