import { ALERT_STATUS } from '../../constants/alertStatus.js';
import { formatUtc } from '../../utils/time.js';
import type { Alert } from './alerts.types.js';

export interface AlertRowView {
  id: string;
  created: string;
  type: string;
  /** Grouped source-outage alerts have no single monitor. */
  monitor: string;
  status: string;
  statusLabel: string;
  isFailed: boolean;
  recipientCount: number;
  /** For a tooltip. Alert recipients are admin-visible data (FR-A1), never part of general logs. */
  recipients: string;
  sent: string;
  error: string;
  canResend: boolean;
}

const dash = '—';

export function toAlertRowView(
  alert: Alert,
  options: { timeZone: string; canResend: boolean },
): AlertRowView {
  const isFailed = alert.status === ALERT_STATUS.FAILED;
  return {
    id: alert.id,
    created: formatUtc(alert.createdAt, options.timeZone),
    type: alert.type,
    monitor:
      alert.monitorName ?? (alert.type === 'MONITOR_ERROR' || alert.monitorId === null ? 'Source DB' : dash),
    status: alert.status,
    statusLabel: alert.status.charAt(0) + alert.status.slice(1).toLowerCase(),
    isFailed,
    recipientCount: alert.recipients.length,
    recipients: alert.recipients.map((r) => r.email).join(', '),
    sent: alert.sentAt ? formatUtc(alert.sentAt, options.timeZone) : dash,
    error: alert.failureReason ?? alert.attempts.findLast((a) => !a.isSuccess)?.errorMessage ?? '',
    canResend: options.canResend && isFailed,
  };
}
