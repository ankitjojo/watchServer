import { ObjectId } from 'mongodb';
import { toCheck, toCheckDoc } from '../../../src/modules/checks/checks.mapper.js';
import type { RecordCheckInput } from '../../../src/modules/checks/checks.types.js';

const now = new Date('2026-11-18T10:00:01Z');
const monitorId = new ObjectId().toHexString();
const base = {
  monitorId,
  trigger: 'SCHEDULE' as const,
  startedAt: new Date('2026-11-18T10:00:00Z'),
  finishedAt: now,
};

describe('checks.mapper (TD-16)', () => {
  it('round-trips a webhook check with every detail', () => {
    const input: RecordCheckInput = {
      ...base,
      monitorType: 'WEBHOOK',
      result: 'STALE',
      webhook: {
        thresholdMs: 7_200_000,
        lastDocId: new ObjectId().toHexString(),
        lastDocTimestamp: new Date('2026-11-18T06:00:00Z'),
        ageMs: 14_400_000,
      },
    };
    const doc = { ...toCheckDoc(input, { now }), _id: new ObjectId() };
    expect(doc).toMatchObject({
      eMonitorType: 'WEBHOOK',
      eTrigger: 'SCHEDULE',
      eResult: 'STALE',
      oWebhook: { nThresholdMs: 7_200_000, nAgeMs: 14_400_000 },
      dCreatedAt: now,
    });
    expect(doc.iMonitorId.toHexString()).toBe(monitorId);
    expect(doc.oWebhook?.iLastDocId).toBeInstanceOf(ObjectId);
    expect(toCheck(doc)).toEqual({ id: doc._id.toHexString(), ...input });
  });

  it('keeps a non-ObjectId source _id as text', () => {
    const input: RecordCheckInput = {
      ...base,
      monitorType: 'WEBHOOK',
      result: 'OK',
      webhook: { thresholdMs: 1, lastDocId: 'order-123', ageMs: 5 },
    };
    const doc = { ...toCheckDoc(input, { now }), _id: new ObjectId() };
    expect(doc.oWebhook?.iLastDocId).toBe('order-123');
    expect(toCheck(doc).webhook?.lastDocId).toBe('order-123');
  });

  it('round-trips endpoint attempts including errors', () => {
    const input: RecordCheckInput = {
      ...base,
      monitorType: 'ENDPOINT',
      trigger: 'MANUAL',
      result: 'DOWN',
      endpoint: {
        attempts: [
          { attempt: 1, statusCode: 500, responseTimeMs: 120 },
          { attempt: 2, responseTimeMs: 10_000, errorCode: 'TIMEOUT', errorMessage: 'The request timed out' },
        ],
      },
    };
    const doc = { ...toCheckDoc(input, { now }), _id: new ObjectId() };
    expect(doc.oEndpoint?.aAttempts[1]).toEqual({
      nAttempt: 2,
      nResponseTimeMs: 10_000,
      sErrorCode: 'TIMEOUT',
      sErrorMessage: 'The request timed out',
    });
    expect(toCheck(doc)).toEqual({ id: doc._id.toHexString(), ...input });
  });

  it('round-trips an ERROR check with its safe error', () => {
    const input: RecordCheckInput = {
      ...base,
      monitorType: 'WEBHOOK',
      result: 'ERROR',
      webhook: { thresholdMs: 1 },
      error: {
        code: 'SOURCE_UNAVAILABLE',
        message: 'The source database could not read the latest document',
      },
    };
    const doc = { ...toCheckDoc(input, { now }), _id: new ObjectId() };
    expect(doc.oError).toEqual({
      sCode: 'SOURCE_UNAVAILABLE',
      sMessage: 'The source database could not read the latest document',
    });
    expect(toCheck(doc)).toEqual({ id: doc._id.toHexString(), ...input });
  });

  it('omits optional parts that were not recorded', () => {
    const doc = toCheckDoc(
      { ...base, monitorType: 'ENDPOINT', result: 'OK', endpoint: { attempts: [] } },
      { now },
    );
    for (const key of ['oWebhook', 'oError']) expect(key in doc).toBe(false);
  });
});
