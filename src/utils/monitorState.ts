import type { MonitorState, MonitorStateDoc } from '../types/monitorState.js';
import { toObjectId } from './objectId.js';

export function initialStateDoc(): MonitorStateDoc {
  return {
    eLastResult: null,
    eCurrentStatus: null,
    dLastCheckAt: null,
    dNextCheckAt: null,
    iLastCheckId: null,
    iOpenIncidentId: null,
    nLastAgeMs: null,
    nLastResponseTimeMs: null,
  };
}

/** Tolerates old documents that lack newer optional fields (database rules: old docs must load). */
export function toMonitorState(doc: Partial<MonitorStateDoc> | undefined): MonitorState {
  return {
    lastResult: doc?.eLastResult ?? null,
    currentStatus: doc?.eCurrentStatus ?? null,
    lastCheckAt: doc?.dLastCheckAt ?? null,
    nextCheckAt: doc?.dNextCheckAt ?? null,
    lastCheckId: doc?.iLastCheckId?.toHexString() ?? null,
    openIncidentId: doc?.iOpenIncidentId?.toHexString() ?? null,
    lastAgeMs: doc?.nLastAgeMs ?? null,
    lastResponseTimeMs: doc?.nLastResponseTimeMs ?? null,
  };
}

/** Partial update of a monitor's state, in domain (camelCase) terms. */
export interface MonitorStatePatch {
  lastResult?: MonitorState['lastResult'];
  currentStatus?: MonitorState['currentStatus'];
  lastCheckAt?: Date;
  nextCheckAt?: Date | null;
  lastCheckId?: string;
  openIncidentId?: string | null;
  lastAgeMs?: number | null;
  lastResponseTimeMs?: number | null;
}

/**
 * Dotted `$set` fields for `oState.*`, so a running check never overwrites configuration
 * (database-design B.2). Only fields present in the patch are written.
 */
export function toStateSet(patch: MonitorStatePatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (patch.lastResult !== undefined) set['oState.eLastResult'] = patch.lastResult;
  if (patch.currentStatus !== undefined) set['oState.eCurrentStatus'] = patch.currentStatus;
  if (patch.lastCheckAt !== undefined) set['oState.dLastCheckAt'] = patch.lastCheckAt;
  if (patch.nextCheckAt !== undefined) set['oState.dNextCheckAt'] = patch.nextCheckAt;
  if (patch.lastCheckId !== undefined) set['oState.iLastCheckId'] = toObjectId(patch.lastCheckId);
  if (patch.openIncidentId !== undefined) {
    set['oState.iOpenIncidentId'] = patch.openIncidentId === null ? null : toObjectId(patch.openIncidentId);
  }
  if (patch.lastAgeMs !== undefined) set['oState.nLastAgeMs'] = patch.lastAgeMs;
  if (patch.lastResponseTimeMs !== undefined) set['oState.nLastResponseTimeMs'] = patch.lastResponseTimeMs;
  return set;
}
