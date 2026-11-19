import type { Db } from 'mongodb';
import { COLLECTIONS } from '../constants/collections.js';
import type { Logger } from '../logger/index.js';
import type { Clock } from '../types/clock.js';
import { systemTimers, type Timers } from './scheduler.js';

const LOCK_ID = 'scheduler';

interface LockDoc {
  _id: string;
  sOwnerId: string;
  dExpiresAt: Date;
}

export interface LeaseLock {
  /** Tries now, then keeps renewing. Emits `acquired` / `lost` through the callbacks. */
  start(): void;
  /** Stops renewing and releases the lease so another instance can take over at once. */
  stop(): Promise<void>;
  /** False as soon as the fencing deadline has passed, even if a renewal is still pending (review M1). */
  isHeld(): boolean;
  isRunning(): boolean;
  /** One acquire/renew attempt. Exposed so tests can drive it without timers. */
  tick(): Promise<void>;
}

export interface LeaseLockDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  ownerId: string;
  settings: { ttlMs: number; renewMs: number };
  onAcquired: () => void | Promise<void>;
  onLost: () => void | Promise<void>;
  /** Tests inject virtual timers; production uses unref'd system timers. */
  timers?: Timers;
}

class LeaseTimeoutError extends Error {
  constructor() {
    super('The lease operation did not answer in time');
    this.name = 'LeaseTimeoutError';
  }
}

/**
 * TD-05: only the process holding this lease runs checks or sends email, so a second instance
 * (restart overlap, a laptop pointed at production) can never double-send.
 *
 * Fencing (TD-28, review M1): the lease written at time T is valid for others to take at T + ttl.
 * This holder stops at T + ttl - renew, where T is the moment the renewal was SENT (not answered).
 * A watchdog timer enforces that deadline even while a renewal hangs, and every lease operation is
 * abandoned after `renewMs`, so a half-open connection can neither keep us leader nor stall the loop.
 */
export function createLeaseLock(deps: LeaseLockDeps): LeaseLock {
  const { db, clock, logger, ownerId, settings } = deps;
  const timers = deps.timers ?? systemTimers;
  const locks = db.collection<LockDoc>(COLLECTIONS.SCHEDULER_LOCKS);
  let held = false;
  let running = false;
  /** Epoch ms after which this holder must consider the lease lost. */
  let fenceAt = 0;
  let loopTimer: unknown;
  let watchdog: unknown;
  let busy: Promise<void> | undefined;

  function withDeadline<T>(operation: Promise<T>): Promise<T> {
    let handle: unknown;
    const deadline = new Promise<never>((_resolve, reject) => {
      handle = timers.setTimeout(() => {
        reject(new LeaseTimeoutError());
      }, settings.renewMs);
    });
    return Promise.race([operation, deadline]).finally(() => {
      timers.clearTimeout(handle);
    });
  }

  /** The request time when this owner now holds the lease, or null. A duplicate key means someone else holds it. */
  async function acquireOrRenew(): Promise<number | null> {
    const now = clock.now();
    try {
      const doc = await withDeadline(
        locks.findOneAndUpdate(
          { _id: LOCK_ID, $or: [{ sOwnerId: ownerId }, { dExpiresAt: { $lt: now } }] },
          { $set: { sOwnerId: ownerId, dExpiresAt: new Date(now.getTime() + settings.ttlMs) } },
          { upsert: true, returnDocument: 'after' },
        ),
      );
      return doc?.sOwnerId === ownerId ? now.getTime() : null;
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 11000) return null;
      throw err;
    }
  }

  async function lose(reason: string): Promise<void> {
    if (!held) return;
    held = false;
    timers.clearTimeout(watchdog);
    watchdog = undefined;
    logger.error({ event: 'lease.lost', ownerId, reason }, 'Scheduler lease lost: stopping checks and email');
    await deps.onLost();
  }

  function armWatchdog(): void {
    timers.clearTimeout(watchdog);
    watchdog = timers.setTimeout(
      () => {
        lose('could not renew before expiry').catch((err: unknown) => {
          logger.error({ event: 'lease.stopFailed', ownerId, err }, 'Could not stop after losing the lease');
        });
      },
      Math.max(0, fenceAt - clock.now().getTime()),
    );
  }

  /**
   * Review H3: if starting the scheduler/dispatcher fails, a leader that holds the lease but runs no
   * checks would be silent. Undo, release the lease and let the next tick (or another instance) retry.
   */
  async function startLeader(): Promise<void> {
    try {
      await deps.onAcquired();
    } catch (err) {
      held = false;
      timers.clearTimeout(watchdog);
      watchdog = undefined;
      logger.error(
        { event: 'lease.startFailed', ownerId, err },
        'Could not start checks and email after acquiring the lease: releasing it to retry',
      );
      try {
        await deps.onLost();
      } catch (stopErr) {
        logger.error(
          { event: 'lease.stopFailed', ownerId, err: stopErr },
          'Could not stop after a failed start',
        );
      }
      await withDeadline(locks.deleteOne({ _id: LOCK_ID, sOwnerId: ownerId })).catch((deleteErr: unknown) => {
        logger.warn(
          {
            event: 'lease.releaseFailed',
            ownerId,
            errorName: deleteErr instanceof Error ? deleteErr.name : 'unknown',
          },
          'Could not release the lease; it expires on its own',
        );
      });
    }
  }

  async function tick(): Promise<void> {
    try {
      const sentAt = await acquireOrRenew();
      if (sentAt !== null) {
        fenceAt = sentAt + settings.ttlMs - settings.renewMs;
        if (!held) {
          held = true;
          logger.info({ event: 'lease.acquired', ownerId }, 'Scheduler lease acquired');
          armWatchdog();
          await startLeader();
        } else {
          armWatchdog();
        }
      } else {
        await lose('held by another instance');
      }
    } catch (err) {
      logger.warn(
        { event: 'lease.renewFailed', ownerId, errorName: err instanceof Error ? err.name : 'unknown' },
        'Lease renewal failed',
      );
      // Self-fencing: step down BEFORE the lease can expire for someone else, so two leaders never overlap.
      if (held && clock.now().getTime() >= fenceAt) {
        await lose('could not renew before expiry');
      }
    }
  }

  function loop(): void {
    if (!running) return;
    loopTimer = timers.setTimeout(() => {
      busy = tick().finally(loop);
    }, settings.renewMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      busy = tick().finally(loop);
    },
    async stop() {
      running = false;
      timers.clearTimeout(loopTimer);
      loopTimer = undefined;
      await busy?.catch(() => undefined);
      timers.clearTimeout(watchdog);
      watchdog = undefined;
      const wasHeld = held;
      held = false;
      if (wasHeld) {
        await deps.onLost();
        await withDeadline(locks.deleteOne({ _id: LOCK_ID, sOwnerId: ownerId })).catch(() => undefined);
      }
    },
    isHeld: () => held && clock.now().getTime() < fenceAt,
    isRunning: () => running,
    tick,
  };
}
