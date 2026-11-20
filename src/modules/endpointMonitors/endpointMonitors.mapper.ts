import type { ObjectId } from 'mongodb';
import { fromStoredDuration, toStoredDuration } from '../../utils/duration.js';
import { initialStateDoc, toMonitorState } from '../../utils/monitorState.js';
import type { EndpointMonitor, EndpointMonitorDoc, EndpointMonitorInput } from './endpointMonitors.types.js';

export function toEndpointMonitor(doc: EndpointMonitorDoc): EndpointMonitor {
  return {
    id: doc._id.toHexString(),
    serverName: doc.sServerName,
    url: doc.sUrl,
    checkInterval: fromStoredDuration(doc.oCheckInterval),
    retryCount: doc.nRetryCount,
    alertMode: doc.eAlertMode,
    ...(doc.oRepeatInterval ? { repeatInterval: fromStoredDuration(doc.oRepeatInterval) } : {}),
    isEnabled: doc.bIsEnabled,
    state: toMonitorState(doc.oState),
    createdBy: doc.iCreatedBy.toHexString(),
    updatedBy: doc.iUpdatedBy.toHexString(),
    createdAt: doc.dCreatedAt,
    updatedAt: doc.dUpdatedAt,
    deletedAt: doc.dDeletedAt ?? null,
  };
}

interface SaveContext {
  now: Date;
  userId: ObjectId;
  daysPerMonth: number;
}

export function toEndpointMonitorDoc(
  input: EndpointMonitorInput,
  ctx: SaveContext,
): Omit<EndpointMonitorDoc, '_id'> {
  return {
    sServerName: input.serverName,
    sUrl: input.url,
    oCheckInterval: toStoredDuration(input.checkInterval, ctx.daysPerMonth),
    nRetryCount: input.retryCount,
    eAlertMode: input.alertMode,
    ...(input.alertMode === 'REPEAT_EVERY' && input.repeatInterval
      ? { oRepeatInterval: toStoredDuration(input.repeatInterval, ctx.daysPerMonth) }
      : {}),
    bIsEnabled: input.isEnabled,
    oState: initialStateDoc(),
    dDeletedAt: null,
    iCreatedBy: ctx.userId,
    iUpdatedBy: ctx.userId,
    dCreatedAt: ctx.now,
    dUpdatedAt: ctx.now,
  };
}

export interface EndpointMonitorUpdate {
  $set: Partial<EndpointMonitorDoc>;
  $unset?: { oRepeatInterval: '' };
}

/** Config fields only: never `oState` (a running check owns it) or `dCreatedAt`. */
export function toEndpointMonitorUpdate(
  input: EndpointMonitorInput,
  ctx: SaveContext,
): EndpointMonitorUpdate {
  const isRepeat = input.alertMode === 'REPEAT_EVERY' && input.repeatInterval !== undefined;
  const $set: Partial<EndpointMonitorDoc> = {
    sServerName: input.serverName,
    sUrl: input.url,
    oCheckInterval: toStoredDuration(input.checkInterval, ctx.daysPerMonth),
    nRetryCount: input.retryCount,
    eAlertMode: input.alertMode,
    bIsEnabled: input.isEnabled,
    iUpdatedBy: ctx.userId,
    dUpdatedAt: ctx.now,
    ...(isRepeat && input.repeatInterval
      ? { oRepeatInterval: toStoredDuration(input.repeatInterval, ctx.daysPerMonth) }
      : {}),
  };
  return isRepeat ? { $set } : { $set, $unset: { oRepeatInterval: '' } };
}
