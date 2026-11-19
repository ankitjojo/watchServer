import type { ObjectId } from 'mongodb';
import type { AlertMode } from '../../constants/alertMode.js';
import type { Duration, DurationInput, StoredDuration } from '../../types/duration.js';
import type { MonitorState, MonitorStateDoc } from '../../types/monitorState.js';

/** Stored shape (persistence layer only, TD-16). */
export interface WebhookMonitorDoc {
  _id: ObjectId;
  sName: string;
  sGatewayName: string;
  sSourceCollection: string;
  sTimestampKey: string;
  oCheckInterval: StoredDuration;
  oThreshold: StoredDuration;
  eAlertMode: AlertMode;
  /** Present only when eAlertMode is REPEAT_EVERY. */
  oRepeatInterval?: StoredDuration;
  bIsEnabled: boolean;
  bHasDescIndexAtSave: boolean;
  oState: MonitorStateDoc;
  /** Always stored (null when active): partial unique indexes need an explicit null. */
  dDeletedAt: Date | null;
  iCreatedBy: ObjectId;
  iUpdatedBy: ObjectId;
  dCreatedAt: Date;
  dUpdatedAt: Date;
}

export interface WebhookMonitor {
  id: string;
  name: string;
  gatewayName: string;
  sourceCollection: string;
  timestampKey: string;
  checkInterval: Duration;
  threshold: Duration;
  alertMode: AlertMode;
  repeatInterval?: Duration;
  isEnabled: boolean;
  hasTimestampIndexAtSave: boolean;
  state: MonitorState;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Validated form input (FR-W1). */
export interface WebhookMonitorInput {
  name: string;
  gatewayName: string;
  sourceCollection: string;
  timestampKey: string;
  checkInterval: DurationInput;
  threshold: DurationInput;
  alertMode: AlertMode;
  repeatInterval?: DurationInput | undefined;
  isEnabled: boolean;
}

/** Result of a save: warnings are shown to the admin but do not block it (FR-W2, section 5). */
export interface SaveResult {
  monitor: WebhookMonitor;
  warnings: string[];
}
