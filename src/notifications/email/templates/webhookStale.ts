import { formatHumanDuration } from '../../../utils/duration.js';
import { formatUtc } from '../../../utils/time.js';
import { monitorUrl, renderEmail, subjectLine, type EmailRow } from './layout.js';
import type { BuiltEmail, EmailContext, EmailMonitor, ReminderInfo } from './types.js';

export interface WebhookStaleInput {
  monitor: EmailMonitor;
  lastDocId?: string;
  lastDocTimestamp?: Date;
  ageMs: number;
  checkedAt: Date;
  reminder?: ReminderInfo;
}

export function reminderRows(reminder: ReminderInfo): EmailRow[] {
  return [
    { label: 'Reminder', value: `#${reminder.number}` },
    { label: 'Incident open for', value: formatHumanDuration(reminder.openForMs) },
    { label: 'Earlier reminders', value: String(reminder.number - 1) },
  ];
}

/** FR-W4 */
export function buildWebhookStale(input: WebhookStaleInput, ctx: EmailContext): BuiltEmail {
  const { monitor, reminder } = input;
  const rows: EmailRow[] = [
    { label: 'Monitor', value: monitor.name },
    { label: 'Payment gateway', value: monitor.gatewayName ?? '' },
    { label: 'Collection', value: monitor.collection ?? '' },
    { label: 'Timestamp key', value: monitor.timestampKey ?? '' },
    { label: 'Last document _id', value: input.lastDocId ?? 'unknown' },
    {
      label: 'Last document time',
      value: input.lastDocTimestamp ? formatUtc(input.lastDocTimestamp, ctx.timeZone) : 'unknown',
    },
    { label: 'Age', value: formatHumanDuration(input.ageMs) },
    { label: 'Threshold', value: formatHumanDuration(monitor.thresholdMs ?? 0) },
    { label: 'Check interval', value: formatHumanDuration(monitor.checkIntervalMs) },
    { label: 'Checked at', value: formatUtc(input.checkedAt, ctx.timeZone) },
    ...(reminder ? reminderRows(reminder) : []),
  ];
  const { text, html } = renderEmail(ctx, {
    heading: reminder ? `Reminder #${reminder.number}: no new webhook documents` : 'No new webhook documents',
    rows,
    links: [{ label: 'Open the monitor', url: monitorUrl(ctx, monitor) }],
  });
  return { subject: subjectLine(ctx, 'WEBHOOK_STALE', monitor.name), text, html };
}
