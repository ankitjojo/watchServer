import { ObjectId } from 'mongodb';
import {
  toEndpointMonitor,
  toEndpointMonitorDoc,
  toEndpointMonitorUpdate,
} from '../../../src/modules/endpointMonitors/endpointMonitors.mapper.js';
import type { EndpointMonitorInput } from '../../../src/modules/endpointMonitors/endpointMonitors.types.js';

const now = new Date('2026-11-18T10:00:00Z');
const userId = new ObjectId();
const ctx = { now, userId, daysPerMonth: 30 };
const input: EndpointMonitorInput = {
  serverName: 'API',
  url: 'https://api.example.com/health?token=abc',
  checkInterval: { value: 5, unit: 'MINUTE' },
  retryCount: 3,
  alertMode: 'REPEAT_EVERY',
  repeatInterval: { value: 1, unit: 'HOUR' },
  isEnabled: true,
};

describe('endpointMonitors.mapper (TD-16)', () => {
  it('round-trips every field: input -> doc -> domain', () => {
    const doc = { ...toEndpointMonitorDoc(input, ctx), _id: new ObjectId() };
    expect(doc).toMatchObject({
      sServerName: 'API',
      sUrl: 'https://api.example.com/health?token=abc',
      oCheckInterval: { nValue: 5, eUnit: 'MINUTE', nMs: 300_000 },
      nRetryCount: 3,
      eAlertMode: 'REPEAT_EVERY',
      oRepeatInterval: { nValue: 1, eUnit: 'HOUR', nMs: 3_600_000 },
      bIsEnabled: true,
      dDeletedAt: null,
      iCreatedBy: userId,
      dCreatedAt: now,
    });
    expect(toEndpointMonitor(doc)).toMatchObject({
      id: doc._id.toHexString(),
      serverName: 'API',
      url: 'https://api.example.com/health?token=abc',
      checkInterval: { value: 5, unit: 'MINUTE', ms: 300_000 },
      retryCount: 3,
      alertMode: 'REPEAT_EVERY',
      repeatInterval: { value: 1, unit: 'HOUR', ms: 3_600_000 },
      isEnabled: true,
    });
  });

  it('has no webhook-only fields', () => {
    const doc = toEndpointMonitorDoc(input, ctx);
    for (const key of [
      'sName',
      'sGatewayName',
      'sSourceCollection',
      'sTimestampKey',
      'bHasDescIndexAtSave',
    ]) {
      expect(key in doc).toBe(false);
    }
  });

  it('omits oRepeatInterval unless REPEAT_EVERY and tolerates old documents', () => {
    const doc = toEndpointMonitorDoc({ ...input, alertMode: 'EVERY_CHECK' }, ctx);
    expect('oRepeatInterval' in doc).toBe(false);
    const old = { ...doc, _id: new ObjectId(), oState: undefined } as unknown as Parameters<
      typeof toEndpointMonitor
    >[0];
    expect(toEndpointMonitor(old).state.lastResult).toBeNull();
  });

  it('update never touches oState, dCreatedAt or dDeletedAt, and unsets the repeat interval when not needed', () => {
    const update = toEndpointMonitorUpdate(
      { ...input, alertMode: 'EVERY_CHECK', repeatInterval: undefined },
      ctx,
    );
    for (const forbidden of ['oState', 'dCreatedAt', 'dDeletedAt', 'iCreatedBy']) {
      expect(forbidden in update.$set).toBe(false);
    }
    expect(update.$unset).toEqual({ oRepeatInterval: '' });
    expect(toEndpointMonitorUpdate(input, ctx).$unset).toBeUndefined();
  });
});
