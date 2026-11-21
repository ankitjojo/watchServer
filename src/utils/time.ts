/** "2026-11-18 19:35:09 IST". Storage and logic stay UTC; only display uses the zone. Every time shown carries its label (FR-D7). */
export function formatUtc(date: Date, timeZone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${zoneLabel(timeZone)}`;
}

function zonePart(timeZone: string, locale: string, name: 'short' | 'longOffset', at: Date): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: name }).formatToParts(at);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}

/** Short zone name people know: "IST" for Asia/Kolkata, "UTC" for UTC (en-IN gives IST; other zones fall back to GMT+x). */
export function zoneLabel(timeZone: string): string {
  return zonePart(timeZone, 'en-IN', 'short', new Date());
}

/** "+05:30" / "Z": the zone's UTC offset at `at`, as an ISO-8601 suffix. */
export function zoneOffset(timeZone: string, at: Date): string {
  const raw = zonePart(timeZone, 'en-US', 'longOffset', at).replace('GMT', '');
  return raw === '' || raw === '+00:00' ? 'Z' : raw;
}

/** The whole local day `YYYY-MM-DD` in `timeZone`, as UTC instants (day filters mean display-zone days). */
export function dayBounds(day: string, timeZone: string): { start: Date; end: Date } {
  const offset = zoneOffset(timeZone, new Date(`${day}T12:00:00Z`));
  return { start: new Date(`${day}T00:00:00.000${offset}`), end: new Date(`${day}T23:59:59.999${offset}`) };
}
