import {
  buildAlertEmail,
  type AlertEmailSpec,
  type EmailContext,
  type EmailMonitor,
} from '../../../src/notifications/email/templates/index.js';

const ctx: EmailContext = {
  dashboardBaseUrl: 'https://monitor.example.com',
  timeZone: 'UTC',
  appName: 'payMonitor',
};
const MIN = 60_000;
const HOUR = 3_600_000;
const checkedAt = new Date('2026-11-18T14:05:09Z');

const webhook: EmailMonitor = {
  type: 'WEBHOOK',
  id: 'w'.repeat(24),
  name: 'Razorpay webhooks',
  gatewayName: 'Razorpay',
  collection: 'razor_pay_webhook_data',
  timestampKey: 'dCreatedAt',
  thresholdMs: 2 * HOUR,
  checkIntervalMs: 10 * MIN,
};
const endpoint: EmailMonitor = {
  type: 'ENDPOINT',
  id: 'e'.repeat(24),
  name: 'Subscription API – prod',
  url: 'https://api.example.com/health?token=***',
  checkIntervalMs: 5 * MIN,
};

const stale: AlertEmailSpec = {
  type: 'WEBHOOK_STALE',
  monitor: webhook,
  lastDocId: 'a1b2c3d4e5f6a1b2c3d4e5f6',
  lastDocTimestamp: new Date('2026-11-18T10:53:00Z'),
  ageMs: 3 * HOUR + 12 * MIN,
  checkedAt,
};

const build = (spec: AlertEmailSpec) => buildAlertEmail(spec, ctx);

describe('subjects (FR-A6)', () => {
  const cases: [AlertEmailSpec, string][] = [
    [stale, '[payMonitor] WEBHOOK_STALE – Razorpay webhooks'],
    [
      { type: 'WEBHOOK_NO_DATA', monitor: webhook, reason: 'EMPTY_COLLECTION', checkedAt },
      '[payMonitor] WEBHOOK_NO_DATA – Razorpay webhooks',
    ],
    [
      { type: 'ENDPOINT_DOWN', monitor: endpoint, attempts: [], checkedAt },
      '[payMonitor] ENDPOINT_DOWN – Subscription API – prod',
    ],
    [
      {
        type: 'RECOVERED',
        monitor: endpoint,
        openedAt: checkedAt,
        recoveredAt: checkedAt,
        downtimeMs: MIN,
      },
      '[payMonitor] RECOVERED – Subscription API – prod',
    ],
    [
      { type: 'TEST', monitor: webhook, requestedBy: 'a@x.test', at: checkedAt },
      '[payMonitor] TEST – Razorpay webhooks',
    ],
    [
      {
        type: 'MONITOR_ERROR',
        firstErrorAt: checkedAt,
        errorCode: 'SOURCE_UNAVAILABLE',
        errorMessage: 'x',
        affected: [
          { id: 'a', name: 'A', type: 'WEBHOOK' },
          { id: 'b', name: 'B', type: 'WEBHOOK' },
        ],
      },
      '[payMonitor] MONITOR_ERROR – Source DB (2 monitors)',
    ],
    [
      {
        type: 'RECOVERED_SOURCE',
        openedAt: checkedAt,
        recoveredAt: checkedAt,
        downtimeMs: MIN,
        affected: [],
      },
      '[payMonitor] RECOVERED – Source DB',
    ],
  ];
  it.each(cases)('%#', (spec, subject) => {
    expect(build(spec).subject).toBe(subject);
  });

  it('cannot be used to inject headers through a monitor name', () => {
    const built = build({
      ...stale,
      monitor: { ...webhook, name: 'Evil\r\nBcc: attacker@x.test' },
    });
    expect(built.subject).not.toMatch(/[\r\n]/);
  });
});

describe('WEBHOOK_STALE carries every FR-W4 field', () => {
  const { text, html } = build(stale);
  it.each([
    'Razorpay webhooks',
    'Razorpay',
    'razor_pay_webhook_data',
    'dCreatedAt',
    'a1b2c3d4e5f6a1b2c3d4e5f6',
    '2026-11-18 10:53:00 UTC',
    '3 h 12 min',
    '2 h',
    '10 min',
    '2026-11-18 14:05:09 UTC',
    'https://monitor.example.com/webhook-monitors/' + 'w'.repeat(24),
  ])('contains %s', (value) => {
    expect(text).toContain(value);
    expect(html).toContain(value);
  });
});

describe('ENDPOINT_DOWN carries every FR-E3 field', () => {
  const spec: AlertEmailSpec = {
    type: 'ENDPOINT_DOWN',
    monitor: endpoint,
    checkedAt,
    attempts: [
      { attempt: 1, statusCode: 500, responseTimeMs: 200 },
      { attempt: 2, responseTimeMs: 10_000, errorMessage: 'The request timed out' },
      { attempt: 3, statusCode: 502, responseTimeMs: 80 },
    ],
  };
  it('lists server, masked URL, time, attempts, last result and link', () => {
    const { text } = build(spec);
    for (const value of [
      'Subscription API – prod',
      'https://api.example.com/health?token=***',
      '2026-11-18 14:05:09 UTC',
      'Attempts: 3',
      'HTTP 502 (80 ms)',
      'The request timed out (10000 ms)',
      'https://monitor.example.com/endpoint-monitors/' + 'e'.repeat(24),
    ]) {
      expect(text).toContain(value);
    }
  });
});

describe('reminders (FR-A3)', () => {
  it('say how long the incident has been open and how many reminders came before', () => {
    const { text, subject } = build({
      ...stale,
      reminder: { number: 3, openForMs: 90 * MIN },
    });
    expect(text).toContain('Reminder: #3');
    expect(text).toContain('Incident open for: 1 h 30 min');
    expect(text).toContain('Earlier reminders: 2');
    expect(subject).toBe('[payMonitor] WEBHOOK_STALE – Razorpay webhooks');
  });
});

describe('RECOVERED', () => {
  it('shows the downtime', () => {
    const { text } = build({
      type: 'RECOVERED',
      monitor: webhook,
      openedAt: new Date('2026-11-18T12:00:00Z'),
      recoveredAt: checkedAt,
      downtimeMs: 2 * HOUR + 5 * MIN,
    });
    expect(text).toContain('Downtime: 2 h 5 min');
    expect(text).toContain('Recovered at: 2026-11-18 14:05:09 UTC');
  });
});

describe('MONITOR_ERROR', () => {
  it('lists every affected monitor with a link, and a safe error', () => {
    const { text } = build({
      type: 'MONITOR_ERROR',
      firstErrorAt: checkedAt,
      errorCode: 'SOURCE_TIMEOUT',
      errorMessage: 'The source database took too long',
      affected: [
        { id: 'a'.repeat(24), name: 'Razorpay', type: 'WEBHOOK' },
        { id: 'b'.repeat(24), name: 'Apple Pay', type: 'WEBHOOK' },
      ],
    });
    for (const value of [
      'Razorpay',
      'Apple Pay',
      'SOURCE_TIMEOUT',
      'Affected monitors: 2',
      'https://monitor.example.com/webhook-monitors/' + 'a'.repeat(24),
    ]) {
      expect(text).toContain(value);
    }
  });
});

describe("a monitor's own MONITOR_ERROR (TD-29)", () => {
  const own: AlertEmailSpec = {
    type: 'MONITOR_CHECK_ERROR',
    monitor: { ...webhook, name: 'Razorpay <b>webhooks</b>' },
    errorCode: 'SOURCE_COLLECTION_NOT_FOUND',
    errorMessage: 'The collection does not exist in the source database',
    checkedAt,
  };
  it('names the monitor in the subject and carries the collection, key, error, UTC time and link', () => {
    const mail = build(own);
    expect(mail.subject).toBe('[payMonitor] MONITOR_ERROR – Razorpay <b>webhooks</b>');
    for (const part of [
      'razor_pay_webhook_data',
      'dCreatedAt',
      'SOURCE_COLLECTION_NOT_FOUND: The collection does not exist in the source database',
      'UTC',
      `https://monitor.example.com/webhook-monitors/${webhook.id}`,
    ]) {
      expect(mail.text).toContain(part);
    }
    expect(mail.html).not.toContain('<b>webhooks</b>');
    expect(mail.html).toContain('&lt;b&gt;webhooks&lt;/b&gt;');
  });
  it('labels reminders', () => {
    expect(build({ ...own, reminder: { number: 2, openForMs: HOUR } }).text).toContain('Reminder #2');
  });
});

describe('product name from APP_NAME (plan app-name-from-env)', () => {
  const acme: EmailContext = { ...ctx, appName: 'Acme <Watch>' };
  const specs: [string, AlertEmailSpec][] = [
    ['WEBHOOK_STALE', stale],
    ['WEBHOOK_NO_DATA', { type: 'WEBHOOK_NO_DATA', monitor: webhook, reason: 'EMPTY_COLLECTION', checkedAt }],
    ['ENDPOINT_DOWN', { type: 'ENDPOINT_DOWN', monitor: endpoint, attempts: [], checkedAt }],
    [
      'RECOVERED',
      { type: 'RECOVERED', monitor: webhook, openedAt: checkedAt, recoveredAt: checkedAt, downtimeMs: HOUR },
    ],
    [
      'RECOVERED_SOURCE',
      {
        type: 'RECOVERED_SOURCE',
        openedAt: checkedAt,
        recoveredAt: checkedAt,
        downtimeMs: HOUR,
        affected: [],
      },
    ],
    [
      'MONITOR_ERROR',
      { type: 'MONITOR_ERROR', firstErrorAt: checkedAt, errorCode: 'X', errorMessage: 'y', affected: [] },
    ],
    [
      'MONITOR_CHECK_ERROR',
      { type: 'MONITOR_CHECK_ERROR', monitor: webhook, errorCode: 'X', errorMessage: 'y', checkedAt },
    ],
    ['TEST', { type: 'TEST', monitor: webhook, requestedBy: 'a@x.test', at: checkedAt }],
  ];

  it.each(specs)(
    '%s: subject prefix and both footers use the configured name, escaped in HTML',
    (_name, spec) => {
      const mail = buildAlertEmail(spec, acme);
      expect(mail.subject.startsWith('[Acme <Watch>] ')).toBe(true);
      expect(mail.text).toContain('-- Sent by Acme <Watch>');
      expect(mail.html).toContain('Sent by Acme &lt;Watch&gt;');
      expect(mail.html).not.toContain('<Watch>');
    },
  );

  it.each(specs)('%s: keeps no old name when renamed', (_name, spec) => {
    const mail = buildAlertEmail(spec, { ...ctx, appName: 'Acme' });
    expect(`${mail.subject}\n${mail.text}\n${mail.html}`).not.toContain('payMonitor');
  });

  it('the per-monitor error email says the configured name cannot tell what is arriving', () => {
    const mail = buildAlertEmail(
      { type: 'MONITOR_CHECK_ERROR', monitor: webhook, errorCode: 'X', errorMessage: 'y', checkedAt },
      { ...ctx, appName: 'Acme' },
    );
    expect(mail.text).toContain('so Acme cannot tell whether webhooks are arriving');
  });
});

describe('escaping and times', () => {
  const hostile = '<script>alert(1)</script>"&';
  it('escapes every value in the HTML', () => {
    const { html } = build({
      ...stale,
      monitor: { ...webhook, name: hostile, gatewayName: hostile, collection: hostile },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;');
  });

  it('escapes the endpoint URL and error text', () => {
    const { html } = build({
      type: 'ENDPOINT_DOWN',
      monitor: { ...endpoint, url: 'https://x.test/?a=<b>' },
      checkedAt,
      attempts: [{ attempt: 1, responseTimeMs: 1, errorMessage: '<img onerror=x>' }],
    });
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<img');
  });

  it('writes every time with the UTC label (FR-D7)', () => {
    const { text } = build(stale);
    const times = text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/g) ?? [];
    expect(times.length).toBeGreaterThanOrEqual(2);
    for (const time of times) expect(time.endsWith(' UTC')).toBe(true);
  });

  it('never prints a literal "undefined" or "null"', () => {
    for (const spec of [
      stale,
      { type: 'WEBHOOK_NO_DATA', monitor: webhook, reason: 'MISSING', checkedAt } as AlertEmailSpec,
    ]) {
      expect(build(spec).text).not.toMatch(/undefined|null/);
    }
  });
});

describe('IST display zone', () => {
  it('shows times in IST with no UTC label', () => {
    const { text, html } = buildAlertEmail(stale, { ...ctx, timeZone: 'Asia/Kolkata' });
    for (const body of [text, html]) {
      expect(body).toContain('2026-11-18 19:35:09 IST');
      expect(body).not.toContain('UTC');
    }
  });
});
