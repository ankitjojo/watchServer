import { DISPLAY_STATUS, type DisplayStatus } from '../constants/display.js';
import type { MonitorState } from '../types/monitorState.js';

/** Plan Appendix B.2: what the dashboard shows for a monitor. */
export function displayStatus(monitor: {
  isEnabled: boolean;
  state: MonitorState;
  deletedAt?: Date | null;
}): DisplayStatus {
  if (monitor.deletedAt) return DISPLAY_STATUS.DELETED;
  if (!monitor.isEnabled) return DISPLAY_STATUS.PAUSED;
  return monitor.state.lastResult ?? DISPLAY_STATUS.PENDING_FIRST_CHECK;
}

export const DISPLAY_STATUS_LABEL: Record<DisplayStatus, string> = {
  OK: 'OK',
  STALE: 'Stale',
  NO_DATA: 'No data',
  DOWN: 'Down',
  ERROR: 'Error',
  PAUSED: 'Paused',
  DELETED: 'Deleted',
  PENDING_FIRST_CHECK: 'Not checked yet',
};
