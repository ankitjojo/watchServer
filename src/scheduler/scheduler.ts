import type { CheckTrigger } from '../constants/checkTrigger.js';
import type { MonitorType } from '../constants/monitorType.js';
import { ConflictError, NotFoundError } from '../errors/appError.js';
import { ERROR_CODE } from '../errors/errorCodes.js';
import type { Logger } from '../logger/index.js';
import type { CheckRunner } from '../modules/checks/checkRunner.js';
import type { Check } from '../modules/checks/checks.types.js';
import type { Clock } from '../types/clock.js';
import type { ScheduleReason, SchedulerPort } from './schedulerPort.js';

/** What the scheduler needs to know about a monitor. */
export interface ScheduledMonitor {
  type: MonitorType;
  id: string;
  intervalMs: number;
  lastCheckAt: Date | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface SchedulerDeps {
  runners: Record<MonitorType, CheckRunner>;
  /** Every enabled, non-deleted monitor (FR-S3). */
  loadEnabled(): Promise<ScheduledMonitor[]>;
  /** One monitor, or null when it is missing, deleted or paused. */
  load(type: MonitorType, id: string): Promise<ScheduledMonitor | null>;
  /** Called with the next planned run (null when unscheduled) so the dashboard can show it. */
  onScheduled(type: MonitorType, id: string, nextRunAt: Date | null): Promise<void>;
  clock: Clock;
  logger: Logger;
  timers?: Timers;
  /** `concurrency`: webhook checks (Source DB reads) running at once (SCHEDULER_CONCURRENCY). */
  settings: { concurrency: number; shutdownTimeoutMs: number };
}

export interface Scheduler extends SchedulerPort {
  /** FR-S3: schedule every enabled monitor and run each once right away. Missed runs are not replayed. */
  start(): Promise<void>;
  /** Stops timers and waits (bounded) for checks that are running. */
  stop(): Promise<void>;
  isActive(): boolean;
  /** FR-D3: run now, with the same alert rules as a scheduled run. */
  runNow(type: MonitorType, id: string): Promise<Check>;
}

interface Entry {
  type: MonitorType;
  id: string;
  intervalMs: number;
  timer: unknown;
}

const keyOf = (type: MonitorType, id: string): string => `${type}:${id}`;

/** Node runs any longer setTimeout after 1 ms instead (review H1), so such a delay is refused. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { runners, clock, logger, settings } = deps;
  const timers = deps.timers ?? systemTimers;
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<unknown>>();
  let active = false;
  /** Set while start() is loading monitors; active only becomes true once that worked (review H3). */
  let starting: Promise<void> | undefined;

  // A cap protects the Source DB when many webhook monitors fire together (coding standards 6).
  // Endpoint probes never touch the Source DB and can take 85 s at the maximum retry count, so they
  // do not queue behind it, or a few dead endpoints would delay every webhook check (review M7).
  let running = 0;
  const waiting: (() => void)[] = [];
  async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (running >= settings.concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  function record(type: MonitorType, id: string, next: Date | null): void {
    deps.onScheduled(type, id, next).catch((err: unknown) => {
      logger.warn(
        { event: 'scheduler.nextCheckNotSaved', monitorId: id, err },
        'Could not save the next check time',
      );
    });
  }

  function arm(entry: Entry, dueAt: Date): void {
    timers.clearTimeout(entry.timer);
    entry.timer = undefined;
    const delay = Math.max(0, dueAt.getTime() - clock.now().getTime());
    if (delay > MAX_TIMER_DELAY_MS) {
      // Validation caps intervals at 24 h; this guards documents saved before that rule existed.
      logger.error(
        { event: 'check.scheduleRefused', monitorId: entry.id, monitorType: entry.type, delayMs: delay },
        'Check not scheduled: the delay is longer than the timer limit',
      );
      record(entry.type, entry.id, null);
      return;
    }
    entry.timer = timers.setTimeout(() => {
      void fire(entry);
    }, delay);
    record(entry.type, entry.id, dueAt);
    logger.debug(
      { event: 'check.scheduled', monitorId: entry.id, monitorType: entry.type, nextRunAt: dueAt },
      'Check scheduled',
    );
  }

  /** Never throws: a failing check must not stop the others (FR-S4). */
  async function execute(entry: Pick<Entry, 'type' | 'id'>, trigger: CheckTrigger): Promise<Check | null> {
    const key = keyOf(entry.type, entry.id);
    const task = (async (): Promise<Check | null> => {
      try {
        const run = (): Promise<Check | null> => runners[entry.type].run(entry.id, trigger);
        return await (entry.type === 'WEBHOOK' ? withSlot(run) : run());
      } catch (err) {
        logger.error(
          { event: 'check.failed', monitorId: entry.id, monitorType: entry.type, trigger, err },
          'Check failed',
        );
        return null;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, task);
    return task;
  }

  async function fire(entry: Entry): Promise<void> {
    if (!active || entries.get(keyOf(entry.type, entry.id)) !== entry) return;
    // Plan 5.4: the next run is measured from the START of this one, so slow checks do not drift.
    arm(entry, new Date(clock.now().getTime() + entry.intervalMs));
    if (inFlight.has(keyOf(entry.type, entry.id))) {
      // FR-S2: the previous run has not finished.
      logger.warn(
        { event: 'check.skipped', monitorId: entry.id, monitorType: entry.type, reason: 'IN_FLIGHT' },
        'Check skipped: previous run still going',
      );
      return;
    }
    await execute(entry, 'SCHEDULE');
  }

  function track(monitor: ScheduledMonitor): Entry {
    const existing = entries.get(keyOf(monitor.type, monitor.id));
    if (existing) {
      existing.intervalMs = monitor.intervalMs;
      return existing;
    }
    const entry: Entry = {
      type: monitor.type,
      id: monitor.id,
      intervalMs: monitor.intervalMs,
      timer: undefined,
    };
    entries.set(keyOf(monitor.type, monitor.id), entry);
    return entry;
  }

  function untrack(type: MonitorType, id: string): void {
    const entry = entries.get(keyOf(type, id));
    if (!entry) return;
    timers.clearTimeout(entry.timer);
    entries.delete(keyOf(type, id));
    record(type, id, null);
  }

  return {
    async start() {
      if (active) return;
      starting ??= (async (): Promise<void> => {
        try {
          // If this throws, the scheduler stays inactive so the next start() really starts.
          const monitors = await deps.loadEnabled();
          active = true;
          for (const monitor of monitors) {
            // FR-S3: first check right after startup; nothing from the downtime is replayed.
            arm(track(monitor), clock.now());
          }
          logger.info({ event: 'scheduler.started', monitorCount: monitors.length }, 'Scheduler started');
        } finally {
          starting = undefined;
        }
      })();
      await starting;
    },

    async stop() {
      if (starting) await starting.catch(() => undefined);
      if (!active) return;
      active = false;
      for (const entry of entries.values()) timers.clearTimeout(entry.timer);
      entries.clear();
      const pending = Promise.allSettled([...inFlight.values()]);
      let timeout: unknown;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timeout = timers.setTimeout(() => {
            logger.warn(
              { event: 'scheduler.stopTimeout', inFlight: inFlight.size },
              'Stopped with checks still running',
            );
            resolve();
          }, settings.shutdownTimeoutMs);
        }),
      ]);
      timers.clearTimeout(timeout);
      logger.info({ event: 'scheduler.stopped' }, 'Scheduler stopped');
    },

    isActive: () => active,

    async upsert(type, id, reason: ScheduleReason) {
      // A change made while start() is loading is applied once it has finished.
      if (!active && starting) await starting.catch(() => undefined);
      // Not the leader (or not started): the monitor is picked up from the database on start().
      if (!active) return;
      const monitor = await deps.load(type, id);
      if (!monitor) {
        untrack(type, id);
        return;
      }
      const entry = track(monitor);
      const now = clock.now();
      if (reason === 'EDIT' && monitor.lastCheckAt) {
        // D8: keep the rhythm: last check + the NEW interval, or now if that moment has passed.
        const due = new Date(monitor.lastCheckAt.getTime() + monitor.intervalMs);
        arm(entry, due.getTime() > now.getTime() ? due : now);
      } else {
        // D8: create and resume run the first check at once.
        arm(entry, now);
      }
    },

    remove(type, id) {
      untrack(type, id);
    },

    async runNow(type, id) {
      if (!active)
        throw new ConflictError(
          'This instance is not the active one, so it cannot run checks',
          ERROR_CODE.SCHEDULER_STANDBY,
        );
      const key = keyOf(type, id);
      if (inFlight.has(key))
        throw new ConflictError('This monitor is already being checked', ERROR_CODE.ALREADY_RUNNING);
      const check = await execute({ type, id }, 'MANUAL');
      if (!check) throw new NotFoundError('The check could not be completed');
      return check;
    },
  };
}
