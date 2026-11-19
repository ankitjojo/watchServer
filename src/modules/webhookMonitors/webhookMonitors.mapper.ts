import type { ObjectId } from 'mongodb';
import { fromStoredDuration, toStoredDuration } from '../../utils/duration.js';
import { initialStateDoc, toMonitorState } from '../../utils/monitorState.js';
import type { WebhookMonitor, WebhookMonitorDoc, WebhookMonitorInput } from './webhookMonitors.types.js';

export function toWebhookMonitor(doc: WebhookMonitorDoc): WebhookMonitor {
  return {
    id: doc._id.toHexString(),
    name: doc.sName,
    gatewayName: doc.sGatewayName,
    sourceCollection: doc.sSourceCollection,
    timestampKey: doc.sTimestampKey,
    checkInterval: fromStoredDuration(doc.oCheckInterval),
    threshold: fromStoredDuration(doc.oThreshold),
    alertMode: doc.eAlertMode,
    ...(doc.oRepeatInterval ? { repeatInterval: fromStoredDuration(doc.oRepeatInterval) } : {}),
    isEnabled: doc.bIsEnabled,
    hasTimestampIndexAtSave: doc.bHasDescIndexAtSave,
    state: toMonitorState(doc.oState),
    createdBy: doc.iCreatedBy.toHexString(),
    updatedBy: doc.iUpdatedBy.toHexString(),
    createdAt: doc.dCreatedAt,
    updatedAt: doc.dUpdatedAt,
  };
}

interface SaveContext {
  now: Date;
  userId: ObjectId;
  daysPerMonth: number;
}

export function toWebhookMonitorDoc(
  input: WebhookMonitorInput,
  ctx: SaveContext & { hasIndex: boolean },
): Omit<WebhookMonitorDoc, '_id'> {
  return {
    sName: input.name,
    sGatewayName: input.gatewayName,
    sSourceCollection: input.sourceCollection,
    sTimestampKey: input.timestampKey,
    oCheckInterval: toStoredDuration(input.checkInterval, ctx.daysPerMonth),
    oThreshold: toStoredDuration(input.threshold, ctx.daysPerMonth),
    eAlertMode: input.alertMode,
    ...(input.alertMode === 'REPEAT_EVERY' && input.repeatInterval
      ? { oRepeatInterval: toStoredDuration(input.repeatInterval, ctx.daysPerMonth) }
      : {}),
    bIsEnabled: input.isEnabled,
    bHasDescIndexAtSave: ctx.hasIndex,
    oState: initialStateDoc(),
    dDeletedAt: null,
    iCreatedBy: ctx.userId,
    iUpdatedBy: ctx.userId,
    dCreatedAt: ctx.now,
    dUpdatedAt: ctx.now,
  };
}

export interface WebhookMonitorUpdate {
  $set: Partial<WebhookMonitorDoc>;
  $unset?: { oRepeatInterval: '' };
}

/**
 * Config fields only. It never touches `oState` (a running check owns it) or `dCreatedAt`.
 * `hasIndex` is passed only when the collection or key changed and was re-inspected.
 */
export function toWebhookMonitorUpdate(
  input: WebhookMonitorInput,
  ctx: SaveContext & { hasIndex?: boolean },
): WebhookMonitorUpdate {
  const isRepeat = input.alertMode === 'REPEAT_EVERY' && input.repeatInterval !== undefined;
  const $set: Partial<WebhookMonitorDoc> = {
    sName: input.name,
    sGatewayName: input.gatewayName,
    sSourceCollection: input.sourceCollection,
    sTimestampKey: input.timestampKey,
    oCheckInterval: toStoredDuration(input.checkInterval, ctx.daysPerMonth),
    oThreshold: toStoredDuration(input.threshold, ctx.daysPerMonth),
    eAlertMode: input.alertMode,
    bIsEnabled: input.isEnabled,
    iUpdatedBy: ctx.userId,
    dUpdatedAt: ctx.now,
    ...(ctx.hasIndex === undefined ? {} : { bHasDescIndexAtSave: ctx.hasIndex }),
    ...(isRepeat && input.repeatInterval
      ? { oRepeatInterval: toStoredDuration(input.repeatInterval, ctx.daysPerMonth) }
      : {}),
  };
  return isRepeat ? { $set } : { $set, $unset: { oRepeatInterval: '' } };
}
