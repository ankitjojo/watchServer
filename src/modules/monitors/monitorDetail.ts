import { z } from 'zod';
import { checkResultSchema } from '../../constants/checkResult.js';
import type { MonitorType } from '../../constants/monitorType.js';
import { defineValidation } from '../../middlewares/validate.js';
import type { Clock } from '../../types/clock.js';
import { formatHumanDuration } from '../../utils/duration.js';
import { formatUtc } from '../../utils/time.js';
import type { AlertsService } from '../alerts/alerts.service.js';
import { toAlertRowView, type AlertRowView } from '../alerts/alerts.view.js';
import type { ChecksService } from '../checks/checks.service.js';
import type { Check } from '../checks/checks.types.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { Incident } from '../incidents/incidents.types.js';

const dayStart = z.iso.date().transform((d) => new Date(`${d}T00:00:00.000Z`));
const dayEnd = z.iso.date().transform((d) => new Date(`${d}T23:59:59.999Z`));

/** `?result=&from=&to=&cursor=` of a monitor detail page (history filters, FR-D4). Dates are plain days. */
export const detailQuery = z
  .object({
    result: z.union([z.literal(''), checkResultSchema]).optional(),
    from: z.union([z.literal(''), z.iso.date()]).optional(),
    to: z.union([z.literal(''), z.iso.date()]).optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export type DetailQuery = z.infer<typeof detailQuery>;

export function detailValidationParts<P extends z.ZodType>(params: P) {
  return defineValidation({ params, query: detailQuery });
}

export interface CheckRowView {
  started: string;
  result: string;
  trigger: string;
  detail: string;
}

export interface IncidentRowView {
  opened: string;
  closed: string;
  duration: string;
  note: string;
}

export interface MonitorDetailExtras {
  history: {
    rows: CheckRowView[];
    filters: { result: string; from: string; to: string };
    /** Link to the next (older) page, or undefined on the last page. */
    olderHref?: string;
  };
  incidents: IncidentRowView[];
  alerts: AlertRowView[];
  /** Read by charts.js through a data attribute (CSP forbids inline scripts). */
  chart: { seriesUrl: string; type: 'webhook' | 'endpoint'; thresholdMs?: number };
}

const PAGE_SIZE = 25;
const ALERT_ROWS = 20;
const INCIDENT_ROWS = 20;
const NO_DATA_REASON: Record<string, string> = {
  EMPTY_COLLECTION: 'Collection is empty',
  MISSING: 'Timestamp missing on the newest document',
  INVALID_TYPE: 'Timestamp has an unsupported type',
  INVALID_DATE: 'Timestamp is not a valid date',
  FUTURE: 'Timestamp is in the future',
};

function describeCheck(check: Check): string {
  if (check.error) return check.error.message;
  if (check.webhook) {
    if (check.result === 'NO_DATA') return NO_DATA_REASON[check.webhook.reason ?? ''] ?? 'No usable data';
    return check.webhook.ageMs === undefined
      ? ''
      : `Newest document ${formatHumanDuration(check.webhook.ageMs)} old`;
  }
  const attempts = check.endpoint?.attempts ?? [];
  const last = attempts.at(-1);
  if (!last) return '';
  const outcome =
    last.statusCode === undefined ? (last.errorMessage ?? 'No response') : `HTTP ${last.statusCode}`;
  return (
    `${outcome} · ${last.responseTimeMs} ms` + (attempts.length > 1 ? ` · ${attempts.length} attempts` : '')
  );
}

function incidentRow(incident: Incident, now: Date, timeZone: string): IncidentRowView {
  const end = incident.closedAt ?? now;
  return {
    opened: formatUtc(incident.openedAt, timeZone),
    closed: incident.closedAt ? formatUtc(incident.closedAt, timeZone) : 'ongoing',
    duration: formatHumanDuration(end.getTime() - incident.openedAt.getTime()),
    note:
      incident.closeReason === 'MONITOR_DELETED'
        ? 'Closed because the monitor was deleted'
        : incident.reminderCount > 0
          ? `${incident.reminderCount} reminder(s)`
          : '',
  };
}

export interface MonitorDetailBuilder {
  build(input: {
    type: MonitorType;
    monitorId: string;
    query: DetailQuery;
    thresholdMs?: number;
    canResend: boolean;
  }): Promise<MonitorDetailExtras>;
}

/** Shared by the webhook and endpoint detail pages (FR-D4): history, incidents, alerts and chart settings. */
export function createMonitorDetailBuilder(deps: {
  checks: Pick<ChecksService, 'listForMonitor'>;
  incidents: Pick<IncidentsService, 'listForMonitor'>;
  alerts: Pick<AlertsService, 'listForMonitor'>;
  clock: Clock;
  timeZone: string;
}): MonitorDetailBuilder {
  const { checks, incidents, alerts, clock, timeZone } = deps;
  return {
    async build({ type, monitorId, query, thresholdMs, canResend }) {
      const result = query.result === '' ? undefined : query.result;
      const from = query.from ? dayStart.parse(query.from) : undefined;
      const to = query.to ? dayEnd.parse(query.to) : undefined;
      const [page, incidentList, alertList] = await Promise.all([
        checks.listForMonitor(
          { monitorId, ...(result ? { result } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) },
          { ...(query.cursor ? { cursor: query.cursor } : {}), limit: PAGE_SIZE },
        ),
        incidents.listForMonitor(monitorId, INCIDENT_ROWS),
        alerts.listForMonitor(monitorId, ALERT_ROWS),
      ]);
      const filters = { result: query.result ?? '', from: query.from ?? '', to: query.to ?? '' };
      const older = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value) older.set(key, value);
      if (page.nextCursor) older.set('cursor', page.nextCursor);
      const now = clock.now();
      const kind = type === 'WEBHOOK' ? 'webhook' : 'endpoint';
      return {
        history: {
          rows: page.items.map((c) => ({
            started: formatUtc(c.startedAt, timeZone),
            result: c.result,
            trigger: c.trigger === 'MANUAL' ? 'Manual' : 'Schedule',
            detail: describeCheck(c),
          })),
          filters,
          ...(page.nextCursor ? { olderHref: `?${older.toString()}` } : {}),
        },
        incidents: incidentList.map((i) => incidentRow(i, now, timeZone)),
        alerts: alertList.map((a) => toAlertRowView(a, { timeZone, canResend })),
        chart: {
          seriesUrl: `/api/v1/monitors/${kind}/${monitorId}/series`,
          type: kind,
          ...(thresholdMs === undefined ? {} : { thresholdMs }),
        },
      };
    },
  };
}
