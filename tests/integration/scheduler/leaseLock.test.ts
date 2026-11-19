import type { Db } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { createLogger } from '../../../src/logger/index.js';
import { createLeaseLock, type LeaseLock } from '../../../src/scheduler/leaseLock.js';
import { systemClock } from '../../../src/types/clock.js';
import { FakeClock } from '../../helpers/fakeClock.js';
import { FakeTimers } from '../../helpers/fakeTimers.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';

let mongo: TestMongo;
const logger = createLogger({ level: 'silent' });
const TTL = 45_000;
const RENEW = 15_000;

beforeAll(async () => {
  mongo = await startTestMongo();
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

interface Instance {
  lease: LeaseLock;
  events: string[];
}

function instance(db: Db, clock: FakeClock, ownerId: string): Instance {
  const events: string[] = [];
  const lease = createLeaseLock({
    db,
    clock,
    logger,
    ownerId,
    settings: { ttlMs: TTL, renewMs: RENEW },
    onAcquired: () => {
      events.push('acquired');
    },
    onLost: () => {
      events.push('lost');
    },
  });
  return { lease, events };
}

const lockDoc = (db: Db) => db.collection(COLLECTIONS.SCHEDULER_LOCKS).findOne({ _id: 'scheduler' as never });

describe('scheduler lease (TD-05)', () => {
  it('the first instance acquires it and records its owner and expiry', async () => {
    const db = mongo.newDb('lease');
    const clock = new FakeClock();
    const a = instance(db, clock, 'owner-a');
    await a.lease.tick();
    expect(a.lease.isHeld()).toBe(true);
    expect(a.events).toEqual(['acquired']);
    expect(await lockDoc(db)).toMatchObject({
      sOwnerId: 'owner-a',
      dExpiresAt: new Date(clock.now().getTime() + TTL),
    });
  });

  it('a second instance cannot take a valid lease, and fires no events', async () => {
    const db = mongo.newDb('lease');
    const clock = new FakeClock();
    const a = instance(db, clock, 'owner-a');
    const b = instance(db, clock, 'owner-b');
    await a.lease.tick();
    await b.lease.tick();
    expect(b.lease.isHeld()).toBe(false);
    expect(b.events).toEqual([]);
    expect((await lockDoc(db))?.['sOwnerId']).toBe('owner-a');
  });

  it('renewing extends the expiry and does not announce "acquired" again', async () => {
    const db = mongo.newDb('lease');
    const clock = new FakeClock();
    const a = instance(db, clock, 'owner-a');
    await a.lease.tick();
    clock.advance(RENEW);
    await a.lease.tick();
    expect(a.events).toEqual(['acquired']);
    expect((await lockDoc(db))?.['dExpiresAt']).toEqual(new Date(clock.now().getTime() + TTL));
  });

  it('another instance takes over after the lease expires, and the old holder learns it lost it', async () => {
    const db = mongo.newDb('lease');
    const clock = new FakeClock();
    const a = instance(db, clock, 'owner-a');
    const b = instance(db, clock, 'owner-b');
    await a.lease.tick();
    clock.advance(TTL + 1);
    await b.lease.tick();
    expect(b.lease.isHeld()).toBe(true);
    expect(b.events).toEqual(['acquired']);
    await a.lease.tick();
    expect(a.lease.isHeld()).toBe(false);
    expect(a.events).toEqual(['acquired', 'lost']);
    expect((await lockDoc(db))?.['sOwnerId']).toBe('owner-b');
  });

  it('only one of many instances ever holds the lease at a time', async () => {
    const db = mongo.newDb('lease');
    const clock = new FakeClock();
    const all = Array.from({ length: 6 }, (_, i) => instance(db, clock, `owner-${i}`));
    await Promise.all(all.map((i) => i.lease.tick()));
    expect(all.filter((i) => i.lease.isHeld())).toHaveLength(1);
  });

  it('stop() releases the lease so another instance can take over at once, and reports it lost', async () => {
    const db = mongo.newDb('lease');
    const clock = new FakeClock();
    const a = instance(db, clock, 'owner-a');
    const b = instance(db, clock, 'owner-b');
    await a.lease.tick();
    await a.lease.stop();
    expect(a.events).toEqual(['acquired', 'lost']);
    expect(await lockDoc(db)).toBeNull();
    await b.lease.tick();
    expect(b.lease.isHeld()).toBe(true);
  });

  it('stop() by an instance that never held it does not touch the lease', async () => {
    const db = mongo.newDb('lease');
    const clock = new FakeClock();
    const a = instance(db, clock, 'owner-a');
    const b = instance(db, clock, 'owner-b');
    await a.lease.tick();
    await b.lease.tick();
    await b.lease.stop();
    expect((await lockDoc(db))?.['sOwnerId']).toBe('owner-a');
  });
});

describe('self-fencing: step down before anyone else could take over', () => {
  /** A db whose lease collection starts failing when `broken.on` is true (simulates an unreachable Monitor DB). */
  function flaky(real: Db, broken: { on: boolean }): Db {
    return {
      collection: (name: string) => {
        const collection = real.collection(name);
        return new Proxy(collection, {
          get(target, prop) {
            if (prop === 'findOneAndUpdate' && broken.on)
              return () => Promise.reject(new Error('Monitor DB unreachable'));
            const value: unknown = Reflect.get(target, prop);
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      },
    } as unknown as Db;
  }

  it('loses the lease when renewal keeps failing, BEFORE the lease can expire for another instance', async () => {
    const real = mongo.newDb('lease');
    const clock = new FakeClock();
    const broken = { on: false };
    const a = instance(flaky(real, broken), clock, 'owner-a');
    const b = instance(real, clock, 'owner-b');

    await a.lease.tick();
    expect(a.lease.isHeld()).toBe(true);
    broken.on = true;

    // Still inside the safe window: keeps going on the lease it already holds.
    clock.advance(RENEW);
    await a.lease.tick();
    expect(a.lease.isHeld()).toBe(true);

    // ttl - renew after the last successful renewal: it must step down now.
    clock.advance(TTL - RENEW * 2);
    await a.lease.tick();
    expect(a.lease.isHeld()).toBe(false);
    expect(a.events).toEqual(['acquired', 'lost']);

    // At this moment the lease has NOT expired, so nobody else can hold it: no overlap.
    expect(((await lockDoc(real))?.['dExpiresAt'] as Date).getTime()).toBeGreaterThan(clock.now().getTime());
    await b.lease.tick();
    expect(b.lease.isHeld()).toBe(false);

    // Only after it expires does the other instance take over.
    clock.advance(RENEW + 1);
    await b.lease.tick();
    expect(b.lease.isHeld()).toBe(true);
  });

  it('does not lose the lease on a single failed renewal', async () => {
    const real = mongo.newDb('lease');
    const clock = new FakeClock();
    const broken = { on: false };
    const a = instance(flaky(real, broken), clock, 'owner-a');
    await a.lease.tick();
    broken.on = true;
    clock.advance(RENEW);
    await a.lease.tick();
    broken.on = false;
    clock.advance(RENEW);
    await a.lease.tick();
    expect(a.lease.isHeld()).toBe(true);
    expect(a.events).toEqual(['acquired']);
  });
});

describe('self-fencing while a renewal HANGS (review M1)', () => {
  /** A db whose lease update never answers while `hang.on` (half-open connection). */
  function hanging(real: Db, hang: { on: boolean }): Db {
    return {
      collection: (name: string) => {
        const collection = real.collection(name);
        return new Proxy(collection, {
          get(target, prop) {
            if (prop === 'findOneAndUpdate' && hang.on) return () => new Promise(() => undefined);
            const value: unknown = Reflect.get(target, prop);
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      },
    } as unknown as Db;
  }

  function hangingInstance(real: Db, clock: FakeClock, timers: FakeTimers, hang: { on: boolean }): Instance {
    const events: string[] = [];
    const lease = createLeaseLock({
      db: hanging(real, hang),
      clock,
      timers,
      logger,
      ownerId: 'owner-a',
      settings: { ttlMs: TTL, renewMs: RENEW },
      onAcquired: () => {
        events.push('acquired');
      },
      onLost: () => {
        events.push('lost');
      },
    });
    return { lease, events };
  }

  it('isHeld() turns false at the fencing deadline even while the renewal is still hanging', async () => {
    const real = mongo.newDb('lease');
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const hang = { on: false };
    const a = hangingInstance(real, clock, timers, hang);
    await a.lease.tick();
    expect(a.lease.isHeld()).toBe(true);

    hang.on = true;
    // Time passes without any timer firing (event loop busy): the answer is still time-based.
    clock.advance(TTL - RENEW);
    expect(a.lease.isHeld()).toBe(false);
  });

  it('steps down (onLost) before the lease can expire, and a hung renewal does not block the loop forever', async () => {
    const real = mongo.newDb('lease');
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const hang = { on: false };
    const a = hangingInstance(real, clock, timers, hang);
    const b = instance(real, clock, 'owner-b');
    await a.lease.tick();

    hang.on = true;
    await timers.advance(RENEW);
    const renewing = a.lease.tick();
    await timers.advance(TTL - 2 * RENEW);

    expect(a.lease.isHeld()).toBe(false);
    expect(a.events).toEqual(['acquired', 'lost']);
    // Stepped down while the lease is still valid in the DB: nobody else could have held it yet.
    expect(((await lockDoc(real))?.['dExpiresAt'] as Date).getTime()).toBeGreaterThan(clock.now().getTime());
    await b.lease.tick();
    expect(b.lease.isHeld()).toBe(false);

    // The hung call was abandoned at its deadline, so tick() finished and the loop can go on.
    await timers.advance(RENEW);
    await expect(renewing).resolves.toBeUndefined();
  });
});

describe('a failing leader start is retried (review H3)', () => {
  it('releases the lease when onAcquired fails, and the next tick acquires and starts again', async () => {
    const db = mongo.newDb('lease');
    const clock = new FakeClock();
    const events: string[] = [];
    let failNext = true;
    const lease = createLeaseLock({
      db,
      clock,
      logger,
      ownerId: 'owner-a',
      settings: { ttlMs: TTL, renewMs: RENEW },
      onAcquired: () => {
        events.push('acquired');
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('loadEnabled failed'));
        }
        return Promise.resolve();
      },
      onLost: () => {
        events.push('lost');
      },
    });

    await lease.tick();
    expect(lease.isHeld()).toBe(false);
    expect(events).toEqual(['acquired', 'lost']);
    // Released, so this instance (or another) can take it at once.
    expect(await lockDoc(db)).toBeNull();

    clock.advance(RENEW);
    await lease.tick();
    expect(lease.isHeld()).toBe(true);
    expect(events).toEqual(['acquired', 'lost', 'acquired']);
  });
});

describe('background loop', () => {
  it('start() acquires, keeps renewing on its own, and stop() releases', async () => {
    const db = mongo.newDb('lease');
    const events: string[] = [];
    const lease = createLeaseLock({
      db,
      clock: systemClock,
      logger,
      ownerId: 'loop-owner',
      settings: { ttlMs: 2000, renewMs: 50 },
      onAcquired: () => {
        events.push('acquired');
      },
      onLost: () => {
        events.push('lost');
      },
    });
    lease.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(lease.isRunning()).toBe(true);
    expect(lease.isHeld()).toBe(true);
    const first = (await lockDoc(db))?.['dExpiresAt'] as Date;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(((await lockDoc(db))?.['dExpiresAt'] as Date).getTime()).toBeGreaterThan(first.getTime());
    await lease.stop();
    expect(lease.isRunning()).toBe(false);
    expect(events).toEqual(['acquired', 'lost']);
    expect(await lockDoc(db)).toBeNull();
  });
});
