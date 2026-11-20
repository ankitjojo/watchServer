import type { ObjectId } from 'mongodb';
import type { AlertMode } from '../../constants/alertMode.js';
import type { Duration, DurationInput, StoredDuration } from '../../types/duration.js';
import type { MonitorState, MonitorStateDoc } from '../../types/monitorState.js';

/** Stored shape (persistence layer only, TD-16). */
export interface EndpointMonitorDoc {
  _id: ObjectId;
  sServerName: string;
  sUrl: string;
  oCheckInterval: StoredDuration;
  nRetryCount: number;
  eAlertMode: AlertMode;
  /** Present only when eAlertMode is REPEAT_EVERY. */
  oRepeatInterval?: StoredDuration;
  bIsEnabled: boolean;
  oState: MonitorStateDoc;
  /** Always stored (null when active): partial unique indexes need an explicit null. */
  dDeletedAt: Date | null;
  /** Who deleted it. Absent on monitors deleted before this field existed. */
  iDeletedBy?: ObjectId | null;
  iCreatedBy: ObjectId;
  iUpdatedBy: ObjectId;
  dCreatedAt: Date;
  dUpdatedAt: Date;
}

export interface EndpointMonitor {
  id: string;
  serverName: string;
  /** Full URL. Mask it with maskUrl() before showing it to anyone but the admin editing it. */
  url: string;
  checkInterval: Duration;
  retryCount: number;
  alertMode: AlertMode;
  repeatInterval?: Duration;
  isEnabled: boolean;
  state: MonitorState;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** Set once deleted: the monitor stopped and is only listed under Deleted records. */
  deletedAt: Date | null;
}

/** Validated form input (FR-E1). */
export interface EndpointMonitorInput {
  serverName: string;
  url: string;
  checkInterval: DurationInput;
  retryCount: number;
  alertMode: AlertMode;
  repeatInterval?: DurationInput | undefined;
  isEnabled: boolean;
}
