import type { ObjectId } from 'mongodb';
import type { CheckResult } from '../../constants/checkResult.js';
import type { CheckTrigger } from '../../constants/checkTrigger.js';
import type { MonitorType } from '../../constants/monitorType.js';

/** Stored shape (persistence layer only, TD-16). Append-only (FR-H1). */
export interface CheckDoc {
  _id: ObjectId;
  iMonitorId: ObjectId;
  eMonitorType: MonitorType;
  eTrigger: CheckTrigger;
  dStartedAt: Date;
  dFinishedAt: Date;
  eResult: CheckResult;
  oWebhook?: {
    /** The source document's _id: usually an ObjectId, but the Source DB does not guarantee it. */
    iLastDocId?: ObjectId | string;
    dLastDocTimestamp?: Date;
    nAgeMs?: number;
    nThresholdMs: number;
    eReason?: string;
  };
  oEndpoint?: {
    aAttempts: {
      nAttempt: number;
      nStatusCode?: number;
      nResponseTimeMs: number;
      sErrorCode?: string;
      sErrorMessage?: string;
    }[];
  };
  oError?: { sCode: string; sMessage: string };
  dCreatedAt: Date;
}

export interface CheckAttempt {
  attempt: number;
  statusCode?: number;
  responseTimeMs: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface Check {
  id: string;
  monitorId: string;
  monitorType: MonitorType;
  trigger: CheckTrigger;
  startedAt: Date;
  finishedAt: Date;
  result: CheckResult;
  webhook?: {
    lastDocId?: string;
    lastDocTimestamp?: Date;
    ageMs?: number;
    thresholdMs: number;
    reason?: string;
  };
  endpoint?: { attempts: CheckAttempt[] };
  error?: { code: string; message: string };
}

export type RecordCheckInput = Omit<Check, 'id'>;

export interface CheckListFilter {
  monitorId: string;
  from?: Date;
  to?: Date;
  result?: CheckResult;
}

export interface SeriesPoint {
  t: Date;
  /** Webhook: document age (ms). Endpoint: response time of the last attempt (ms). Null when unknown. */
  value: number | null;
  /** Endpoint only. */
  isUp?: boolean;
}
