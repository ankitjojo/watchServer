import type { AlertsPort, MonitorSnapshot } from '../../src/modules/alerts/alerts.port.js';
import type { Check } from '../../src/modules/checks/checks.types.js';

export interface RecordingAlerts extends AlertsPort {
  outcomes: { monitor: MonitorSnapshot; check: Check }[];
  sourceErrors: { monitor: MonitorSnapshot; check: Check }[];
  /** Make the next calls throw, to test that runners still store the check and update state. */
  failWith?: Error;
  openIncidentId: string | null;
}

export function createRecordingAlerts(): RecordingAlerts {
  const fake: RecordingAlerts = {
    outcomes: [],
    sourceErrors: [],
    openIncidentId: null,
    processCheckOutcome(input) {
      fake.outcomes.push(input);
      if (fake.failWith) return Promise.reject(fake.failWith);
      return Promise.resolve({ openIncidentId: fake.openIncidentId });
    },
    handleSourceError(input) {
      fake.sourceErrors.push(input);
      return fake.failWith ? Promise.reject(fake.failWith) : Promise.resolve();
    },
  };
  return fake;
}
