import { ALERT_MODE, type AlertMode } from '../../constants/alertMode.js';
import { INTERVAL_UNITS, REPEAT_UNITS, THRESHOLD_UNITS } from '../../constants/durationUnit.js';
import { DISPLAY_STATUS_LABEL, displayStatus } from '../../utils/displayStatus.js';
import { formatDurationInput, formatHumanDuration } from '../../utils/duration.js';
import { ALERT_MODE_LABEL } from '../../utils/labels.js';
import { formatUtc } from '../../utils/time.js';
import type { DeletedRowView } from '../../utils/deletedRows.js';
import type { WebhookMonitor } from './webhookMonitors.types.js';

export interface WebhookMonitorRowView {
  id: string;
  name: string;
  gatewayName: string;
  collection: string;
  status: string;
  statusLabel: string;
  checkEvery: string;
  threshold: string;
  lastCheck: string;
  nextCheck: string;
  lastAge: string;
}

export interface WebhookMonitorDetailView extends WebhookMonitorRowView {
  timestampKey: string;
  alertMode: string;
  repeatEvery: string;
  isEnabled: boolean;
  hasIndexWarning: boolean;
  created: string;
  updated: string;
  /** Time of deletion (display zone); null for a live monitor. */
  deletedOn: string | null;
}

const dash = '—';

export function toWebhookRowView(monitor: WebhookMonitor, timeZone: string): WebhookMonitorRowView {
  const status = displayStatus(monitor);
  return {
    id: monitor.id,
    name: monitor.name,
    gatewayName: monitor.gatewayName,
    collection: monitor.sourceCollection,
    status,
    statusLabel: DISPLAY_STATUS_LABEL[status],
    checkEvery: `every ${formatDurationInput(monitor.checkInterval)}`,
    threshold: formatDurationInput(monitor.threshold),
    lastCheck: monitor.state.lastCheckAt ? formatUtc(monitor.state.lastCheckAt, timeZone) : dash,
    nextCheck:
      monitor.isEnabled && monitor.state.nextCheckAt ? formatUtc(monitor.state.nextCheckAt, timeZone) : dash,
    lastAge: monitor.state.lastAgeMs === null ? dash : formatHumanDuration(monitor.state.lastAgeMs),
  };
}

export function toWebhookDetailView(monitor: WebhookMonitor, timeZone: string): WebhookMonitorDetailView {
  return {
    ...toWebhookRowView(monitor, timeZone),
    timestampKey: monitor.timestampKey,
    alertMode: ALERT_MODE_LABEL[monitor.alertMode],
    repeatEvery: monitor.repeatInterval ? formatDurationInput(monitor.repeatInterval) : dash,
    isEnabled: monitor.isEnabled,
    hasIndexWarning: !monitor.hasTimestampIndexAtSave,
    created: formatUtc(monitor.createdAt, timeZone),
    updated: formatUtc(monitor.updatedAt, timeZone),
    deletedOn: monitor.deletedAt ? formatUtc(monitor.deletedAt, timeZone) : null,
  };
}

/** Same columns as the live list (minus Status/Next check, which mean nothing once deleted), plus the delete time. */
export const WEBHOOK_DELETED_COLUMNS = [
  'Name',
  'Gateway',
  'Collection',
  'Status',
  'Check',
  'Threshold',
  'Last check',
  'Last doc age',
  'Deleted on',
];

export function toWebhookDeletedRow(monitor: WebhookMonitor, timeZone: string): DeletedRowView {
  const r = toWebhookRowView(monitor, timeZone);
  return {
    href: `/webhook-monitors/${monitor.id}`,
    cells: [
      r.name,
      r.gatewayName,
      r.collection,
      'Deleted',
      r.checkEvery,
      r.threshold,
      r.lastCheck,
      r.lastAge,
      monitor.deletedAt ? formatUtc(monitor.deletedAt, timeZone) : dash,
    ],
  };
}

/** Values for the edit form: nested objects match the posted field names (`threshold[value]`). */
export function toWebhookFormValues(monitor: WebhookMonitor): Record<string, unknown> {
  return {
    name: monitor.name,
    gatewayName: monitor.gatewayName,
    sourceCollection: monitor.sourceCollection,
    timestampKey: monitor.timestampKey,
    checkInterval: { value: monitor.checkInterval.value, unit: monitor.checkInterval.unit },
    threshold: { value: monitor.threshold.value, unit: monitor.threshold.unit },
    alertMode: monitor.alertMode,
    repeatInterval: monitor.repeatInterval
      ? { value: monitor.repeatInterval.value, unit: monitor.repeatInterval.unit }
      : { value: '', unit: 'MINUTE' },
    isEnabled: monitor.isEnabled,
  };
}

export const WEBHOOK_FORM_DEFAULTS: Record<string, unknown> = {
  timestampKey: 'dCreatedAt',
  checkInterval: { value: 10, unit: 'MINUTE' },
  threshold: { value: 2, unit: 'HOUR' },
  alertMode: ALERT_MODE.ONCE_WITH_RECOVERY,
  repeatInterval: { value: '', unit: 'MINUTE' },
  isEnabled: true,
};

export const ALERT_MODE_OPTIONS: { value: AlertMode; label: string }[] = Object.values(ALERT_MODE).map(
  (value) => ({
    value,
    label: ALERT_MODE_LABEL[value],
  }),
);

export const DURATION_UNIT_OPTIONS = {
  interval: [...INTERVAL_UNITS],
  threshold: [...THRESHOLD_UNITS],
  repeat: [...REPEAT_UNITS],
};
