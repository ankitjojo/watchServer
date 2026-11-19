import { formatUtc } from '../../../utils/time.js';
import { monitorUrl, renderEmail, subjectLine } from './layout.js';
import type { BuiltEmail, EmailContext, EmailMonitor } from './types.js';

export interface TestEmailInput {
  monitor: EmailMonitor;
  requestedBy: string;
  at: Date;
}

/** FR-D3: a sample alert so admins can check the whole path to the recipients. */
export function buildTestEmail(input: TestEmailInput, ctx: EmailContext): BuiltEmail {
  const { text, html } = renderEmail(ctx, {
    heading: 'Test email',
    intro: 'This is a test alert. Nothing is wrong.',
    rows: [
      { label: 'Monitor', value: input.monitor.name },
      { label: 'Requested by', value: input.requestedBy },
      { label: 'Sent at', value: formatUtc(input.at, ctx.timeZone) },
    ],
    links: [{ label: 'Open the monitor', url: monitorUrl(ctx, input.monitor) }],
  });
  return { subject: subjectLine(ctx, 'TEST', input.monitor.name), text, html };
}
