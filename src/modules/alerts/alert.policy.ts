import type { AlertMode } from '../../constants/alertMode.js';
import type { AlertType } from '../../constants/alertType.js';

/**
 * Results that mean "something is wrong". ERROR here is a monitor's OWN error (TD-29); a Source DB
 * outage never reaches the policy (FR-A4a).
 */
export type FailingResult = 'STALE' | 'NO_DATA' | 'DOWN' | 'ERROR';

export interface OpenIncidentFacts {
  openedAt: Date;
  lastAlertAt: Date | null;
  reminderCount: number;
}

export type IncidentAction = 'OPEN' | 'KEEP' | 'CLOSE' | 'NONE';

export type EmailDecision =
  | { kind: 'FAILURE' }
  | { kind: 'REMINDER'; reminderNumber: number }
  | { kind: 'RECOVERED'; downtimeMs: number };

export interface AlertDecision {
  incident: IncidentAction;
  email: EmailDecision | null;
}

export interface DecideInput {
  result: 'OK' | FailingResult;
  openIncident: OpenIncidentFacts | null;
  alertMode: AlertMode;
  repeatIntervalMs: number | null;
  now: Date;
}

/**
 * FR-A3, pure: what to do with the incident and which email (if any) a check produces.
 *
 * - No incident, failing: open one and send the first email.
 * - Open incident whose first email was never stored (crash between the two steps): send it now.
 *   The dedupe key makes this idempotent (TD-09).
 * - D4: STALE <-> NO_DATA (<-> the monitor's own ERROR, TD-29) stays in the same incident, so this
 *   function ignores which failure it is.
 * - D5: EVERY_CHECK records incidents for history, emails every failing check, no recovery email.
 */
export function decideAlert(input: DecideInput): AlertDecision {
  const { result, openIncident, alertMode, repeatIntervalMs, now } = input;

  if (!openIncident) {
    return result === 'OK'
      ? { incident: 'NONE', email: null }
      : { incident: 'OPEN', email: { kind: 'FAILURE' } };
  }

  if (result === 'OK') {
    if (alertMode === 'EVERY_CHECK') return { incident: 'CLOSE', email: null };
    return {
      incident: 'CLOSE',
      email: { kind: 'RECOVERED', downtimeMs: Math.max(0, now.getTime() - openIncident.openedAt.getTime()) },
    };
  }

  if (openIncident.lastAlertAt === null) return { incident: 'KEEP', email: { kind: 'FAILURE' } };

  switch (alertMode) {
    case 'ONCE_WITH_RECOVERY':
      return { incident: 'KEEP', email: null };
    case 'EVERY_CHECK':
      return { incident: 'KEEP', email: { kind: 'FAILURE' } };
    case 'REPEAT_EVERY': {
      const due =
        repeatIntervalMs !== null && now.getTime() - openIncident.lastAlertAt.getTime() >= repeatIntervalMs;
      return {
        incident: 'KEEP',
        email: due ? { kind: 'REMINDER', reminderNumber: openIncident.reminderCount + 1 } : null,
      };
    }
  }
}

export function alertTypeForResult(result: FailingResult): AlertType {
  switch (result) {
    case 'STALE':
      return 'WEBHOOK_STALE';
    case 'NO_DATA':
      return 'WEBHOOK_NO_DATA';
    case 'DOWN':
      return 'ENDPOINT_DOWN';
    case 'ERROR':
      return 'MONITOR_ERROR';
  }
}

/** TD-09: duplicate-key on these means "already created", so retries and crashes never double-send. */
export const dedupeKey = {
  incidentOpen: (incidentId: string): string => `incident:${incidentId}:open`,
  incidentReminder: (incidentId: string, n: number): string => `incident:${incidentId}:reminder:${n}`,
  incidentRecovered: (incidentId: string): string => `incident:${incidentId}:recovered`,
  everyCheck: (checkId: string): string => `check:${checkId}:every`,
  sourceErrorOpen: (incidentId: string): string => `sourceError:${incidentId}:open`,
  sourceErrorRecovered: (incidentId: string): string => `sourceError:${incidentId}:recovered`,
  test: (uuid: string): string => `test:${uuid}`,
};
