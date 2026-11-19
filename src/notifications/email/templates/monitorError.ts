import { formatUtc } from '../../../utils/time.js';
import { monitorUrl, renderEmail, subjectLine, type EmailRow } from './layout.js';
import type { AffectedMonitor, BuiltEmail, EmailContext } from './types.js';

export interface MonitorErrorInput {
  firstErrorAt: Date;
  errorCode: string;
  errorMessage: string;
  affected: AffectedMonitor[];
}

/** FR-A4a: one email per outage, listing every affected monitor. Masters only. */
export function buildMonitorError(input: MonitorErrorInput, ctx: EmailContext): BuiltEmail {
  const rows: EmailRow[] = [
    { label: 'First error', value: formatUtc(input.firstErrorAt, ctx.timeZone) },
    { label: 'Error', value: `${input.errorCode}: ${input.errorMessage}` },
    { label: 'Affected monitors', value: String(input.affected.length) },
    ...input.affected.map((m) => ({ label: '•', value: m.name })),
  ];
  const { text, html } = renderEmail({
    heading: 'The source database could not be read',
    intro:
      'Webhook monitors cannot tell whether payments are flowing while the source database is unreachable. Their status is left unchanged until it answers again.',
    rows,
    links: input.affected.map((m) => ({ label: `Open ${m.name}`, url: monitorUrl(ctx, m) })),
  });
  return {
    subject: subjectLine('MONITOR_ERROR', `Source DB (${input.affected.length} monitors)`),
    text,
    html,
  };
}
