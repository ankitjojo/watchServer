import {
  MongoNetworkError,
  MongoNotConnectedError,
  MongoServerError,
  MongoServerSelectionError,
  MongoTopologyClosedError,
} from 'mongodb';
import { ExternalServiceError } from '../../errors/appError.js';

/**
 * UNAVAILABLE: the Source DB itself cannot be reached (a real outage, grouped for masters, FR-A4a).
 * The others are limited to one collection and belong to that monitor (review H2, TD-29).
 */
export type SourceDataErrorKind = 'UNAVAILABLE' | 'TIMEOUT' | 'COLLECTION_NOT_FOUND' | 'QUERY_FAILED';

/**
 * A read of the Source DB failed. The message is safe for clients; the driver error is kept
 * only as `cause` because it can contain hostnames.
 */
export class SourceDataError extends ExternalServiceError {
  readonly kind: SourceDataErrorKind;

  constructor(kind: SourceDataErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
  }
}

/** Machine code stored on a check's `oError.sCode` (database-design `checks`). */
export function sourceErrorCode(kind: SourceDataErrorKind): string {
  return `SOURCE_${kind}`;
}

/** TD-29: only a connection-level failure is a Source DB outage. */
export function isSourceOutage(err: SourceDataError): boolean {
  return err.kind === 'UNAVAILABLE';
}

const MAX_TIME_MS_EXPIRED = 50;
const AUTHENTICATION_FAILED = 18;

/** The server could not be reached or would not let us in at all: nothing can be read. */
function isConnectionLevel(err: unknown): boolean {
  return (
    err instanceof MongoServerSelectionError ||
    err instanceof MongoNetworkError ||
    err instanceof MongoTopologyClosedError ||
    err instanceof MongoNotConnectedError ||
    (err instanceof MongoServerError && err.code === AUTHENTICATION_FAILED)
  );
}

export function toSourceDataError(err: unknown, action: string): SourceDataError {
  if (err instanceof SourceDataError) return err;
  if (isConnectionLevel(err)) {
    return new SourceDataError('UNAVAILABLE', `The source database could not ${action}`, { cause: err });
  }
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  const name = err instanceof Error ? err.name : '';
  if (code === MAX_TIME_MS_EXPIRED || name === 'MongoOperationTimeoutError') {
    return new SourceDataError('TIMEOUT', `The source database took too long to ${action}`, { cause: err });
  }
  // The server answered, but this query failed: a problem of this collection, not an outage.
  return new SourceDataError('QUERY_FAILED', `The source database could not ${action}`, { cause: err });
}
