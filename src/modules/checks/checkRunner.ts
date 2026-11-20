import type { CheckTrigger } from '../../constants/checkTrigger.js';
import { NotFoundError } from '../../errors/appError.js';
import type { Check } from './checks.types.js';

/** What the scheduler calls (FR-S1..S4). One implementation per monitor type. */
export interface CheckRunner {
  /**
   * Runs one check, stores it, applies the alert rules. Returns null when the monitor no longer
   * exists, or is paused and the trigger is SCHEDULE (nothing was stored).
   */
  run(monitorId: string, trigger: CheckTrigger): Promise<Check | null>;
}

/**
 * Review L4: a monitor deleted (or, for a scheduled run, paused) while its check was running keeps
 * the stored check but must not open an incident, send an alert or change its state.
 */
export async function isStillRunnable(
  monitors: { getById(id: string): Promise<{ isEnabled: boolean }> },
  monitorId: string,
  trigger: CheckTrigger,
): Promise<boolean> {
  try {
    const monitor = await monitors.getById(monitorId);
    return monitor.isEnabled || trigger !== 'SCHEDULE';
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}
