import { ObjectId } from 'mongodb';
import type { Check, CheckDoc, RecordCheckInput } from './checks.types.js';

const HEX_ID = /^[a-f0-9]{24}$/i;

/** A source `_id` is stored as an ObjectId when it looks like one, otherwise as the text it came as. */
function toStoredSourceId(id: string): ObjectId | string {
  return HEX_ID.test(id) ? new ObjectId(id) : id;
}

function sourceIdToText(id: ObjectId | string): string {
  return typeof id === 'string' ? id : id.toHexString();
}

export function toCheck(doc: CheckDoc): Check {
  const { oWebhook, oEndpoint, oError } = doc;
  return {
    id: doc._id.toHexString(),
    monitorId: doc.iMonitorId.toHexString(),
    monitorType: doc.eMonitorType,
    trigger: doc.eTrigger,
    startedAt: doc.dStartedAt,
    finishedAt: doc.dFinishedAt,
    result: doc.eResult,
    ...(oWebhook
      ? {
          webhook: {
            thresholdMs: oWebhook.nThresholdMs,
            ...(oWebhook.iLastDocId === undefined ? {} : { lastDocId: sourceIdToText(oWebhook.iLastDocId) }),
            ...(oWebhook.dLastDocTimestamp === undefined
              ? {}
              : { lastDocTimestamp: oWebhook.dLastDocTimestamp }),
            ...(oWebhook.nAgeMs === undefined ? {} : { ageMs: oWebhook.nAgeMs }),
            ...(oWebhook.eReason === undefined ? {} : { reason: oWebhook.eReason }),
          },
        }
      : {}),
    ...(oEndpoint
      ? {
          endpoint: {
            attempts: oEndpoint.aAttempts.map((a) => ({
              attempt: a.nAttempt,
              responseTimeMs: a.nResponseTimeMs,
              ...(a.nStatusCode === undefined ? {} : { statusCode: a.nStatusCode }),
              ...(a.sErrorCode === undefined ? {} : { errorCode: a.sErrorCode }),
              ...(a.sErrorMessage === undefined ? {} : { errorMessage: a.sErrorMessage }),
            })),
          },
        }
      : {}),
    ...(oError ? { error: { code: oError.sCode, message: oError.sMessage } } : {}),
  };
}

export function toCheckDoc(input: RecordCheckInput, ctx: { now: Date }): Omit<CheckDoc, '_id'> {
  const { webhook, endpoint, error } = input;
  return {
    iMonitorId: new ObjectId(input.monitorId),
    eMonitorType: input.monitorType,
    eTrigger: input.trigger,
    dStartedAt: input.startedAt,
    dFinishedAt: input.finishedAt,
    eResult: input.result,
    ...(webhook
      ? {
          oWebhook: {
            nThresholdMs: webhook.thresholdMs,
            ...(webhook.lastDocId === undefined ? {} : { iLastDocId: toStoredSourceId(webhook.lastDocId) }),
            ...(webhook.lastDocTimestamp === undefined
              ? {}
              : { dLastDocTimestamp: webhook.lastDocTimestamp }),
            ...(webhook.ageMs === undefined ? {} : { nAgeMs: webhook.ageMs }),
            ...(webhook.reason === undefined ? {} : { eReason: webhook.reason }),
          },
        }
      : {}),
    ...(endpoint
      ? {
          oEndpoint: {
            aAttempts: endpoint.attempts.map((a) => ({
              nAttempt: a.attempt,
              nResponseTimeMs: a.responseTimeMs,
              ...(a.statusCode === undefined ? {} : { nStatusCode: a.statusCode }),
              ...(a.errorCode === undefined ? {} : { sErrorCode: a.errorCode }),
              ...(a.errorMessage === undefined ? {} : { sErrorMessage: a.errorMessage }),
            })),
          },
        }
      : {}),
    ...(error ? { oError: { sCode: error.code, sMessage: error.message } } : {}),
    dCreatedAt: ctx.now,
  };
}
