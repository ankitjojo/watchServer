import { formatUtc } from '../../../utils/time.js';
import { monitorUrl, renderEmail, subjectLine, type EmailRow } from './layout.js';
import type { AttemptInfo, BuiltEmail, EmailContext, EmailMonitor, ReminderInfo } from './types.js';
import { reminderRows } from './webhookStale.js';

export interface EndpointDownInput {
  monitor: EmailMonitor;
  attempts: AttemptInfo[];
  checkedAt: Date;
  reminder?: ReminderInfo;
}

function describe(attempt: AttemptInfo): string {
  const outcome =
    attempt.statusCode === undefined ? (attempt.errorMessage ?? 'No response') : `HTTP ${attempt.statusCode}`;
  return `${outcome} (${attempt.responseTimeMs} ms)`;
}

/** FR-E3 */
export function buildEndpointDown(input: EndpointDownInput, ctx: EmailContext): BuiltEmail {
  const { monitor, attempts, reminder } = input;
  const last = attempts.at(-1);
  const rows: EmailRow[] = [
    { label: 'Server', value: monitor.name },
    { label: 'Endpoint URL', value: monitor.url ?? '' },
    { label: 'Failure time', value: formatUtc(input.checkedAt, ctx.timeZone) },
    { label: 'Attempts', value: String(attempts.length) },
    { label: 'Last result', value: last ? describe(last) : 'none' },
    ...attempts.map((a) => ({ label: `Attempt ${a.attempt}`, value: describe(a) })),
    ...(reminder ? reminderRows(reminder) : []),
  ];
  const { text, html } = renderEmail({
    heading: reminder ? `Reminder #${reminder.number}: endpoint is down` : 'Endpoint is down',
    rows,
    links: [{ label: 'Open the monitor', url: monitorUrl(ctx, monitor) }],
  });
  return { subject: subjectLine('ENDPOINT_DOWN', monitor.name), text, html };
}
