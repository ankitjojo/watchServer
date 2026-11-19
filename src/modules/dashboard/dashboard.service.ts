import { DISPLAY_STATUS, type DisplayStatus } from '../../constants/display.js';
import type { MonitorType } from '../../constants/monitorType.js';
import { DISPLAY_STATUS_LABEL, displayStatus } from '../../utils/displayStatus.js';
import { formatHumanDuration } from '../../utils/duration.js';
import { formatUtc } from '../../utils/time.js';
import type { AlertsService } from '../alerts/alerts.service.js';
import type { EndpointMonitorsService } from '../endpointMonitors/endpointMonitors.service.js';
import type { EndpointMonitor } from '../endpointMonitors/endpointMonitors.types.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { WebhookMonitorsService } from '../webhookMonitors/webhookMonitors.service.js';
import type { WebhookMonitor } from '../webhookMonitors/webhookMonitors.types.js';

export interface OverviewCards {
  total: number;
  ok: number;
  failing: number;
  paused: number;
  openIncidents: number;
  emailsFailed: number;
}

export interface OverviewRow {
  type: MonitorType;
  typeLabel: string;
  id: string;
  name: string;
  href: string;
  status: DisplayStatus;
  statusLabel: string;
  lastCheck: string;
  nextCheck: string;
  /** Webhook: age of the newest document. Endpoint: last response time. */
  metric: string;
}

export interface Overview {
  cards: OverviewCards;
  rows: OverviewRow[];
  sourceOutage: { openedAt: string; affectedCount: number } | null;
}

const FAILING: ReadonlySet<DisplayStatus> = new Set([
  DISPLAY_STATUS.STALE,
  DISPLAY_STATUS.NO_DATA,
  DISPLAY_STATUS.DOWN,
  DISPLAY_STATUS.ERROR,
]);

const dash = '—';

function webhookRow(m: WebhookMonitor, timeZone: string): OverviewRow {
  const status = displayStatus(m);
  return {
    type: 'WEBHOOK',
    typeLabel: 'Webhook',
    id: m.id,
    name: m.name,
    href: `/webhook-monitors/${m.id}`,
    status,
    statusLabel: DISPLAY_STATUS_LABEL[status],
    lastCheck: m.state.lastCheckAt ? formatUtc(m.state.lastCheckAt, timeZone) : dash,
    nextCheck: m.isEnabled && m.state.nextCheckAt ? formatUtc(m.state.nextCheckAt, timeZone) : dash,
    metric: m.state.lastAgeMs === null ? dash : formatHumanDuration(m.state.lastAgeMs),
  };
}

function endpointRow(m: EndpointMonitor, timeZone: string): OverviewRow {
  const status = displayStatus(m);
  return {
    type: 'ENDPOINT',
    typeLabel: 'Endpoint',
    id: m.id,
    name: m.serverName,
    href: `/endpoint-monitors/${m.id}`,
    status,
    statusLabel: DISPLAY_STATUS_LABEL[status],
    lastCheck: m.state.lastCheckAt ? formatUtc(m.state.lastCheckAt, timeZone) : dash,
    nextCheck: m.isEnabled && m.state.nextCheckAt ? formatUtc(m.state.nextCheckAt, timeZone) : dash,
    metric: m.state.lastResponseTimeMs === null ? dash : `${m.state.lastResponseTimeMs} ms`,
  };
}

/** FR-D1, pure: the count cards from the rows plus two numbers that come from other modules. */
export function buildCards(
  rows: Pick<OverviewRow, 'status'>[],
  extras: { openIncidents: number; emailsFailed: number },
): OverviewCards {
  return {
    total: rows.length,
    ok: rows.filter((r) => r.status === DISPLAY_STATUS.OK).length,
    failing: rows.filter((r) => FAILING.has(r.status)).length,
    paused: rows.filter((r) => r.status === DISPLAY_STATUS.PAUSED).length,
    openIncidents: extras.openIncidents,
    emailsFailed: extras.emailsFailed,
  };
}

export interface DashboardService {
  overview(): Promise<Overview>;
}

export function createDashboardService(deps: {
  webhookMonitors: Pick<WebhookMonitorsService, 'list'>;
  endpointMonitors: Pick<EndpointMonitorsService, 'list'>;
  incidents: Pick<IncidentsService, 'countOpen' | 'findOpenSourceError'>;
  alerts: Pick<AlertsService, 'countFailed'>;
  timeZone: string;
}): DashboardService {
  const { timeZone } = deps;
  return {
    async overview() {
      const [webhooks, endpoints, openIncidents, emailsFailed, outage] = await Promise.all([
        deps.webhookMonitors.list(),
        deps.endpointMonitors.list(),
        deps.incidents.countOpen(),
        deps.alerts.countFailed(),
        deps.incidents.findOpenSourceError(),
      ]);
      const rows = [
        ...webhooks.map((m) => webhookRow(m, timeZone)),
        ...endpoints.map((m) => endpointRow(m, timeZone)),
      ];
      return {
        cards: buildCards(rows, { openIncidents, emailsFailed }),
        rows,
        sourceOutage: outage
          ? {
              openedAt: formatUtc(outage.openedAt, timeZone),
              affectedCount: outage.affectedMonitorIds.length,
            }
          : null,
      };
    },
  };
}
