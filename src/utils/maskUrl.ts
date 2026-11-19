/** Removes credentials and fragment and replaces every query value with ***. Safe for logs and emails. */
export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '[invalid-url]';
  }
  const keys = [...new Set(url.searchParams.keys())];
  const query = keys.length > 0 ? `?${keys.map((k) => `${encodeURIComponent(k)}=***`).join('&')}` : '';
  return `${url.protocol}//${url.host}${url.pathname}${query}`;
}
