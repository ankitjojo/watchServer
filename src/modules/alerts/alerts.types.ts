import type { ObjectId } from 'mongodb';
import type { AlertMode } from '../../constants/alertMode.js';
import type { AlertStatus } from '../../constants/alertStatus.js';
import type { AlertType } from '../../constants/alertType.js';
import type { MonitorType } from '../../constants/monitorType.js';
import type { RecipientType } from '../../constants/recipientType.js';

/** Stored shape (persistence layer only, TD-16). */
export interface AlertDoc {
  _id: ObjectId;
  /** TD-09: unique. A duplicate-key insert means "already created". */
  sDedupeKey: string;
  eType: AlertType;
  /** Null for the grouped source-outage alerts. */
  iMonitorId: ObjectId | null;
  iIncidentId: ObjectId | null;
  iCheckId: ObjectId | null;
  oMonitorSnapshot: {
    eMonitorType: MonitorType;
    sName: string;
    sGatewayName?: string;
    sSourceCollection?: string;
    sTimestampKey?: string;
    sUrl?: string;
    nThresholdMs?: number;
    nCheckIntervalMs?: number;
    eAlertMode?: AlertMode;
    nRepeatIntervalMs?: number;
  } | null;
  /** Source-outage alerts: every monitor that failed to read the source. */
  aAffectedMonitors?: { iMonitorId: ObjectId; sName: string; eMonitorType: MonitorType }[];
  /** Resolved when the alert was created and never recomputed (FR-A5). */
  aRecipients: { sName: string; sEmail: string; eType: RecipientType }[];
  /** Rendered at creation, so what was sent is exactly what is stored. */
  sSubject: string;
  sTextBody: string;
  sHtmlBody: string;
  eStatus: AlertStatus;
  aAttempts: { dAt: Date; bIsSuccess: boolean; sErrorCode?: string; sErrorMessage?: string }[];
  /** Number of backoff steps used so far. Reset to 0 by a manual resend (D13). */
  nRetryIndex: number;
  dNextAttemptAt: Date | null;
  /** Dispatcher claim: nobody else sends this alert until it passes. */
  dLockedUntil: Date | null;
  /** Review M6: token of the dispatcher claim; outcomes are written only by the current claim holder. Absent on old docs. */
  sClaimId?: string | null;
  dSentAt?: Date;
  sMessageId?: string;
  sFailureReason?: string;
  dCreatedAt: Date;
  dUpdatedAt: Date;
}

export interface AlertRecipientView {
  name: string;
  email: string;
  type: RecipientType;
}

export interface AlertAttempt {
  at: Date;
  isSuccess: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/** Domain shape WITHOUT bodies: safe for lists (database rules: never load bodies in lists). */
export interface Alert {
  id: string;
  dedupeKey: string;
  type: AlertType;
  monitorId: string | null;
  incidentId: string | null;
  checkId: string | null;
  monitorName: string | null;
  affectedMonitorCount: number;
  recipients: AlertRecipientView[];
  subject: string;
  status: AlertStatus;
  attempts: AlertAttempt[];
  retryIndex: number;
  nextAttemptAt: Date | null;
  sentAt: Date | null;
  messageId: string | null;
  failureReason: string | null;
  createdAt: Date;
}

/** What the dispatcher needs to send one alert. */
export interface AlertToSend extends Alert {
  textBody: string;
  htmlBody: string;
  /** The claim this send runs under (review M6). */
  claimId: string;
}

/** Input for a new alert. The service renders subject and bodies before calling the repository. */
export interface NewAlert {
  dedupeKey: string;
  type: AlertType;
  monitorId: string | null;
  incidentId: string | null;
  checkId: string | null;
  snapshot: AlertDoc['oMonitorSnapshot'];
  affectedMonitors?: { monitorId: string; name: string; monitorType: MonitorType }[];
  recipients: AlertRecipientView[];
  subject: string;
  textBody: string;
  htmlBody: string;
  /** When the dispatcher may first send it. */
  dueAt: Date;
}

export interface AlertListFilter {
  monitorId?: string;
  type?: AlertType;
  status?: AlertStatus;
  from?: Date;
  to?: Date;
}
