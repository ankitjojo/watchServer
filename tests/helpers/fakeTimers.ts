import type { Timers } from '../../src/scheduler/scheduler.js';
import type { FakeClock } from './fakeClock.js';

interface Pending {
  at: number;
  fn: () => void;
  id: number;
}

/** Virtual time: timers fire when the FakeClock is advanced, in order, with async work allowed to settle. */
export class FakeTimers implements Timers {
  private pending: Pending[] = [];
  private nextId = 1;

  constructor(private readonly clock: FakeClock) {}

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.push({ at: this.clock.now().getTime() + ms, fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((p) => p.id !== handle);
  }

  get count(): number {
    return this.pending.length;
  }

  /** Lets promise chains (awaits inside fired callbacks) run to completion. */
  async settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async advance(ms: number): Promise<void> {
    const target = this.clock.now().getTime() + ms;
    for (;;) {
      const due = this.pending.filter((p) => p.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.pending = this.pending.filter((p) => p !== due);
      this.clock.set(new Date(Math.max(due.at, this.clock.now().getTime())));
      due.fn();
      await this.settle();
    }
    this.clock.set(new Date(target));
    await this.settle();
  }
}
