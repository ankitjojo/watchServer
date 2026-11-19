import type { CheckTrigger } from '../../constants/checkTrigger.js';
import type { Check } from './checks.types.js';

/** What the scheduler calls (FR-S1..S4). One implementation per monitor type. */
export interface CheckRunner {
  /**
   * Runs one check, stores it, applies the alert rules. Returns null when the monitor no longer
   * exists, or is paused and the trigger is SCHEDULE (nothing was stored).
   */
  run(monitorId: string, trigger: CheckTrigger): Promise<Check | null>;
}
