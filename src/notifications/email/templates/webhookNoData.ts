import { formatHumanDuration } from '../../../utils/duration.js';
import { formatUtc } from '../../../utils/time.js';
import { monitorUrl, renderEmail, subjectLine, type EmailRow } from './layout.js';
import type { BuiltEmail, EmailContext, EmailMonitor, ReminderInfo } from './types.js';
import { reminderRows } from './webhookStale.js';

export interface WebhookNoDataInput {
  monitor: EmailMonitor;
  /** EMPTY_COLLECTION, MISSING, INVALID_TYPE, INVALID_DATE or FUTURE. */
  reason: string;
  lastDocId?: string;
  checkedAt: Date;
  reminder?: ReminderInfo;
}

const REASON_TEXT: Record<string, string> = {
  EMPTY_COLLECTION: 'The collection is empty.',
  MISSING: 'The newest document has no value for the timestamp key.',
  INVALID_TYPE: 'The timestamp key does not hold a date, an ISO-8601 string or an epoch number.',
  INVALID_DATE: 'The timestamp key on the newest document is not a valid date.',
  FUTURE: 'The timestamp on the newest document is more than a day in the future.',
};

export function buildWebhookNoData(input: WebhookNoDataInput, ctx: EmailContext): BuiltEmail {
  const { monitor, reminder } = input;
  const rows: EmailRow[] = [
    { label: 'Monitor', value: monitor.name },
    { label: 'Payment gateway', value: monitor.gatewayName ?? '' },
    { label: 'Collection', value: monitor.collection ?? '' },
    { label: 'Timestamp key', value: monitor.timestampKey ?? '' },
    { label: 'Problem', value: REASON_TEXT[input.reason] ?? 'The newest document could not be read.' },
    ...(input.lastDocId ? [{ label: 'Last document _id', value: input.lastDocId }] : []),
    { label: 'Check interval', value: formatHumanDuration(monitor.checkIntervalMs) },
    { label: 'Checked at', value: formatUtc(input.checkedAt, ctx.timeZone) },
    ...(reminder ? reminderRows(reminder) : []),
  ];
  const { text, html } = renderEmail(ctx, {
    heading: reminder ? `Reminder #${reminder.number}: no usable webhook data` : 'No usable webhook data',
    rows,
    links: [{ label: 'Open the monitor', url: monitorUrl(ctx, monitor) }],
  });
  return { subject: subjectLine(ctx, 'WEBHOOK_NO_DATA', monitor.name), text, html };
}
