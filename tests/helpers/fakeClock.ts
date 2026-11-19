import type { Clock } from '../../src/types/clock.js';

export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date | string = '2026-11-18T12:00:00.000Z') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date | string): void {
    this.current = new Date(date);
  }
}
