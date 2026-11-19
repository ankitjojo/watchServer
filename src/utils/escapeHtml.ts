const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes a value for use in HTML text or attributes (email templates). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);
}
