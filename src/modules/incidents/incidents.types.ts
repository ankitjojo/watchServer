import type { ObjectId } from 'mongodb';
import type { CheckResult } from '../../constants/checkResult.js';
import type { IncidentCloseReason } from '../../constants/incidentCloseReason.js';
import type { IncidentKind } from '../../constants/incidentKind.js';

/** Stored shape (persistence layer only, TD-16). */
export interface IncidentDoc {
  _id: ObjectId;
  /** Null for a source outage (it spans many monitors). */
  iMonitorId: ObjectId | null;
  eKind: IncidentKind;
  dOpenedAt: Date;
  /** Always stored (null while open): the partial unique indexes need an explicit null. */
  dClosedAt: Date | null;
  eOpeningResult: CheckResult;
  aAffectedMonitorIds: ObjectId[];
  iLastCheckId: ObjectId | null;
  /** Source of truth for reminder timing (D12). */
  dLastAlertAt: Date | null;
  nReminderCount: number;
  eCloseReason?: IncidentCloseReason;
  dCreatedAt: Date;
  dUpdatedAt: Date;
}

export interface Incident {
  id: string;
  monitorId: string | null;
  kind: IncidentKind;
  openedAt: Date;
  closedAt: Date | null;
  openingResult: CheckResult;
  affectedMonitorIds: string[];
  lastCheckId: string | null;
  lastAlertAt: Date | null;
  reminderCount: number;
  closeReason?: IncidentCloseReason;
  createdAt: Date;
  updatedAt: Date;
}
