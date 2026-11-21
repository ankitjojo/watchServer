import { decodeCursor, encodeCursor } from '../../../src/utils/cursor.js';
import { escapeHtml } from '../../../src/utils/escapeHtml.js';
import { maskUrl } from '../../../src/utils/maskUrl.js';
import { dayBounds, formatUtc, zoneLabel } from '../../../src/utils/time.js';
import { uriHost } from '../../../src/utils/uriHost.js';
import { ValidationError } from '../../../src/errors/appError.js';

describe('escapeHtml', () => {
  it('escapes markup characters', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;',
    );
  });
});

describe('maskUrl', () => {
  it('masks query values and drops credentials and fragment', () => {
    expect(maskUrl('https://user:pw@api.example.com/health?token=abc&x=1#frag')).toBe(
      'https://api.example.com/health?token=***&x=***',
    );
  });
  it('keeps URLs without a query unchanged', () => {
    expect(maskUrl('http://localhost:4010/ok')).toBe('http://localhost:4010/ok');
  });
  it('does not echo invalid input', () => {
    expect(maskUrl('not a url secret')).toBe('[invalid-url]');
  });
});

describe('uriHost', () => {
  it('returns the host without credentials', () => {
    expect(uriHost('mongodb://user:pass@db.internal:27017/app?x=1')).toBe('db.internal:27017');
    expect(uriHost('mongodb+srv://cluster0.example.net/db')).toBe('cluster0.example.net');
    expect(uriHost('garbage')).toBe('unknown');
  });
});

describe('formatUtc', () => {
  it('formats with the UTC label (FR-D7)', () => {
    expect(formatUtc(new Date('2026-11-18T14:05:09Z'))).toBe('2026-11-18 14:05:09 UTC');
  });
  it('formats Asia/Kolkata as IST (UTC+05:30), rolling over the date', () => {
    expect(formatUtc(new Date('2026-11-18T14:05:09Z'), 'Asia/Kolkata')).toBe('2026-11-18 19:35:09 IST');
    expect(formatUtc(new Date('2026-11-18T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-19 00:30:00 IST');
  });
  it('labels zones', () => {
    expect(zoneLabel('Asia/Kolkata')).toBe('IST');
    expect(zoneLabel('UTC')).toBe('UTC');
  });
  it('renders midnight as 00, not 24', () => {
    expect(formatUtc(new Date('2026-11-18T00:00:00Z'))).toBe('2026-11-18 00:00:00 UTC');
  });
});

describe('cursor', () => {
  it('round-trips', () => {
    const cursor = { t: new Date('2026-11-18T10:00:00.000Z'), id: 'a'.repeat(24) };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });
  it.each(['', 'not-base64!!', Buffer.from('{"t":1}').toString('base64url')])(
    'rejects invalid cursor %j',
    (bad) => {
      expect(() => decodeCursor(bad)).toThrow(ValidationError);
    },
  );
});

describe('dayBounds', () => {
  it('is the whole IST day as UTC instants', () => {
    const { start, end } = dayBounds('2026-11-21', 'Asia/Kolkata');
    expect(start.toISOString()).toBe('2026-11-20T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-11-21T18:29:59.999Z');
  });
  it('is unchanged for UTC', () => {
    const { start, end } = dayBounds('2026-11-21', 'UTC');
    expect(start.toISOString()).toBe('2026-11-21T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-21T23:59:59.999Z');
  });
});
