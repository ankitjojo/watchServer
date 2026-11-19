import type { MonitorType } from '../../constants/monitorType.js';

/** What monitor services need from incidents when a monitor is deleted (D7). Implemented in Phase 7. */
export interface MonitorIncidentsPort {
  /** Closes the monitor's open incident with reason MONITOR_DELETED and sends no email. */
  closeOpenIncidentForDeletedMonitor(type: MonitorType, monitorId: string): Promise<void>;
}

export const noopIncidentsPort: MonitorIncidentsPort = {
  closeOpenIncidentForDeletedMonitor: () => Promise.resolve(),
};
