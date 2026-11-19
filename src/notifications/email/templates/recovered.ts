import { formatHumanDuration } from '../../../utils/duration.js';
import { formatUtc } from '../../../utils/time.js';
import { monitorUrl, renderEmail, subjectLine, type EmailRow } from './layout.js';
import type { AffectedMonitor, BuiltEmail, EmailContext, EmailMonitor } from './types.js';

export interface RecoveredInput {
  monitor: EmailMonitor;
  openedAt: Date;
  recoveredAt: Date;
  downtimeMs: number;
  /** For example "last document 2 min old" or "responded in 120 ms". */
  currentState?: string;
}

export function buildRecovered(input: RecoveredInput, ctx: EmailContext): BuiltEmail {
  const { monitor } = input;
  const rows: EmailRow[] = [
    { label: 'Monitor', value: monitor.name },
    { label: 'Problem started', value: formatUtc(input.openedAt, ctx.timeZone) },
    { label: 'Recovered at', value: formatUtc(input.recoveredAt, ctx.timeZone) },
    { label: 'Downtime', value: formatHumanDuration(input.downtimeMs) },
    ...(input.currentState ? [{ label: 'Now', value: input.currentState }] : []),
  ];
  const { text, html } = renderEmail({
    heading: 'Recovered',
    rows,
    links: [{ label: 'Open the monitor', url: monitorUrl(ctx, monitor) }],
  });
  return { subject: subjectLine('RECOVERED', monitor.name), text, html };
}

export interface RecoveredSourceInput {
  openedAt: Date;
  recoveredAt: Date;
  downtimeMs: number;
  affected: AffectedMonitor[];
}

/** The source database answers again (FR-A4a). Masters only. */
export function buildRecoveredSource(input: RecoveredSourceInput, ctx: EmailContext): BuiltEmail {
  const rows: EmailRow[] = [
    { label: 'Outage started', value: formatUtc(input.openedAt, ctx.timeZone) },
    { label: 'Recovered at', value: formatUtc(input.recoveredAt, ctx.timeZone) },
    { label: 'Downtime', value: formatHumanDuration(input.downtimeMs) },
    { label: 'Affected monitors', value: String(input.affected.length) },
    ...input.affected.map((m) => ({ label: '•', value: m.name })),
  ];
  const { text, html } = renderEmail({
    heading: 'The source database is reachable again',
    rows,
    links: input.affected.map((m) => ({ label: `Open ${m.name}`, url: monitorUrl(ctx, m) })),
  });
  return { subject: subjectLine('RECOVERED', 'Source DB'), text, html };
}
