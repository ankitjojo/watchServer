import { createWebhookMonitorBody } from '../../../src/modules/webhookMonitors/webhookMonitors.schemas.js';

const schema = createWebhookMonitorBody({
  daysPerMonth: 30,
  minCheckIntervalMs: 60_000,
  maxCheckIntervalMs: 86_400_000,
});

const valid = {
  name: 'Razorpay webhooks',
  gatewayName: 'Razorpay',
  sourceCollection: 'razor_pay_webhook_data',
  timestampKey: 'dCreatedAt',
  checkInterval: { value: '10', unit: 'MINUTE' },
  threshold: { value: '2', unit: 'HOUR' },
  alertMode: 'ONCE_WITH_RECOVERY',
  repeatInterval: { value: '', unit: 'MINUTE' },
  isEnabled: 'on',
};

function issues(body: unknown): { path: string; message: string }[] {
  const result = schema.safeParse(body);
  return result.success
    ? []
    : result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

describe('webhook monitor body (FR-W1)', () => {
  it('parses a form post: numbers coerced, blank repeat dropped, checkbox read', () => {
    expect(schema.parse(valid)).toEqual({
      name: 'Razorpay webhooks',
      gatewayName: 'Razorpay',
      sourceCollection: 'razor_pay_webhook_data',
      timestampKey: 'dCreatedAt',
      checkInterval: { value: 10, unit: 'MINUTE' },
      threshold: { value: 2, unit: 'HOUR' },
      alertMode: 'ONCE_WITH_RECOVERY',
      repeatInterval: undefined,
      isEnabled: true,
    });
  });

  it('treats an omitted checkbox as disabled', () => {
    const rest: Partial<typeof valid> = { ...valid };
    delete rest.isEnabled;
    expect(schema.parse(rest).isEnabled).toBe(false);
  });

  describe('units per field', () => {
    it('check interval accepts only minute and hour', () => {
      expect(issues({ ...valid, checkInterval: { value: '1', unit: 'DAY' } }).map((i) => i.path)).toContain(
        'checkInterval.unit',
      );
    });
    it('threshold accepts minute..month', () => {
      for (const unit of ['MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH']) {
        expect(issues({ ...valid, threshold: { value: '1', unit } })).toEqual([]);
      }
      expect(issues({ ...valid, threshold: { value: '1', unit: 'YEAR' } }).map((i) => i.path)).toContain(
        'threshold.unit',
      );
    });
  });

  describe('minimum check interval', () => {
    it('rejects less than the configured minimum', () => {
      const strict = createWebhookMonitorBody({
        daysPerMonth: 30,
        minCheckIntervalMs: 300_000,
        maxCheckIntervalMs: 86_400_000,
      });
      const result = strict.safeParse({ ...valid, checkInterval: { value: '4', unit: 'MINUTE' } });
      expect(result.success).toBe(false);
      expect(strict.safeParse({ ...valid, checkInterval: { value: '5', unit: 'MINUTE' } }).success).toBe(
        true,
      );
    });
    it('accepts exactly 1 minute with the default minimum', () => {
      expect(issues({ ...valid, checkInterval: { value: '1', unit: 'MINUTE' } })).toEqual([]);
    });
  });

  describe('maximum check interval (review H1: 24 hours)', () => {
    it('accepts exactly 24 hours and 1440 minutes', () => {
      expect(issues({ ...valid, checkInterval: { value: '24', unit: 'HOUR' } })).toEqual([]);
      expect(issues({ ...valid, checkInterval: { value: '1440', unit: 'MINUTE' } })).toEqual([]);
    });
    it('rejects anything longer, e.g. 25 hours, 1441 minutes or 1000 hours', () => {
      for (const checkInterval of [
        { value: '25', unit: 'HOUR' },
        { value: '1441', unit: 'MINUTE' },
        { value: '1000', unit: 'HOUR' },
      ]) {
        expect(issues({ ...valid, checkInterval }).map((i) => i.path)).toContain('checkInterval.value');
      }
    });
  });

  describe('repeat interval rules', () => {
    const repeat = { ...valid, alertMode: 'REPEAT_EVERY' };
    it('is required for REPEAT_EVERY', () => {
      expect(issues(repeat).map((i) => i.path)).toContain('repeatInterval.value');
    });
    it('must not be shorter than the check interval', () => {
      expect(
        issues({ ...repeat, repeatInterval: { value: '5', unit: 'MINUTE' } }).map((i) => i.path),
      ).toContain('repeatInterval.value');
      expect(issues({ ...repeat, repeatInterval: { value: '10', unit: 'MINUTE' } })).toEqual([]);
      expect(issues({ ...repeat, repeatInterval: { value: '30', unit: 'MINUTE' } })).toEqual([]);
    });
    it('compares in milliseconds across units', () => {
      expect(
        issues({
          ...repeat,
          checkInterval: { value: '2', unit: 'HOUR' },
          repeatInterval: { value: '90', unit: 'MINUTE' },
        }).length,
      ).toBe(1);
      expect(
        issues({
          ...repeat,
          checkInterval: { value: '2', unit: 'HOUR' },
          repeatInterval: { value: '1', unit: 'DAY' },
        }),
      ).toEqual([]);
    });
    it('accepts only minute, hour and day units', () => {
      expect(issues({ ...repeat, repeatInterval: { value: '1', unit: 'WEEK' } }).length).toBeGreaterThan(0);
    });
    it('is dropped when the mode is not REPEAT_EVERY, even if filled in', () => {
      const parsed = schema.parse({
        ...valid,
        alertMode: 'EVERY_CHECK',
        repeatInterval: { value: '30', unit: 'MINUTE' },
      });
      expect(parsed.repeatInterval).toBeUndefined();
    });
    it('keeps a valid repeat interval for REPEAT_EVERY', () => {
      expect(
        schema.parse({ ...repeat, repeatInterval: { value: '30', unit: 'MINUTE' } }).repeatInterval,
      ).toEqual({ value: 30, unit: 'MINUTE' });
    });
  });

  describe('injection and bounds', () => {
    it.each(['$where', 'a..b', 'x'.repeat(65)])('rejects timestamp key %j', (timestampKey) => {
      expect(issues({ ...valid, timestampKey }).map((i) => i.path)).toContain('timestampKey');
    });
    it('rejects object values where strings are expected', () => {
      expect(issues({ ...valid, name: { $gt: '' } }).map((i) => i.path)).toContain('name');
      expect(issues({ ...valid, sourceCollection: { $ne: '' } }).map((i) => i.path)).toContain(
        'sourceCollection',
      );
    });
    it('rejects unknown fields (.strict)', () => {
      expect(schema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    });
    it.each([
      ['name', ''],
      ['name', 'x'.repeat(101)],
      ['gatewayName', ''],
      ['gatewayName', 'x'.repeat(61)],
    ])('bounds %s = %j', (field, value) => {
      expect(issues({ ...valid, [field]: value }).map((i) => i.path)).toContain(field);
    });
  });
});
