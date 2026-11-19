import type { CheckResult } from '../../constants/checkResult.js';
import { INCIDENT_CLOSE_REASON, type IncidentCloseReason } from '../../constants/incidentCloseReason.js';
import type { MonitorType } from '../../constants/monitorType.js';
import { isDuplicateKeyError } from '../../errors/mongoErrors.js';
import type { Clock } from '../../types/clock.js';
import type { MonitorIncidentsPort } from './incidents.port.js';
import { toMonitorIncidentDoc, toSourceErrorIncidentDoc } from './incidents.mapper.js';
import type { IncidentsRepository } from './incidents.repository.js';
import type { Incident } from './incidents.types.js';

export interface IncidentsService extends MonitorIncidentsPort {
  findOpen(monitorId: string): Promise<Incident | null>;
  /** Opens a monitor incident. A concurrent open returns the one that won (unique partial index). */
  open(input: { monitorId: string; openingResult: CheckResult; checkId: string }): Promise<Incident>;
  markAlerted(id: string, at: Date, reminderCount?: number): Promise<void>;
  close(id: string, reason: IncidentCloseReason): Promise<Incident | null>;
  listForMonitor(monitorId: string, limit?: number): Promise<Incident[]>;
  /** Open monitor incidents plus an open source outage. */
  countOpen(): Promise<number>;

  findOpenSourceError(): Promise<Incident | null>;
  openSourceError(input: { affectedMonitorIds: string[]; checkId: string }): Promise<Incident>;
  addAffectedMonitor(id: string, monitorId: string): Promise<Incident | null>;
}

const DEFAULT_LIST_LIMIT = 50;

export function createIncidentsService(deps: { repo: IncidentsRepository; clock: Clock }): IncidentsService {
  const { repo, clock } = deps;

  return {
    findOpen: (monitorId) => repo.findOpenForMonitor(monitorId),

    async open(input) {
      try {
        return await repo.insert(toMonitorIncidentDoc(input, { now: clock.now() }));
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const existing = await repo.findOpenForMonitor(input.monitorId);
        if (existing) return existing;
        throw err;
      }
    },

    markAlerted: (id, at, reminderCount) => repo.markAlerted(id, at, reminderCount),
    close: (id, reason) => repo.close(id, clock.now(), reason),
    listForMonitor: (monitorId, limit = DEFAULT_LIST_LIMIT) => repo.listForMonitor(monitorId, limit),
    countOpen: () => repo.countOpen(),

    findOpenSourceError: () => repo.findOpenSourceError(),

    async openSourceError(input) {
      try {
        return await repo.insert(toSourceErrorIncidentDoc(input, { now: clock.now() }));
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const existing = await repo.findOpenSourceError();
        if (existing) return existing;
        throw err;
      }
    },

    addAffectedMonitor: (id, monitorId) => repo.addAffectedMonitor(id, monitorId, clock.now()),

    /** D7: deleting a monitor closes its incident silently (no RECOVERED email). */
    async closeOpenIncidentForDeletedMonitor(_type: MonitorType, monitorId: string) {
      const open = await repo.findOpenForMonitor(monitorId);
      if (open) await repo.close(open.id, clock.now(), INCIDENT_CLOSE_REASON.MONITOR_DELETED);
    },
  };
}
