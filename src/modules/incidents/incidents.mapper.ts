import { ObjectId } from 'mongodb';
import type { Incident, IncidentDoc } from './incidents.types.js';

export function toIncident(doc: IncidentDoc): Incident {
  return {
    id: doc._id.toHexString(),
    monitorId: doc.iMonitorId?.toHexString() ?? null,
    kind: doc.eKind,
    openedAt: doc.dOpenedAt,
    closedAt: doc.dClosedAt ?? null,
    openingResult: doc.eOpeningResult,
    // Old documents may lack the newer fields, so these defaults are intentional.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    affectedMonitorIds: (doc.aAffectedMonitorIds ?? []).map((id) => id.toHexString()),
    lastCheckId: doc.iLastCheckId?.toHexString() ?? null,
    lastAlertAt: doc.dLastAlertAt ?? null,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    reminderCount: doc.nReminderCount ?? 0,
    ...(doc.eCloseReason ? { closeReason: doc.eCloseReason } : {}),
    createdAt: doc.dCreatedAt,
    updatedAt: doc.dUpdatedAt,
  };
}

export function toMonitorIncidentDoc(
  input: { monitorId: string; openingResult: IncidentDoc['eOpeningResult']; checkId: string },
  ctx: { now: Date },
): Omit<IncidentDoc, '_id'> {
  return {
    iMonitorId: new ObjectId(input.monitorId),
    eKind: 'MONITOR',
    dOpenedAt: ctx.now,
    dClosedAt: null,
    eOpeningResult: input.openingResult,
    aAffectedMonitorIds: [],
    iLastCheckId: new ObjectId(input.checkId),
    dLastAlertAt: null,
    nReminderCount: 0,
    dCreatedAt: ctx.now,
    dUpdatedAt: ctx.now,
  };
}

export function toSourceErrorIncidentDoc(
  input: { affectedMonitorIds: string[]; checkId: string },
  ctx: { now: Date },
): Omit<IncidentDoc, '_id'> {
  return {
    iMonitorId: null,
    eKind: 'SOURCE_ERROR',
    dOpenedAt: ctx.now,
    dClosedAt: null,
    eOpeningResult: 'ERROR',
    aAffectedMonitorIds: input.affectedMonitorIds.map((id) => new ObjectId(id)),
    iLastCheckId: new ObjectId(input.checkId),
    dLastAlertAt: null,
    nReminderCount: 0,
    dCreatedAt: ctx.now,
    dUpdatedAt: ctx.now,
  };
}
