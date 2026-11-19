import { formatHumanDuration } from '../../../utils/duration.js';
import { formatUtc } from '../../../utils/time.js';
import { monitorUrl, renderEmail, subjectLine, type EmailRow } from './layout.js';
import type { BuiltEmail, EmailContext, EmailMonitor, ReminderInfo } from './types.js';
import { reminderRows } from './webhookStale.js';

export interface MonitorCheckErrorInput {
  monitor: EmailMonitor;
  /** Safe code and message from the stored check (never a driver message). */
  errorCode: string;
  errorMessage: string;
  checkedAt: Date;
  reminder?: ReminderInfo;
}

/**
 * TD-29: ONE monitor could not read its collection while the Source DB itself answered
 * (missing collection, query timeout, query error). Sent like any failure of this monitor.
 */
export function buildMonitorCheckError(input: MonitorCheckErrorInput, ctx: EmailContext): BuiltEmail {
  const { monitor, reminder } = input;
  const rows: EmailRow[] = [
    { label: 'Monitor', value: monitor.name },
    { label: 'Payment gateway', value: monitor.gatewayName ?? '' },
    { label: 'Collection', value: monitor.collection ?? '' },
    { label: 'Timestamp key', value: monitor.timestampKey ?? '' },
    { label: 'Error', value: `${input.errorCode}: ${input.errorMessage}` },
    { label: 'Check interval', value: formatHumanDuration(monitor.checkIntervalMs) },
    { label: 'Checked at', value: formatUtc(input.checkedAt, ctx.timeZone) },
    ...(reminder ? reminderRows(reminder) : []),
  ];
  const { text, html } = renderEmail(ctx, {
    heading: reminder
      ? `Reminder #${reminder.number}: the monitor cannot read its collection`
      : 'The monitor cannot read its collection',
    intro: `The source database answered, but this collection could not be read, so ${ctx.appName} cannot tell whether webhooks are arriving for this gateway.`,
    rows,
    links: [{ label: 'Open the monitor', url: monitorUrl(ctx, monitor) }],
  });
  return { subject: subjectLine(ctx, 'MONITOR_ERROR', monitor.name), text, html };
}
