import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { createAlertDispatcher } from '../../../src/modules/alerts/alerts.dispatcher.js';
import { createAlertsRepository } from '../../../src/modules/alerts/alerts.repository.js';
import { createLogger } from '../../../src/logger/index.js';
import { MIN, startAlertsHarness, webhookSnapshot, type AlertsHarness } from '../../helpers/alertsHarness.js';
import { createFakeMailer } from '../../helpers/fakeMailer.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo();
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

const stored = (h: AlertsHarness, id: string) =>
  h.t.db.collection(COLLECTIONS.ALERTS).findOne({ _id: new ObjectId(id) });
const queue = (h: AlertsHarness) => h.t.services.alerts.sendTestEmail(webhookSnapshot(), h.actor);

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('store first, then send (FR-A1)', () => {
  it('the alert is already stored as PENDING, with the exact rendered email, when the mailer is called', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await queue(h);
    let seenInDb: Record<string, unknown> | null = null;
    h.mailer.beforeSend = async (message) => {
      seenInDb = await stored(h, alert.id);
      expect(message.subject).toBe(seenInDb?.['sSubject']);
      expect(message.text).toBe(seenInDb?.['sTextBody']);
      expect(message.html).toBe(seenInDb?.['sHtmlBody']);
    };
    await h.t.services.dispatcher.runOnce();
    expect(seenInDb).toMatchObject({ eStatus: 'PENDING' });
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('marks SENT only after the mail server accepted it, with time, message id and the attempt', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await queue(h);
    await h.t.services.dispatcher.runOnce();
    expect(await stored(h, alert.id)).toMatchObject({
      eStatus: 'SENT',
      sMessageId: '<fake-1@test>',
      dSentAt: h.clock.now(),
      dNextAttemptAt: null,
      dLockedUntil: null,
      aAttempts: [{ dAt: h.clock.now(), bIsSuccess: true }],
    });
  });

  it('sends one email to all stored recipients', async () => {
    const h = await startAlertsHarness(mongo);
    await queue(h);
    await h.t.services.dispatcher.runOnce();
    expect(h.mailer.sent[0]?.to.sort()).toEqual(['master@x.test', 'ops@x.test']);
  });

  it('a failing alert (no recipients) is never sent', async () => {
    const h = await startAlertsHarness(mongo, { recipients: false });
    const monitor = webhookSnapshot();
    await h.t.services.alerts.sendTestEmail(monitor, h.actor);
    await h.t.services.dispatcher.runOnce();
    expect(h.mailer.attempts).toBe(0);
  });
});

describe('retry and backoff (acceptance 9, FR-A2)', () => {
  it('PENDING -> RETRYING -> RETRYING -> SENT following the default backoff 1, 5 minutes', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await queue(h);
    h.mailer.failNext = 2;

    await h.t.services.dispatcher.runOnce();
    expect(await stored(h, alert.id)).toMatchObject({
      eStatus: 'RETRYING',
      nRetryIndex: 1,
      dNextAttemptAt: new Date(h.clock.now().getTime() + 1 * MIN),
    });

    // Not due yet: nothing happens.
    expect(await h.t.services.dispatcher.runOnce()).toBe(0);
    expect(h.mailer.attempts).toBe(1);

    h.clock.advance(1 * MIN);
    await h.t.services.dispatcher.runOnce();
    expect(await stored(h, alert.id)).toMatchObject({
      eStatus: 'RETRYING',
      nRetryIndex: 2,
      dNextAttemptAt: new Date(h.clock.now().getTime() + 5 * MIN),
    });

    h.clock.advance(5 * MIN);
    await h.t.services.dispatcher.runOnce();
    const final = await stored(h, alert.id);
    expect(final).toMatchObject({ eStatus: 'SENT' });
    const attempts = final?.['aAttempts'] as { bIsSuccess: boolean; sErrorCode?: string }[];
    expect(attempts.map((a) => a.bIsSuccess)).toEqual([false, false, true]);
    expect(attempts[0]?.sErrorCode).toBe('SMTP_UNREACHABLE');
  });

  it('becomes FAILED after backoff.length + 1 attempts, keeping a safe error text', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await queue(h);
    h.mailer.failAlways = true;
    for (const wait of [0, 1, 5, 15]) {
      h.clock.advance(wait * MIN);
      await h.t.services.dispatcher.runOnce();
    }
    expect(h.mailer.attempts).toBe(4);
    const failed = await stored(h, alert.id);
    expect(failed).toMatchObject({
      eStatus: 'FAILED',
      sFailureReason: 'The mail server could not be reached',
      dNextAttemptAt: null,
      dLockedUntil: null,
    });
    expect((failed?.['aAttempts'] as unknown[]).length).toBe(4);
    // Nothing more is ever attempted for a FAILED alert.
    h.clock.advance(60 * MIN);
    expect(await h.t.services.dispatcher.runOnce()).toBe(0);
  });

  it('uses EMAIL_RETRY_BACKOFF_MIN from the configuration (acceptance 8)', async () => {
    const h = await startAlertsHarness(mongo, { config: { EMAIL_RETRY_BACKOFF_MIN: '2' } });
    const alert = await queue(h);
    h.mailer.failAlways = true;
    await h.t.services.dispatcher.runOnce();
    expect(await stored(h, alert.id)).toMatchObject({
      eStatus: 'RETRYING',
      dNextAttemptAt: new Date(h.clock.now().getTime() + 2 * MIN),
    });
    h.clock.advance(2 * MIN);
    await h.t.services.dispatcher.runOnce();
    expect(await stored(h, alert.id)).toMatchObject({ eStatus: 'FAILED' });
    expect(h.mailer.attempts).toBe(2);
  });

  it('resend works once SMTP is back: FAILED -> PENDING -> SENT with a fresh backoff', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await queue(h);
    h.mailer.failAlways = true;
    for (const wait of [0, 1, 5, 15]) {
      h.clock.advance(wait * MIN);
      await h.t.services.dispatcher.runOnce();
    }
    expect(await stored(h, alert.id)).toMatchObject({ eStatus: 'FAILED' });

    h.mailer.failAlways = false;
    await h.t.services.alerts.resend(alert.id, h.actor);
    expect(await stored(h, alert.id)).toMatchObject({ eStatus: 'PENDING', nRetryIndex: 0 });
    await h.t.services.dispatcher.runOnce();
    const sent = await stored(h, alert.id);
    expect(sent).toMatchObject({ eStatus: 'SENT' });
    expect((sent?.['aAttempts'] as unknown[]).length).toBe(5);
  });
});

describe('concurrency and crash safety', () => {
  it('two dispatchers racing never send the same alert twice', async () => {
    const h = await startAlertsHarness(mongo);
    for (let i = 0; i < 8; i++) await queue(h);
    const second = createAlertDispatcher({
      repo: createAlertsRepository(h.t.db),
      mailer: h.mailer,
      clock: h.clock,
      logger: createLogger({ level: 'silent' }),
      settings: { pollMs: 10_000, lockMs: 120_000, retryBackoffMs: [], sendTimeoutMs: 30_000 },
    });
    const [a, b] = await Promise.all([h.t.services.dispatcher.runOnce(), second.runOnce()]);
    expect(a + b).toBe(8);
    expect(h.mailer.sent).toHaveLength(8);
    expect(new Set(h.mailer.sent.map((m) => m.messageId)).size).toBe(8);
    expect(await h.t.db.collection(COLLECTIONS.ALERTS).countDocuments({ eStatus: 'SENT' })).toBe(8);
  });

  it('start() resumes PENDING alerts left behind by a previous run', async () => {
    const h = await startAlertsHarness(mongo);
    const left = await queue(h);
    expect(h.mailer.sent).toHaveLength(0);
    h.t.services.dispatcher.start();
    await waitFor(() => h.mailer.sent.length === 1);
    await h.t.services.dispatcher.stop();
    expect(await stored(h, left.id)).toMatchObject({ eStatus: 'SENT' });
  });

  it('start() also resumes RETRYING alerts once they are due', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await queue(h);
    await h.t.db.collection(COLLECTIONS.ALERTS).updateOne(
      { _id: new ObjectId(alert.id) },
      {
        $set: {
          eStatus: 'RETRYING',
          nRetryIndex: 1,
          dNextAttemptAt: new Date(h.clock.now().getTime() - 1000),
        },
      },
    );
    h.t.services.dispatcher.start();
    await waitFor(() => h.mailer.sent.length === 1);
    await h.t.services.dispatcher.stop();
  });

  it('does not touch an alert another dispatcher has locked, and takes it over after the lock expires (at-least-once)', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await queue(h);
    await h.t.db
      .collection(COLLECTIONS.ALERTS)
      .updateOne(
        { _id: new ObjectId(alert.id) },
        { $set: { dLockedUntil: new Date(h.clock.now().getTime() + 2 * MIN) } },
      );
    expect(await h.t.services.dispatcher.runOnce()).toBe(0);
    h.clock.advance(3 * MIN);
    expect(await h.t.services.dispatcher.runOnce()).toBe(1);
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('a dispatcher whose claim expired cannot overwrite the outcome of the one that took over (review M6)', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await queue(h);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stuck = createFakeMailer();
    stuck.beforeSend = () => gate;
    stuck.failAlways = true;
    const slow = createAlertDispatcher({
      repo: createAlertsRepository(h.t.db),
      mailer: stuck,
      clock: h.clock,
      logger: createLogger({ level: 'silent' }),
      settings: { pollMs: 10_000, lockMs: 120_000, retryBackoffMs: [MIN], sendTimeoutMs: 60_000 },
    });
    const slowRun = slow.runOnce();
    await waitFor(() => stuck.attempts === 1);

    // The claim expires while the first send hangs; the main dispatcher takes over and succeeds.
    h.clock.advance(3 * MIN);
    expect(await h.t.services.dispatcher.runOnce()).toBe(1);
    expect(await stored(h, alert.id)).toMatchObject({ eStatus: 'SENT' });

    // The first send now fails: its late "retry" must not turn SENT back into RETRYING.
    release?.();
    await slowRun;
    const doc = await stored(h, alert.id);
    expect(doc).toMatchObject({ eStatus: 'SENT', sMessageId: h.mailer.sent[0]?.messageId });
    expect((doc?.['aAttempts'] as unknown[]).length).toBe(1);
  });

  it('gives up a send that never finishes at the send deadline and schedules a retry (review M6)', async () => {
    const h = await startAlertsHarness(mongo);
    const alert = await queue(h);
    const hanging = createFakeMailer();
    hanging.beforeSend = () => new Promise(() => undefined);
    const dispatcher = createAlertDispatcher({
      repo: createAlertsRepository(h.t.db),
      mailer: hanging,
      clock: h.clock,
      logger: createLogger({ level: 'silent' }),
      settings: { pollMs: 10_000, lockMs: 120_000, retryBackoffMs: [MIN], sendTimeoutMs: 50 },
    });
    expect(await dispatcher.runOnce()).toBe(1);
    expect(await stored(h, alert.id)).toMatchObject({
      eStatus: 'RETRYING',
      aAttempts: [{ bIsSuccess: false, sErrorCode: 'SMTP_TIMEOUT' }],
    });
  });

  it('sends nothing while this process does not hold the lease (canRun false)', async () => {
    const h = await startAlertsHarness(mongo);
    await queue(h);
    const standby = createAlertDispatcher({
      repo: createAlertsRepository(h.t.db),
      mailer: h.mailer,
      clock: h.clock,
      logger: createLogger({ level: 'silent' }),
      settings: { pollMs: 10_000, lockMs: 120_000, retryBackoffMs: [], sendTimeoutMs: 30_000 },
      canRun: () => false,
    });
    expect(await standby.runOnce()).toBe(0);
    expect(h.mailer.attempts).toBe(0);
  });

  it('stop() waits for the alert being sent and then sends no more', async () => {
    const h = await startAlertsHarness(mongo);
    await queue(h);
    await queue(h);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = createFakeMailer();
    slow.beforeSend = () => gate;
    const dispatcher = createAlertDispatcher({
      repo: createAlertsRepository(h.t.db),
      mailer: slow,
      clock: h.clock,
      logger: createLogger({ level: 'silent' }),
      settings: { pollMs: 10_000, lockMs: 120_000, retryBackoffMs: [], sendTimeoutMs: 30_000 },
    });
    dispatcher.start();
    await waitFor(() => slow.attempts === 1);
    const stopping = dispatcher.stop();
    release?.();
    await stopping;
    expect(slow.sent.length).toBeGreaterThanOrEqual(1);
  });

  it('nudge() sends a newly stored alert without waiting for the next poll', async () => {
    const h = await startAlertsHarness(mongo);
    h.t.services.dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await queue(h);
    await waitFor(() => h.mailer.sent.length === 1);
    await h.t.services.dispatcher.stop();
  });
});
