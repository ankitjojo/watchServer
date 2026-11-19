import type { MonitorType } from '../../../src/constants/monitorType.js';
import { createLogger } from '../../../src/logger/index.js';
import type { CheckRunner } from '../../../src/modules/checks/checkRunner.js';
import { createScheduler, type ScheduledMonitor, type Scheduler } from '../../../src/scheduler/scheduler.js';
import { FakeClock } from '../../helpers/fakeClock.js';
import { FakeTimers } from '../../helpers/fakeTimers.js';

const MIN = 60_000;
const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);

interface Harness {
  scheduler: Scheduler;
  clock: FakeClock;
  timers: FakeTimers;
  runs: { type: MonitorType; id: string; trigger: string; at: number }[];
  monitors: Map<string, ScheduledMonitor>;
  scheduled: { id: string; next: Date | null }[];
  /** Make a run take this long (virtual ms) before finishing; only runs of `type` when it is set. */
  duration: { ms: number; type?: MonitorType };
  failFor: Set<string>;
  concurrent: { now: number; max: number };
  /** Every delay handed to setTimeout (to prove none exceeds Node's limit). */
  delays: number[];
}

function setup(initial: ScheduledMonitor[], concurrency = 5): Harness {
  const clock = new FakeClock('2026-11-18T12:00:00Z');
  const timers = new FakeTimers(clock);
  const realSetTimeout = timers.setTimeout.bind(timers);
  const delays: number[] = [];
  timers.setTimeout = (fn, ms) => {
    delays.push(ms);
    return realSetTimeout(fn, ms);
  };
  const monitors = new Map(initial.map((m) => [`${m.type}:${m.id}`, m]));
  const h = {
    runs: [],
    scheduled: [],
    duration: { ms: 0 },
    failFor: new Set<string>(),
    concurrent: { now: 0, max: 0 },
  } as unknown as Harness;
  const runner = (type: MonitorType): CheckRunner => ({
    async run(id, trigger) {
      h.runs.push({ type, id, trigger, at: clock.now().getTime() });
      h.concurrent.now++;
      h.concurrent.max = Math.max(h.concurrent.max, h.concurrent.now);
      try {
        if (h.duration.ms > 0 && (h.duration.type === undefined || h.duration.type === type)) {
          await new Promise<void>((resolve) => {
            timers.setTimeout(resolve, h.duration.ms);
          });
        }
        if (h.failFor.has(id)) throw new Error('runner exploded');
        return {
          id: 'check',
          monitorId: id,
          monitorType: type,
          trigger,
          startedAt: clock.now(),
          finishedAt: clock.now(),
          result: 'OK',
        };
      } finally {
        h.concurrent.now--;
      }
    },
  });
  h.clock = clock;
  h.timers = timers;
  h.delays = delays;
  h.monitors = monitors;
  h.scheduler = createScheduler({
    runners: { WEBHOOK: runner('WEBHOOK'), ENDPOINT: runner('ENDPOINT') },
    loadEnabled: () => Promise.resolve([...monitors.values()]),
    load: (type, id) => Promise.resolve(monitors.get(`${type}:${id}`) ?? null),
    onScheduled: (_type, id, next) => {
      h.scheduled.push({ id, next });
      return Promise.resolve();
    },
    clock,
    logger: createLogger({ level: 'silent' }),
    timers,
    settings: { concurrency, shutdownTimeoutMs: 15_000 },
  });
  return h;
}

const monitor = (
  id: string,
  intervalMs: number,
  type: MonitorType = 'WEBHOOK',
  lastCheckAt: Date | null = null,
): ScheduledMonitor => ({ type, id, intervalMs, lastCheckAt });
const runsOf = (h: Harness, id: string) => h.runs.filter((r) => r.id === id);

describe('start (FR-S3)', () => {
  it('runs every enabled monitor once right away, then on each interval', async () => {
    const h = setup([monitor(A, 10 * MIN), monitor(B, 5 * MIN, 'ENDPOINT')]);
    await h.scheduler.start();
    await h.timers.advance(0);
    expect(h.runs.map((r) => `${r.type}:${r.id}`).sort()).toEqual([`ENDPOINT:${B}`, `WEBHOOK:${A}`]);
    expect(h.runs.every((r) => r.trigger === 'SCHEDULE')).toBe(true);

    await h.timers.advance(30 * MIN);
    expect(runsOf(h, A)).toHaveLength(1 + 3);
    expect(runsOf(h, B)).toHaveLength(1 + 6);
    expect(h.scheduler.isActive()).toBe(true);
  });

  it('measures the next run from the START of the previous one (no drift), and does not replay missed runs', async () => {
    const h = setup([monitor(A, 10 * MIN)]);
    await h.scheduler.start();
    await h.timers.advance(0);
    h.duration.ms = 3 * MIN;
    await h.timers.advance(10 * MIN);
    await h.timers.advance(10 * MIN);
    const times = runsOf(h, A).map((r) => r.at);
    const first = times[0] ?? 0;
    expect(times.map((t) => (t - first) / MIN)).toEqual([0, 10, 20]);
  });

  it('records the planned next run time for the dashboard', async () => {
    const h = setup([monitor(A, 10 * MIN)]);
    await h.scheduler.start();
    await h.timers.advance(0);
    const last = h.scheduled.filter((s) => s.id === A).at(-1);
    expect(last?.next).toEqual(new Date(h.clock.now().getTime() + 10 * MIN));
  });

  it('does nothing twice when started twice', async () => {
    const h = setup([monitor(A, 10 * MIN)]);
    await h.scheduler.start();
    await h.scheduler.start();
    await h.timers.advance(0);
    expect(runsOf(h, A)).toHaveLength(1);
  });
});

describe('start failure (review H3)', () => {
  it('is not active when loading the monitors fails, so a second start() really starts', async () => {
    const clock = new FakeClock('2026-11-18T12:00:00Z');
    const timers = new FakeTimers(clock);
    const runs: string[] = [];
    let fail = true;
    const scheduler = createScheduler({
      runners: {
        WEBHOOK: {
          run: (id) => {
            runs.push(id);
            return Promise.resolve(null);
          },
        },
        ENDPOINT: { run: () => Promise.resolve(null) },
      },
      loadEnabled: () => {
        if (fail) return Promise.reject(new Error('Monitor DB blip'));
        return Promise.resolve([monitor(A, 10 * MIN)]);
      },
      load: () => Promise.resolve(null),
      onScheduled: () => Promise.resolve(),
      clock,
      logger: createLogger({ level: 'silent' }),
      timers,
      settings: { concurrency: 5, shutdownTimeoutMs: 15_000 },
    });

    await expect(scheduler.start()).rejects.toThrow('Monitor DB blip');
    expect(scheduler.isActive()).toBe(false);

    fail = false;
    await scheduler.start();
    await timers.advance(0);
    expect(scheduler.isActive()).toBe(true);
    expect(runs).toEqual([A]);
  });
});

describe('timer limit guard (review H1)', () => {
  it('never hands setTimeout a delay above 2^31-1 ms (Node would fire it after 1 ms)', async () => {
    const h = setup([monitor(A, 1000 * 60 * MIN), monitor(B, 10 * MIN)]);
    await h.scheduler.start();
    await h.timers.advance(0);
    expect(h.delays.every((ms) => ms <= 2 ** 31 - 1)).toBe(true);
    // The over-long monitor ran its first check once and is not re-armed; the other keeps going.
    await h.timers.advance(30 * MIN);
    expect(runsOf(h, A)).toHaveLength(1);
    expect(runsOf(h, B)).toHaveLength(4);
    expect(h.scheduled.filter((s) => s.id === A).at(-1)?.next).toBeNull();
  });

  it('accepts the 24 h maximum interval', async () => {
    const h = setup([monitor(A, 24 * 60 * MIN)]);
    await h.scheduler.start();
    await h.timers.advance(24 * 60 * MIN);
    expect(runsOf(h, A)).toHaveLength(2);
  });
});

describe('overlap guard (FR-S2)', () => {
  it('skips a tick while the previous run of the same monitor is still going, and recovers afterwards', async () => {
    const h = setup([monitor(A, 1 * MIN)]);
    h.duration.ms = 150_000;
    await h.scheduler.start();
    await h.timers.advance(0);
    await h.timers.advance(2 * MIN);
    expect(runsOf(h, A)).toHaveLength(1);
    await h.timers.advance(2 * MIN);
    h.duration.ms = 0;
    await h.timers.advance(2 * MIN);
    expect(runsOf(h, A).length).toBeGreaterThanOrEqual(2);
  });

  it('other monitors keep running while one is slow', async () => {
    const h = setup([monitor(A, 1 * MIN), monitor(B, 1 * MIN)]);
    await h.scheduler.start();
    await h.timers.advance(0);
    h.duration.ms = 0;
    await h.timers.advance(5 * MIN);
    expect(runsOf(h, B).length).toBeGreaterThanOrEqual(5);
  });
});

describe('failure isolation (FR-S4)', () => {
  it('a runner that throws does not stop its own next run or any other monitor', async () => {
    const h = setup([monitor(A, 5 * MIN), monitor(B, 5 * MIN)]);
    h.failFor.add(A);
    await h.scheduler.start();
    await h.timers.advance(0);
    await h.timers.advance(15 * MIN);
    expect(runsOf(h, A)).toHaveLength(4);
    expect(runsOf(h, B)).toHaveLength(4);
  });
});

describe('live changes without a restart (FR-S1, D8)', () => {
  it('create runs the first check at once', async () => {
    const h = setup([]);
    await h.scheduler.start();
    h.monitors.set(`WEBHOOK:${C}`, monitor(C, 10 * MIN));
    await h.scheduler.upsert('WEBHOOK', C, 'CREATE');
    await h.timers.advance(0);
    expect(runsOf(h, C)).toHaveLength(1);
    await h.timers.advance(10 * MIN);
    expect(runsOf(h, C)).toHaveLength(2);
  });

  it('edit: a new interval takes effect, counted from the last check (or now if that moment has passed)', async () => {
    const h = setup([monitor(A, 10 * MIN)]);
    await h.scheduler.start();
    await h.timers.advance(0);
    const lastCheckAt = h.clock.now();
    await h.timers.advance(2 * MIN);

    h.monitors.set(`WEBHOOK:${A}`, monitor(A, 5 * MIN, 'WEBHOOK', lastCheckAt));
    await h.scheduler.upsert('WEBHOOK', A, 'EDIT');
    // lastCheck + 5 min is 3 minutes away.
    await h.timers.advance(2 * MIN);
    expect(runsOf(h, A)).toHaveLength(1);
    await h.timers.advance(1 * MIN);
    expect(runsOf(h, A)).toHaveLength(2);
    await h.timers.advance(10 * MIN);
    expect(runsOf(h, A)).toHaveLength(4);
  });

  it('edit with a moment already in the past runs the check now', async () => {
    const h = setup([monitor(A, 60 * MIN)]);
    await h.scheduler.start();
    await h.timers.advance(0);
    const lastCheckAt = h.clock.now();
    await h.timers.advance(20 * MIN);
    h.monitors.set(`WEBHOOK:${A}`, monitor(A, 5 * MIN, 'WEBHOOK', lastCheckAt));
    await h.scheduler.upsert('WEBHOOK', A, 'EDIT');
    await h.timers.advance(0);
    expect(runsOf(h, A)).toHaveLength(2);
  });

  it('remove stops the runs, and resume runs the first check at once', async () => {
    const h = setup([monitor(A, 5 * MIN)]);
    await h.scheduler.start();
    await h.timers.advance(0);
    h.scheduler.remove('WEBHOOK', A);
    expect(h.scheduled.at(-1)).toEqual({ id: A, next: null });
    await h.timers.advance(30 * MIN);
    expect(runsOf(h, A)).toHaveLength(1);
    await h.scheduler.upsert('WEBHOOK', A, 'RESUME');
    await h.timers.advance(0);
    expect(runsOf(h, A)).toHaveLength(2);
  });

  it('upsert of a monitor that is gone or paused removes it', async () => {
    const h = setup([monitor(A, 5 * MIN)]);
    await h.scheduler.start();
    await h.timers.advance(0);
    h.monitors.delete(`WEBHOOK:${A}`);
    await h.scheduler.upsert('WEBHOOK', A, 'EDIT');
    await h.timers.advance(30 * MIN);
    expect(runsOf(h, A)).toHaveLength(1);
  });

  it('is a no-op while the scheduler is not active (standby picks monitors up on start)', async () => {
    const h = setup([]);
    h.monitors.set(`WEBHOOK:${A}`, monitor(A, 5 * MIN));
    await h.scheduler.upsert('WEBHOOK', A, 'CREATE');
    await h.timers.advance(10 * MIN);
    expect(h.runs).toHaveLength(0);
  });
});

describe('run now (FR-D3)', () => {
  it('runs with trigger MANUAL and returns the check', async () => {
    const h = setup([monitor(A, 10 * MIN)]);
    await h.scheduler.start();
    await h.timers.advance(0);
    const check = await h.scheduler.runNow('WEBHOOK', A);
    expect(check.result).toBe('OK');
    expect(h.runs.at(-1)).toMatchObject({ id: A, trigger: 'MANUAL' });
  });

  it('works for a paused monitor too (D14): it is not required to be scheduled', async () => {
    const h = setup([]);
    await h.scheduler.start();
    await expect(h.scheduler.runNow('WEBHOOK', A)).resolves.toBeDefined();
  });

  it('refuses with ALREADY_RUNNING while the monitor is being checked', async () => {
    const h = setup([monitor(A, 10 * MIN)]);
    h.duration.ms = 5 * MIN;
    await h.scheduler.start();
    await h.timers.advance(0);
    await expect(h.scheduler.runNow('WEBHOOK', A)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'ALREADY_RUNNING',
    });
  });

  it('refuses with SCHEDULER_STANDBY when this instance is not active', async () => {
    const h = setup([]);
    await expect(h.scheduler.runNow('WEBHOOK', A)).rejects.toMatchObject({
      httpStatus: 409,
      code: 'SCHEDULER_STANDBY',
    });
  });

  it('reports not found when the runner found no monitor', async () => {
    const h = setup([]);
    await h.scheduler.start();
    const original = h.scheduler.runNow.bind(h.scheduler);
    h.failFor.add(A);
    await expect(original('WEBHOOK', A)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('concurrency cap', () => {
  it('never runs more than the configured number of checks at once', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(24, '0'));
    const h = setup(
      ids.map((id) => monitor(id, 10 * MIN)),
      3,
    );
    h.duration.ms = 1000;
    await h.scheduler.start();
    await h.timers.advance(0);
    await h.timers.advance(20_000);
    expect(h.concurrent.max).toBe(3);
    expect(h.runs).toHaveLength(12);
  });

  it('slow endpoint probes never delay webhook checks past the ±30 s accuracy (review M7, requirements 5)', async () => {
    const endpoints = Array.from({ length: 5 }, (_, i) => (i + 1).toString(16).padStart(24, 'e'));
    const h = setup([...endpoints.map((id) => monitor(id, 10 * MIN, 'ENDPOINT')), monitor(A, 10 * MIN)], 5);
    // Worst case at the maximum retry count: 6 attempts x 10 s timeout + 5 x 5 s delay = 85 s each.
    h.duration.ms = 85_000;
    h.duration.type = 'ENDPOINT';
    await h.scheduler.start();
    await h.timers.advance(0);
    const start = h.clock.now().getTime();
    for (let cycle = 0; cycle < 3; cycle++) {
      const due = start + cycle * 10 * MIN;
      const run = runsOf(h, A)[cycle];
      expect(run).toBeDefined();
      expect(Math.abs((run?.at ?? Infinity) - due)).toBeLessThanOrEqual(30_000);
      await h.timers.advance(10 * MIN);
    }
  });

  it('still caps Source DB reads: at most `concurrency` webhook checks at once', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => i.toString(16).padStart(24, 'a'));
    const h = setup(
      ids.map((id) => monitor(id, 10 * MIN)),
      2,
    );
    h.duration.ms = 1000;
    await h.scheduler.start();
    await h.timers.advance(0);
    await h.timers.advance(10_000);
    expect(h.concurrent.max).toBe(2);
    expect(h.runs).toHaveLength(6);
  });
});

describe('stop (graceful)', () => {
  it('clears every timer and waits for a running check before resolving', async () => {
    const h = setup([monitor(A, 10 * MIN)]);
    h.duration.ms = 30_000;
    await h.scheduler.start();
    await h.timers.advance(0);
    let stopped = false;
    const stopping = h.scheduler.stop().then(() => {
      stopped = true;
    });
    await h.timers.settle();
    expect(stopped).toBe(false);
    await h.timers.advance(30_000);
    await stopping;
    expect(stopped).toBe(true);
    expect(h.scheduler.isActive()).toBe(false);
    await h.timers.advance(60 * MIN);
    expect(runsOf(h, A)).toHaveLength(1);
  });

  it('gives up waiting after the shutdown timeout', async () => {
    const h = setup([monitor(A, 10 * MIN)]);
    h.duration.ms = 10 * 60 * MIN;
    await h.scheduler.start();
    await h.timers.advance(0);
    const stopping = h.scheduler.stop();
    await h.timers.advance(15_000);
    await expect(stopping).resolves.toBeUndefined();
  });
});
