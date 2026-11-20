import { ALERT_MODE } from '../../constants/alertMode.js';
import { DISPLAY_STATUS_LABEL, displayStatus } from '../../utils/displayStatus.js';
import { formatDurationInput } from '../../utils/duration.js';
import { ALERT_MODE_LABEL } from '../../utils/labels.js';
import { maskUrl } from '../../utils/maskUrl.js';
import { formatUtc } from '../../utils/time.js';
import type { DeletedRowView } from '../../utils/deletedRows.js';
import type { EndpointMonitor } from './endpointMonitors.types.js';

export interface EndpointMonitorRowView {
  id: string;
  serverName: string;
  /** Masked: query values and credentials never reach lists or emails (security 2.9, database-design B.6). */
  url: string;
  status: string;
  statusLabel: string;
  checkEvery: string;
  retryCount: number;
  lastCheck: string;
  nextCheck: string;
  lastResponse: string;
}

export interface EndpointMonitorDetailView extends EndpointMonitorRowView {
  alertMode: string;
  repeatEvery: string;
  isEnabled: boolean;
  created: string;
  updated: string;
  /** UTC time of deletion; null for a live monitor. */
  deletedOn: string | null;
}

const dash = '—';

export function toEndpointRowView(monitor: EndpointMonitor, timeZone: string): EndpointMonitorRowView {
  const status = displayStatus(monitor);
  return {
    id: monitor.id,
    serverName: monitor.serverName,
    url: maskUrl(monitor.url),
    status,
    statusLabel: DISPLAY_STATUS_LABEL[status],
    checkEvery: `every ${formatDurationInput(monitor.checkInterval)}`,
    retryCount: monitor.retryCount,
    lastCheck: monitor.state.lastCheckAt ? formatUtc(monitor.state.lastCheckAt, timeZone) : dash,
    nextCheck:
      monitor.isEnabled && monitor.state.nextCheckAt ? formatUtc(monitor.state.nextCheckAt, timeZone) : dash,
    lastResponse: monitor.state.lastResponseTimeMs === null ? dash : `${monitor.state.lastResponseTimeMs} ms`,
  };
}

export function toEndpointDetailView(monitor: EndpointMonitor, timeZone: string): EndpointMonitorDetailView {
  return {
    ...toEndpointRowView(monitor, timeZone),
    alertMode: ALERT_MODE_LABEL[monitor.alertMode],
    repeatEvery: monitor.repeatInterval ? formatDurationInput(monitor.repeatInterval) : dash,
    isEnabled: monitor.isEnabled,
    created: formatUtc(monitor.createdAt, timeZone),
    updated: formatUtc(monitor.updatedAt, timeZone),
    deletedOn: monitor.deletedAt ? formatUtc(monitor.deletedAt, timeZone) : null,
  };
}

/** Same columns as the live list (minus Status/Next check, which mean nothing once deleted), plus the delete time. */
export const ENDPOINT_DELETED_COLUMNS = [
  'Server',
  'URL',
  'Status',
  'Check',
  'Retries',
  'Last check',
  'Last response',
  'Deleted on (UTC)',
];

export function toEndpointDeletedRow(monitor: EndpointMonitor, timeZone: string): DeletedRowView {
  const r = toEndpointRowView(monitor, timeZone);
  return {
    href: `/endpoint-monitors/${monitor.id}`,
    cells: [
      r.serverName,
      r.url,
      'Deleted',
      r.checkEvery,
      String(r.retryCount),
      r.lastCheck,
      r.lastResponse,
      monitor.deletedAt ? formatUtc(monitor.deletedAt, timeZone) : dash,
    ],
  };
}

/** Edit form values. Only admins reach the edit form, so the full URL is shown there. */
export function toEndpointFormValues(monitor: EndpointMonitor): Record<string, unknown> {
  return {
    serverName: monitor.serverName,
    url: monitor.url,
    checkInterval: { value: monitor.checkInterval.value, unit: monitor.checkInterval.unit },
    retryCount: monitor.retryCount,
    alertMode: monitor.alertMode,
    repeatInterval: monitor.repeatInterval
      ? { value: monitor.repeatInterval.value, unit: monitor.repeatInterval.unit }
      : { value: '', unit: 'MINUTE' },
    isEnabled: monitor.isEnabled,
  };
}

export function endpointFormDefaults(defaultRetryCount: number): Record<string, unknown> {
  return {
    checkInterval: { value: 5, unit: 'MINUTE' },
    retryCount: defaultRetryCount,
    alertMode: ALERT_MODE.ONCE_WITH_RECOVERY,
    repeatInterval: { value: '', unit: 'MINUTE' },
    isEnabled: true,
  };
}
