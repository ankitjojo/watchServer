import { createEndpointMonitorBody } from '../../../src/modules/endpointMonitors/endpointMonitors.schemas.js';

const schema = createEndpointMonitorBody({
  daysPerMonth: 30,
  minCheckIntervalMs: 60_000,
  maxCheckIntervalMs: 86_400_000,
  maxRetryCount: 5,
});

const valid = {
  serverName: 'Subscription API – prod',
  url: 'https://api.example.com/health',
  checkInterval: { value: '5', unit: 'MINUTE' },
  retryCount: '2',
  alertMode: 'ONCE_WITH_RECOVERY',
  repeatInterval: { value: '', unit: 'MINUTE' },
  isEnabled: 'on',
};

function paths(body: unknown): string[] {
  const result = schema.safeParse(body);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}

describe('endpoint monitor body (FR-E1)', () => {
  it('parses a form post', () => {
    expect(schema.parse(valid)).toEqual({
      serverName: 'Subscription API – prod',
      url: 'https://api.example.com/health',
      checkInterval: { value: 5, unit: 'MINUTE' },
      retryCount: 2,
      alertMode: 'ONCE_WITH_RECOVERY',
      repeatInterval: undefined,
      isEnabled: true,
    });
  });

  describe('URL', () => {
    it.each(['http://localhost:4010/ok', 'https://10.0.0.5:8443/a/b?token=x', 'http://api.internal/health'])(
      'accepts %s',
      (url) => {
        expect(paths({ ...valid, url })).toEqual([]);
      },
    );
    it.each([
      'ftp://example.com/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:pw@example.com/x',
      'https://user@example.com/x',
      'not a url',
      '',
      'http://',
      `https://example.com/${'a'.repeat(2050)}`,
    ])('rejects %j', (url) => {
      expect(paths({ ...valid, url })).toContain('url');
    });
    it('rejects an object where a string is expected', () => {
      expect(paths({ ...valid, url: { $ne: '' } })).toContain('url');
    });
  });

  describe('retry count', () => {
    it.each(['0', '1', '5'])('accepts %s', (retryCount) => {
      expect(paths({ ...valid, retryCount })).toEqual([]);
    });
    it.each(['-1', '6', '1.5', 'abc', ''])('rejects %j', (retryCount) => {
      expect(paths({ ...valid, retryCount })).toContain('retryCount');
    });
    it('uses the configured maximum', () => {
      const wide = createEndpointMonitorBody({
        daysPerMonth: 30,
        minCheckIntervalMs: 60_000,
        maxCheckIntervalMs: 86_400_000,
        maxRetryCount: 8,
      });
      expect(wide.safeParse({ ...valid, retryCount: '8' }).success).toBe(true);
      expect(wide.safeParse({ ...valid, retryCount: '9' }).success).toBe(false);
    });
  });

  describe('intervals', () => {
    it('allows only minute and hour for the check interval, minimum 1 minute', () => {
      expect(paths({ ...valid, checkInterval: { value: '1', unit: 'DAY' } })).toContain('checkInterval.unit');
      expect(paths({ ...valid, checkInterval: { value: '1', unit: 'MINUTE' } })).toEqual([]);
    });
    it('allows at most 24 hours for the check interval (review H1)', () => {
      expect(paths({ ...valid, checkInterval: { value: '24', unit: 'HOUR' } })).toEqual([]);
      expect(paths({ ...valid, checkInterval: { value: '25', unit: 'HOUR' } })).toContain(
        'checkInterval.value',
      );
    });
    it('requires a repeat interval for REPEAT_EVERY, not shorter than the check interval', () => {
      const repeat = { ...valid, alertMode: 'REPEAT_EVERY' };
      expect(paths(repeat)).toContain('repeatInterval.value');
      expect(paths({ ...repeat, repeatInterval: { value: '4', unit: 'MINUTE' } })).toContain(
        'repeatInterval.value',
      );
      expect(paths({ ...repeat, repeatInterval: { value: '5', unit: 'MINUTE' } })).toEqual([]);
    });
    it('drops the repeat interval for other modes', () => {
      expect(
        schema.parse({ ...valid, alertMode: 'EVERY_CHECK', repeatInterval: { value: '9', unit: 'HOUR' } })
          .repeatInterval,
      ).toBeUndefined();
    });
  });

  it('rejects unknown fields and out-of-bounds names', () => {
    expect(schema.safeParse({ ...valid, headers: 'x' }).success).toBe(false);
    expect(paths({ ...valid, serverName: '' })).toContain('serverName');
    expect(paths({ ...valid, serverName: 'x'.repeat(101) })).toContain('serverName');
  });
});
