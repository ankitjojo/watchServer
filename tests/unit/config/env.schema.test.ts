import { ConfigError, loadConfig } from '../../../src/config/loadConfig.js';

const base: NodeJS.ProcessEnv = {
  MONGO_URI: 'mongodb://user:secret-pass@db.internal:27017',
  SOURCE_MONGO_URI: 'mongodb://reader:secret-pass@src.internal:27017',
  SOURCE_DB_NAME: 'source',
  MAIL_TRANSPORT: 'outbox',
  MAIL_FROM: 'payMonitor <alerts@example.com>',
  SESSION_SECRET: 'x'.repeat(32),
};

function issuesFor(env: NodeJS.ProcessEnv): { variable: string; message: string }[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies every documented default (requirements 5.1)', () => {
    const c = loadConfig(base);
    expect(c.endpoint).toEqual({
      timeoutMs: 10000,
      retryDelayMs: 5000,
      maxRedirects: 5,
      maxRetryCount: 5,
      defaultRetryCount: 2,
      downAfterChecks: 2,
    });
    expect(c.email.retryBackoffMs).toEqual([60_000, 300_000, 900_000]);
    expect(c.sourceDb.queryTimeoutMs).toBe(10000);
    expect(c.durations).toEqual({
      daysPerMonth: 30,
      minCheckIntervalMs: 60_000,
      maxCheckIntervalMs: 86_400_000,
    });
    expect(c.display.timeZone).toBe('Asia/Kolkata');
    expect(c.rateLimit.login).toEqual({ max: 5, windowMs: 900_000 });
    expect(c.alerts.sourceErrorGroupWindowMs).toBe(60000);
    expect(c.scheduler).toEqual({ leaseTtlMs: 45000, leaseRenewMs: 15000, concurrency: 5 });
  });

  it('changes behaviour from env without code changes (acceptance 8)', () => {
    const c = loadConfig({
      ...base,
      ENDPOINT_TIMEOUT_MS: '2500',
      EMAIL_RETRY_BACKOFF_MIN: '2',
      DAYS_PER_MONTH: '31',
    });
    expect(c.endpoint.timeoutMs).toBe(2500);
    expect(c.email.retryBackoffMs).toEqual([120_000]);
    expect(c.durations.daysPerMonth).toBe(31);
  });

  it('MAX_CHECK_INTERVAL_MIN: at most 1440 (24 h) and not below the minimum (review H1)', () => {
    expect(loadConfig({ ...base, MAX_CHECK_INTERVAL_MIN: '60' }).durations.maxCheckIntervalMs).toBe(
      3_600_000,
    );
    expect(issuesFor({ ...base, MAX_CHECK_INTERVAL_MIN: '1441' }).map((i) => i.variable)).toContain(
      'MAX_CHECK_INTERVAL_MIN',
    );
    expect(
      issuesFor({ ...base, MIN_CHECK_INTERVAL_MIN: '30', MAX_CHECK_INTERVAL_MIN: '10' }).map(
        (i) => i.variable,
      ),
    ).toContain('MAX_CHECK_INTERVAL_MIN');
  });

  it('refuses the outbox mail transport in production: alerts would show SENT with no email sent (review M5)', () => {
    expect(issuesFor({ ...base, NODE_ENV: 'production', MAIL_TRANSPORT: 'outbox' })).toContainEqual({
      variable: 'MAIL_TRANSPORT',
      message: 'must be smtp when NODE_ENV=production (outbox never sends email)',
    });
    expect(loadConfig({ ...base, NODE_ENV: 'development', MAIL_TRANSPORT: 'outbox' }).mail.transport).toBe(
      'outbox',
    );
  });

  it('derives the email send deadline (2 x SMTP_TIMEOUT_MS) and keeps it inside the claim lock (review M6)', () => {
    expect(loadConfig(base).alerts.sendTimeoutMs).toBe(30_000);
    expect(
      issuesFor({ ...base, SMTP_TIMEOUT_MS: '15000', DISPATCHER_LOCK_MS: '30000' }).map((i) => i.variable),
    ).toContain('DISPATCHER_LOCK_MS');
    expect(
      loadConfig({ ...base, SMTP_TIMEOUT_MS: '15000', DISPATCHER_LOCK_MS: '30001' }).alerts.dispatcherLockMs,
    ).toBe(30_001);
  });

  it('APP_NAME: defaults to payMonitor and accepts a custom product name', () => {
    expect(loadConfig(base).appName).toBe('payMonitor');
    expect(loadConfig({ ...base, APP_NAME: '  Acme Watch ' }).appName).toBe('Acme Watch');
  });

  it.each([
    ['blank after trimming', '   '],
    ['longer than 40 characters', 'x'.repeat(41)],
    ['containing a line break', 'Acme\nWatch'],
    ['containing a control character', 'Acme\u0007Watch'],
  ])('APP_NAME: rejects a value %s, naming the variable but never the value', (_label, value) => {
    const issues = issuesFor({ ...base, APP_NAME: value });
    expect(issues.map((i) => i.variable)).toContain('APP_NAME');
    expect(JSON.stringify(issues)).not.toContain(value.trim() || 'never-matches');
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ ...base, ENDPOINT_TIMEOUT_MS: '' }).endpoint.timeoutMs).toBe(10000);
  });

  it('parses LOGIN_RATE_LIMIT in hours', () => {
    expect(loadConfig({ ...base, LOGIN_RATE_LIMIT: '3 per 2 hour' }).rateLimit.login).toEqual({
      max: 3,
      windowMs: 7_200_000,
    });
  });

  it.each([
    ['EMAIL_RETRY_BACKOFF_MIN', 'abc-secret'],
    ['EMAIL_RETRY_BACKOFF_MIN', '1,0'],
    ['DAYS_PER_MONTH', '45'],
    ['ENDPOINT_TIMEOUT_MS', 'soon-secret'],
    ['TIMEZONE', 'Mars/Base-secret'],
    ['ENDPOINT_DOWN_AFTER_CHECKS', '0'],
    ['ENDPOINT_DOWN_AFTER_CHECKS', '11'],
    ['LOGIN_RATE_LIMIT', 'lots-secret'],
  ])('rejects invalid %s and names the variable without echoing the value', (name, value) => {
    const issues = issuesFor({ ...base, [name]: value });
    expect(issues.map((i) => i.variable)).toContain(name);
    expect(JSON.stringify(issues)).not.toContain('secret');
  });

  it('requires SMTP variables in smtp mode only', () => {
    const smtp = issuesFor({ ...base, MAIL_TRANSPORT: 'smtp' }).map((i) => i.variable);
    expect(smtp).toEqual(expect.arrayContaining(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']));
    expect(loadConfig(base).mail.smtp).toBeUndefined();
  });

  it('requires SESSION_SECRET of at least 32 characters', () => {
    expect(issuesFor({ ...base, SESSION_SECRET: 'short' }).map((i) => i.variable)).toContain(
      'SESSION_SECRET',
    );
    const withoutSecret = { ...base };
    delete withoutSecret.SESSION_SECRET;
    expect(issuesFor(withoutSecret).map((i) => i.variable)).toContain('SESSION_SECRET');
  });

  it('enforces cross-field rules', () => {
    expect(issuesFor({ ...base, ENDPOINT_DEFAULT_RETRY_COUNT: '9', ENDPOINT_MAX_RETRY_COUNT: '3' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ variable: 'ENDPOINT_DEFAULT_RETRY_COUNT' })]),
    );
    expect(issuesFor({ ...base, LEASE_TTL_MS: '30000', LEASE_RENEW_MS: '20000' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ variable: 'LEASE_RENEW_MS' })]),
    );
  });

  it('returns a deeply frozen object', () => {
    const c = loadConfig(base);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.endpoint)).toBe(true);
  });
});
