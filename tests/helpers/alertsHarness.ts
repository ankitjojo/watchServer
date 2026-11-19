import { ObjectId } from 'mongodb';
import type { MonitorSnapshot } from '../../src/modules/alerts/alerts.port.js';
import type { Check } from '../../src/modules/checks/checks.types.js';
import type { CheckResult } from '../../src/constants/checkResult.js';
import { createFakeMailer, type FakeMailer } from './fakeMailer.js';
import { FakeClock } from './fakeClock.js';
import type { TestMongo } from './memoryMongo.js';
import { startTestApp, type TestApp } from './testApp.js';

export const MIN = 60_000;
export const HOUR = 3_600_000;

export interface AlertsHarness {
  t: TestApp;
  clock: FakeClock;
  mailer: FakeMailer;
  actor: { id: string; email: string };
}

/** A real app on a memory MongoDB with a fake clock and a fake mailer, and three recipients seeded. */
export async function startAlertsHarness(
  mongo: TestMongo,
  options: { config?: Record<string, string>; recipients?: boolean } = {},
): Promise<AlertsHarness> {
  const clock = new FakeClock('2026-11-18T12:00:00.000Z');
  const mailer = createFakeMailer();
  const t = await startTestApp({
    mongo,
    clock,
    mailer,
    ...(options.config ? { config: options.config } : {}),
  });
  const admin = (await t.services.users.list()).find((u) => u.role === 'ADMIN');
  const actor = { id: admin?.id ?? '', email: admin?.email ?? '' };
  if (options.recipients !== false) {
    const { recipients } = t.services;
    await recipients.create({ name: 'Master', email: 'master@x.test', type: 'MASTER', isActive: true });
    await recipients.create({ name: 'Ops', email: 'ops@x.test', type: 'NORMAL', isActive: true });
    await recipients.create({ name: 'Off', email: 'off@x.test', type: 'NORMAL', isActive: false });
  }
  return { t, clock, mailer, actor };
}

export function webhookSnapshot(over: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    monitorType: 'WEBHOOK',
    monitorId: new ObjectId().toHexString(),
    name: 'Razorpay webhooks',
    gatewayName: 'Razorpay',
    sourceCollection: 'razor_pay_webhook_data',
    timestampKey: 'dCreatedAt',
    thresholdMs: 2 * HOUR,
    checkIntervalMs: 10 * MIN,
    alertMode: 'ONCE_WITH_RECOVERY',
    ...over,
  };
}

export function endpointSnapshot(over: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    monitorType: 'ENDPOINT',
    monitorId: new ObjectId().toHexString(),
    name: 'Subscription API – prod',
    url: 'https://api.example.com/health?token=***',
    checkIntervalMs: 5 * MIN,
    alertMode: 'ONCE_WITH_RECOVERY',
    ...over,
  };
}

export function makeCheck(
  monitor: MonitorSnapshot,
  result: CheckResult,
  clock: FakeClock,
  extra: Partial<Check> = {},
): Check {
  const at = clock.now();
  const base: Check = {
    id: new ObjectId().toHexString(),
    monitorId: monitor.monitorId,
    monitorType: monitor.monitorType,
    trigger: 'SCHEDULE',
    startedAt: at,
    finishedAt: at,
    result,
  };
  if (monitor.monitorType === 'WEBHOOK') {
    if (result === 'STALE') {
      base.webhook = {
        thresholdMs: monitor.thresholdMs ?? 0,
        lastDocId: new ObjectId().toHexString(),
        lastDocTimestamp: new Date(at.getTime() - 3 * HOUR),
        ageMs: 3 * HOUR,
      };
    } else if (result === 'OK') {
      base.webhook = {
        thresholdMs: monitor.thresholdMs ?? 0,
        lastDocId: new ObjectId().toHexString(),
        lastDocTimestamp: new Date(at.getTime() - 2 * MIN),
        ageMs: 2 * MIN,
      };
    } else if (result === 'NO_DATA') {
      base.webhook = { thresholdMs: monitor.thresholdMs ?? 0, reason: 'EMPTY_COLLECTION' };
    } else {
      base.webhook = { thresholdMs: monitor.thresholdMs ?? 0 };
      base.error = {
        code: 'SOURCE_UNAVAILABLE',
        message: 'The source database could not read the latest document',
      };
    }
  } else {
    base.endpoint =
      result === 'OK'
        ? { attempts: [{ attempt: 1, statusCode: 200, responseTimeMs: 120 }] }
        : {
            attempts: [
              { attempt: 1, statusCode: 500, responseTimeMs: 200 },
              {
                attempt: 2,
                responseTimeMs: 10_000,
                errorCode: 'TIMEOUT',
                errorMessage: 'The request timed out',
              },
              { attempt: 3, statusCode: 502, responseTimeMs: 80 },
            ],
          };
  }
  return { ...base, ...extra };
}
