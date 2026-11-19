import type { MonitorType } from '../constants/monitorType.js';

export type ScheduleReason = 'CREATE' | 'EDIT' | 'RESUME';

/**
 * What monitor services need from the scheduler (FR-S1). Phase 9 binds the real scheduler;
 * until then the no-op keeps services testable and free of an import cycle (plan App. E, TD-28).
 */
export interface SchedulerPort {
  /** (Re)schedules a monitor right away. D8: CREATE and RESUME also run the first check at once. */
  upsert(type: MonitorType, id: string, reason: ScheduleReason): Promise<void>;
  remove(type: MonitorType, id: string): void;
}

export const noopSchedulerPort: SchedulerPort = {
  upsert: () => Promise.resolve(),
  remove: () => undefined,
};

/**
 * Breaks the construction cycle monitor services -> scheduler -> runners -> monitor services
 * (plan App. E, TD-28): services get this port first, and the real scheduler is bound later.
 */
export interface LateBoundSchedulerPort extends SchedulerPort {
  bind(target: SchedulerPort): void;
}

export function createLateBoundSchedulerPort(): LateBoundSchedulerPort {
  let target: SchedulerPort = noopSchedulerPort;
  return {
    upsert: (type, id, reason) => target.upsert(type, id, reason),
    remove: (type, id) => {
      target.remove(type, id);
    },
    bind: (next) => {
      target = next;
    },
  };
}
