import type { Check } from '../checks/checks.types.js';
import { formatUtc } from '../../utils/time.js';

/** What "Run check now" shows inline (FR-D3) and what the history API returns. camelCase, no documents. */
export interface CheckView {
  id: string;
  result: string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  startedAtUtc: string;
  durationMs: number;
  webhook?: {
    lastDocId?: string;
    lastDocTimestamp?: string;
    ageMs?: number;
    thresholdMs: number;
    reason?: string;
  };
  endpoint?: {
    attempts: {
      attempt: number;
      statusCode?: number;
      responseTimeMs: number;
      errorCode?: string;
      errorMessage?: string;
    }[];
  };
  error?: { code: string; message: string };
}

export function toCheckView(check: Check, timeZone: string): CheckView {
  return {
    id: check.id,
    result: check.result,
    trigger: check.trigger,
    startedAt: check.startedAt.toISOString(),
    finishedAt: check.finishedAt.toISOString(),
    startedAtUtc: formatUtc(check.startedAt, timeZone),
    durationMs: check.finishedAt.getTime() - check.startedAt.getTime(),
    ...(check.webhook
      ? {
          webhook: {
            thresholdMs: check.webhook.thresholdMs,
            ...(check.webhook.lastDocId === undefined ? {} : { lastDocId: check.webhook.lastDocId }),
            ...(check.webhook.lastDocTimestamp === undefined
              ? {}
              : { lastDocTimestamp: check.webhook.lastDocTimestamp.toISOString() }),
            ...(check.webhook.ageMs === undefined ? {} : { ageMs: check.webhook.ageMs }),
            ...(check.webhook.reason === undefined ? {} : { reason: check.webhook.reason }),
          },
        }
      : {}),
    ...(check.endpoint ? { endpoint: { attempts: check.endpoint.attempts } } : {}),
    ...(check.error ? { error: check.error } : {}),
  };
}
