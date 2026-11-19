import { randomUUID } from 'node:crypto';
import type { Logger } from '../../logger/index.js';
import {
  MailSendError,
  toMailSendError,
  type Mailer,
  type MailMessage,
} from '../../notifications/email/transport.js';
import type { Clock } from '../../types/clock.js';
import type { AlertsRepository } from './alerts.repository.js';
import type { AlertToSend } from './alerts.types.js';

export interface AlertDispatcher {
  /** Begins polling. Resumes PENDING/RETRYING alerts left over from before a crash (section 5). */
  start(): void;
  /** Stops polling and waits for the alert currently being sent. */
  stop(): Promise<void>;
  /** Process due alerts now instead of waiting for the next poll. */
  nudge(): void;
  /** Sends everything that is due and returns how many alerts were attempted. For tests and `nudge`. */
  runOnce(): Promise<number>;
}

export interface DispatcherDeps {
  repo: AlertsRepository;
  mailer: Mailer;
  clock: Clock;
  logger: Logger;
  /**
   * `sendTimeoutMs` (review M6): a send still running after this is abandoned and retried, so its
   * outcome is always written while our claim (`lockMs`) still holds. Config keeps it below `lockMs`.
   */
  settings: { pollMs: number; lockMs: number; retryBackoffMs: number[]; sendTimeoutMs: number };
  /** Only the process that holds the scheduler lease may send (TD-05). Defaults to always. */
  canRun?: () => boolean;
}

export function createAlertDispatcher(deps: DispatcherDeps): AlertDispatcher {
  const { repo, mailer, clock, logger, settings } = deps;
  const canRun = deps.canRun ?? ((): boolean => true);
  let running: Promise<number> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let started = false;

  /** Nodemailer's timeouts are per stage (idle socket), so one overall deadline bounds the whole send. */
  function sendWithDeadline(message: MailMessage): Promise<{ messageId: string }> {
    let handle: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      handle = setTimeout(() => {
        reject(new MailSendError('SMTP_TIMEOUT', 'The mail server did not answer in time'));
      }, settings.sendTimeoutMs);
      handle.unref();
    });
    return Promise.race([mailer.send(message), deadline]).finally(() => {
      clearTimeout(handle);
    });
  }

  /** Our claim was taken over (it expired): the other dispatcher's outcome stands (review M6). */
  function claimLost(alert: AlertToSend, outcome: string): void {
    logger.warn(
      { event: 'alert.claimLost', alertId: alert.id, outcome },
      'Alert claim expired before the outcome was written; another dispatcher owns it now',
    );
  }

  /** FR-A2: success -> SENT; failure -> RETRYING with the next backoff; backoff used up -> FAILED. */
  async function sendOne(alert: AlertToSend): Promise<void> {
    const attemptAt = clock.now();
    try {
      const { messageId } = await sendWithDeadline({
        to: alert.recipients.map((r) => r.email),
        subject: alert.subject,
        text: alert.textBody,
        html: alert.htmlBody,
      });
      const written = await repo.markSent(alert.id, alert.claimId, {
        at: clock.now(),
        messageId,
        attempt: { dAt: attemptAt, bIsSuccess: true },
      });
      if (!written) {
        claimLost(alert, 'SENT');
        return;
      }
      logger.info(
        { event: 'alert.sent', alertId: alert.id, messageId, attempt: alert.attempts.length + 1 },
        'Alert email sent',
      );
    } catch (err) {
      const failure = toMailSendError(err);
      const attempt = {
        dAt: attemptAt,
        bIsSuccess: false,
        sErrorCode: failure.code,
        sErrorMessage: failure.message,
      };
      const backoff = settings.retryBackoffMs[alert.retryIndex];
      if (backoff !== undefined) {
        const nextAttemptAt = new Date(clock.now().getTime() + backoff);
        const written = await repo.markRetry(alert.id, alert.claimId, {
          at: clock.now(),
          nextAttemptAt,
          retryIndex: alert.retryIndex + 1,
          attempt,
        });
        if (!written) {
          claimLost(alert, 'RETRYING');
          return;
        }
        logger.warn(
          {
            event: 'alert.retry',
            alertId: alert.id,
            attempt: alert.attempts.length + 1,
            nextAttemptAt,
            errorCode: failure.code,
          },
          'Alert email failed, will retry',
        );
      } else {
        const written = await repo.markFailed(alert.id, alert.claimId, {
          at: clock.now(),
          reason: failure.message,
          attempt,
        });
        if (!written) {
          claimLost(alert, 'FAILED');
          return;
        }
        logger.error(
          { event: 'alert.failed', alertId: alert.id, reason: failure.message },
          'Alert email failed for good',
        );
      }
    }
  }

  async function drain(): Promise<number> {
    let attempted = 0;
    // Each claim atomically locks one alert, so two dispatchers never send the same one.
    for (;;) {
      if (!canRun()) return attempted;
      const now = clock.now();
      const alert = await repo.claimNext(now, new Date(now.getTime() + settings.lockMs), randomUUID());
      if (!alert) return attempted;
      attempted++;
      await sendOne(alert);
    }
  }

  function runOnce(): Promise<number> {
    // One loop at a time: a nudge during a running loop just waits for it.
    running ??= drain().finally(() => {
      running = undefined;
    });
    return running;
  }

  function schedule(): void {
    if (!started) return;
    timer = setTimeout(() => {
      runOnce()
        .catch((err: unknown) => {
          logger.error({ event: 'dispatcher.failed', err }, 'Dispatcher loop failed');
        })
        .finally(schedule);
    }, settings.pollMs);
    timer.unref();
  }

  return {
    start() {
      if (started) return;
      started = true;
      // Resume immediately: PENDING/RETRYING alerts survive restarts.
      runOnce()
        .catch((err: unknown) => {
          logger.error({ event: 'dispatcher.failed', err }, 'Dispatcher loop failed');
        })
        .finally(schedule);
    },
    async stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
    nudge() {
      if (!started) return;
      runOnce().catch((err: unknown) => {
        logger.error({ event: 'dispatcher.failed', err }, 'Dispatcher loop failed');
      });
    },
    runOnce,
  };
}
