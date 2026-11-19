import { ObjectId } from 'mongodb';
import {
  toWebhookMonitor,
  toWebhookMonitorDoc,
  toWebhookMonitorUpdate,
} from '../../../src/modules/webhookMonitors/webhookMonitors.mapper.js';
import type { WebhookMonitorInput } from '../../../src/modules/webhookMonitors/webhookMonitors.types.js';

const now = new Date('2026-11-18T10:00:00Z');
const userId = new ObjectId();
const ctx = { now, userId, daysPerMonth: 30 };
const input: WebhookMonitorInput = {
  name: 'Razorpay webhooks',
  gatewayName: 'Razorpay',
  sourceCollection: 'razor_pay_webhook_data',
  timestampKey: 'dCreatedAt',
  checkInterval: { value: 10, unit: 'MINUTE' },
  threshold: { value: 1, unit: 'MONTH' },
  alertMode: 'REPEAT_EVERY',
  repeatInterval: { value: 30, unit: 'MINUTE' },
  isEnabled: true,
};

describe('webhookMonitors.mapper (TD-16)', () => {
  it('round-trips every field: input -> doc -> domain', () => {
    const doc = { ...toWebhookMonitorDoc(input, { ...ctx, hasIndex: true }), _id: new ObjectId() };
    expect(doc).toMatchObject({
      sName: 'Razorpay webhooks',
      sGatewayName: 'Razorpay',
      sSourceCollection: 'razor_pay_webhook_data',
      sTimestampKey: 'dCreatedAt',
      oCheckInterval: { nValue: 10, eUnit: 'MINUTE', nMs: 600_000 },
      oThreshold: { nValue: 1, eUnit: 'MONTH', nMs: 30 * 86_400_000 },
      eAlertMode: 'REPEAT_EVERY',
      oRepeatInterval: { nValue: 30, eUnit: 'MINUTE', nMs: 1_800_000 },
      bIsEnabled: true,
      bHasDescIndexAtSave: true,
      dDeletedAt: null,
      iCreatedBy: userId,
      iUpdatedBy: userId,
      dCreatedAt: now,
      dUpdatedAt: now,
    });
    expect(toWebhookMonitor(doc)).toMatchObject({
      id: doc._id.toHexString(),
      name: 'Razorpay webhooks',
      gatewayName: 'Razorpay',
      sourceCollection: 'razor_pay_webhook_data',
      timestampKey: 'dCreatedAt',
      checkInterval: { value: 10, unit: 'MINUTE', ms: 600_000 },
      threshold: { value: 1, unit: 'MONTH', ms: 30 * 86_400_000 },
      alertMode: 'REPEAT_EVERY',
      repeatInterval: { value: 30, unit: 'MINUTE', ms: 1_800_000 },
      isEnabled: true,
      hasTimestampIndexAtSave: true,
      createdBy: userId.toHexString(),
    });
  });

  it('stores TD-08 milliseconds with the DAYS_PER_MONTH in force at save time', () => {
    const doc = toWebhookMonitorDoc(input, { ...ctx, daysPerMonth: 31, hasIndex: false });
    expect(doc.oThreshold.nMs).toBe(31 * 86_400_000);
  });

  it('stores an explicit null dDeletedAt and an empty initial state', () => {
    const doc = toWebhookMonitorDoc(input, { ...ctx, hasIndex: false });
    expect(doc.dDeletedAt).toBeNull();
    expect(doc.oState).toEqual({
      eLastResult: null,
      eCurrentStatus: null,
      dLastCheckAt: null,
      dNextCheckAt: null,
      iLastCheckId: null,
      iOpenIncidentId: null,
      nLastAgeMs: null,
      nLastResponseTimeMs: null,
    });
  });

  it('omits oRepeatInterval unless the mode is REPEAT_EVERY', () => {
    const doc = toWebhookMonitorDoc({ ...input, alertMode: 'EVERY_CHECK' }, { ...ctx, hasIndex: false });
    expect('oRepeatInterval' in doc).toBe(false);
    expect(toWebhookMonitor({ ...doc, _id: new ObjectId() }).repeatInterval).toBeUndefined();
  });

  it('maps an old document without optional fields or oState parts', () => {
    const doc = {
      ...toWebhookMonitorDoc({ ...input, alertMode: 'ONCE_WITH_RECOVERY' }, { ...ctx, hasIndex: true }),
      _id: new ObjectId(),
    };
    const old = { ...doc, oState: { eLastResult: 'OK' as const } } as unknown as Parameters<
      typeof toWebhookMonitor
    >[0];
    expect(toWebhookMonitor(old).state).toMatchObject({
      lastResult: 'OK',
      nextCheckAt: null,
      lastAgeMs: null,
      openIncidentId: null,
    });
  });

  describe('update', () => {
    it('never touches oState, dCreatedAt or dDeletedAt', () => {
      const update = toWebhookMonitorUpdate(input, ctx);
      for (const forbidden of ['oState', 'dCreatedAt', 'dDeletedAt', 'iCreatedBy']) {
        expect(forbidden in update.$set).toBe(false);
      }
      expect(update.$set).toMatchObject({
        iUpdatedBy: userId,
        dUpdatedAt: now,
        oRepeatInterval: { nValue: 30 },
      });
      expect(update.$unset).toBeUndefined();
    });
    it('unsets oRepeatInterval when the mode is not REPEAT_EVERY', () => {
      const update = toWebhookMonitorUpdate(
        { ...input, alertMode: 'ONCE_WITH_RECOVERY', repeatInterval: undefined },
        ctx,
      );
      expect('oRepeatInterval' in update.$set).toBe(false);
      expect(update.$unset).toEqual({ oRepeatInterval: '' });
    });
    it('sets the index flag only when it was re-inspected', () => {
      expect('bHasDescIndexAtSave' in toWebhookMonitorUpdate(input, ctx).$set).toBe(false);
      expect(toWebhookMonitorUpdate(input, { ...ctx, hasIndex: false }).$set.bHasDescIndexAtSave).toBe(false);
    });
  });
});
