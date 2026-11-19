import { ObjectId } from 'mongodb';
import type { Alert, AlertDoc, AlertToSend, NewAlert } from './alerts.types.js';

export function toAlert(doc: Omit<AlertDoc, 'sTextBody' | 'sHtmlBody'> & Partial<AlertDoc>): Alert {
  return {
    id: doc._id.toHexString(),
    dedupeKey: doc.sDedupeKey,
    type: doc.eType,
    monitorId: doc.iMonitorId?.toHexString() ?? null,
    incidentId: doc.iIncidentId?.toHexString() ?? null,
    checkId: doc.iCheckId?.toHexString() ?? null,
    monitorName: doc.oMonitorSnapshot?.sName ?? null,
    // Old documents may lack the newer fields, so these defaults are intentional.
    affectedMonitorCount: doc.aAffectedMonitors?.length ?? 0,
    recipients: doc.aRecipients.map((r) => ({ name: r.sName, email: r.sEmail, type: r.eType })),
    subject: doc.sSubject,
    status: doc.eStatus,
    attempts: doc.aAttempts.map((a) => ({
      at: a.dAt,
      isSuccess: a.bIsSuccess,
      ...(a.sErrorCode === undefined ? {} : { errorCode: a.sErrorCode }),
      ...(a.sErrorMessage === undefined ? {} : { errorMessage: a.sErrorMessage }),
    })),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    retryIndex: doc.nRetryIndex ?? 0,
    nextAttemptAt: doc.dNextAttemptAt ?? null,
    sentAt: doc.dSentAt ?? null,
    messageId: doc.sMessageId ?? null,
    failureReason: doc.sFailureReason ?? null,
    createdAt: doc.dCreatedAt,
  };
}

/** Only for a document returned by a claim, which always carries its claim token. */
export function toAlertToSend(doc: AlertDoc): AlertToSend {
  return { ...toAlert(doc), textBody: doc.sTextBody, htmlBody: doc.sHtmlBody, claimId: doc.sClaimId ?? '' };
}

export function toAlertDoc(
  input: NewAlert,
  ctx: { now: Date; status: 'PENDING' | 'FAILED'; failureReason?: string },
): Omit<AlertDoc, '_id'> {
  return {
    sDedupeKey: input.dedupeKey,
    eType: input.type,
    iMonitorId: input.monitorId ? new ObjectId(input.monitorId) : null,
    iIncidentId: input.incidentId ? new ObjectId(input.incidentId) : null,
    iCheckId: input.checkId ? new ObjectId(input.checkId) : null,
    oMonitorSnapshot: input.snapshot,
    ...(input.affectedMonitors
      ? {
          aAffectedMonitors: input.affectedMonitors.map((m) => ({
            iMonitorId: new ObjectId(m.monitorId),
            sName: m.name,
            eMonitorType: m.monitorType,
          })),
        }
      : {}),
    aRecipients: input.recipients.map((r) => ({ sName: r.name, sEmail: r.email, eType: r.type })),
    sSubject: input.subject,
    sTextBody: input.textBody,
    sHtmlBody: input.htmlBody,
    eStatus: ctx.status,
    aAttempts: [],
    nRetryIndex: 0,
    dNextAttemptAt: ctx.status === 'PENDING' ? input.dueAt : null,
    dLockedUntil: null,
    ...(ctx.failureReason === undefined ? {} : { sFailureReason: ctx.failureReason }),
    dCreatedAt: ctx.now,
    dUpdatedAt: ctx.now,
  };
}
