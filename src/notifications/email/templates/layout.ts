import { escapeHtml } from '../../../utils/escapeHtml.js';
import type { EmailContext, EmailMonitor } from './types.js';

export interface EmailRow {
  label: string;
  value: string;
}

export interface EmailLink {
  label: string;
  url: string;
}

const MAX_SUBJECT_NAME = 150;

/** FR-A6: `[<APP_NAME>] <TYPE> – <name>`. Line breaks are removed so a name can never add headers. */
export function subjectLine(ctx: EmailContext, type: string, name: string): string {
  const clean = name
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_SUBJECT_NAME);
  return `[${ctx.appName}] ${type} – ${clean}`;
}

export function monitorUrl(ctx: EmailContext, monitor: Pick<EmailMonitor, 'type' | 'id'>): string {
  return `${ctx.dashboardBaseUrl}/${monitor.type === 'WEBHOOK' ? 'webhook' : 'endpoint'}-monitors/${monitor.id}`;
}

/** Plain text and HTML from the same rows. Every value is escaped in the HTML (security rules). */
export function renderEmail(
  ctx: EmailContext,
  parts: {
    heading: string;
    intro?: string;
    rows: EmailRow[];
    links?: EmailLink[];
  },
): { text: string; html: string } {
  const text = [
    parts.heading,
    '',
    ...(parts.intro ? [parts.intro, ''] : []),
    ...parts.rows.map((r) => `${r.label}: ${r.value}`),
    ...(parts.links ?? []).flatMap((l) => ['', `${l.label}: ${l.url}`]),
    '',
    `-- Sent by ${ctx.appName}`,
  ].join('\n');

  const rows = parts.rows
    .map(
      (r) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#5d6b7e;white-space:nowrap;vertical-align:top">${escapeHtml(r.label)}</td><td style="padding:4px 0">${escapeHtml(r.value)}</td></tr>`,
    )
    .join('');
  const links = (parts.links ?? [])
    .map((l) => `<p><a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a></p>`)
    .join('');
  const html = `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#1c2430"><h2 style="margin:0 0 12px">${escapeHtml(parts.heading)}</h2>${parts.intro ? `<p>${escapeHtml(parts.intro)}</p>` : ''}<table style="border-collapse:collapse">${rows}</table>${links}<p style="color:#5d6b7e;font-size:12px">Sent by ${escapeHtml(ctx.appName)}</p></body></html>`;
  return { text, html };
}
