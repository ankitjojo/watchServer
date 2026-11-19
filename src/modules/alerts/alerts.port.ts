import type { AlertMode } from '../../constants/alertMode.js';
import type { MonitorType } from '../../constants/monitorType.js';
import type { Check } from '../checks/checks.types.js';

/**
 * What an alert needs to know about a monitor, copied at check time so the alert stays readable
 * after the monitor is edited or deleted (database-design `alerts.oMonitorSnapshot`).
 * Runners pass this in, so `alerts` never imports the monitor modules (architecture rule 3).
 */
export interface MonitorSnapshot {
  monitorType: MonitorType;
  monitorId: string;
  name: string;
  gatewayName?: string;
  sourceCollection?: string;
  timestampKey?: string;
  /** Masked: query values and credentials removed (security). */
  url?: string;
  thresholdMs?: number;
  checkIntervalMs: number;
  alertMode: AlertMode;
  repeatIntervalMs?: number;
}

/** What the runners need from the alerts module. Implemented by alerts.service.ts (Phase 8). */
export interface AlertsPort {
  /**
   * Applies the alert rules (FR-A3) to any check except a Source DB outage, including a webhook
   * monitor's own ERROR (TD-29): opens/keeps/closes the incident and stores any alert (store first,
   * FR-A1). Returns the monitor's open incident, if any.
   */
  processCheckOutcome(input: {
    monitor: MonitorSnapshot;
    check: Check;
  }): Promise<{ openIncidentId: string | null }>;
  /** The Source DB itself was unreachable (FR-A4a): grouped, masters only, monitor state untouched. */
  handleSourceError(input: { monitor: MonitorSnapshot; check: Check }): Promise<void>;
}

/** Until Phase 8: checks are stored, but no incident or alert is created. */
export const noopAlertsPort: AlertsPort = {
  processCheckOutcome: () => Promise.resolve({ openIncidentId: null }),
  handleSourceError: () => Promise.resolve(),
};
