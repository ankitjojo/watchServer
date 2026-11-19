import { AUDIT_ACTION } from '../../constants/auditAction.js';
import { AUDIT_ENTITY_TYPE } from '../../constants/auditEntityType.js';
import { MONITOR_TYPE } from '../../constants/monitorType.js';
import { ConflictError, NotFoundError } from '../../errors/appError.js';
import { ERROR_CODE } from '../../errors/errorCodes.js';
import { isDuplicateKeyError } from '../../errors/mongoErrors.js';
import type { SchedulerPort } from '../../scheduler/schedulerPort.js';
import type { Clock } from '../../types/clock.js';
import { toStateSet, type MonitorStatePatch } from '../../utils/monitorState.js';
import { toObjectId } from '../../utils/objectId.js';
import type { AuditActor, AuditService } from '../audit/audit.types.js';
import type { MonitorIncidentsPort } from '../incidents/incidents.port.js';
import { toEndpointMonitorDoc, toEndpointMonitorUpdate } from './endpointMonitors.mapper.js';
import type { EndpointMonitorsRepository } from './endpointMonitors.repository.js';
import type { EndpointMonitor, EndpointMonitorInput } from './endpointMonitors.types.js';

export interface EndpointMonitorsService {
  list(): Promise<EndpointMonitor[]>;
  listEnabled(): Promise<EndpointMonitor[]>;
  getById(id: string): Promise<EndpointMonitor>;
  create(input: EndpointMonitorInput, actor: AuditActor): Promise<EndpointMonitor>;
  update(id: string, input: EndpointMonitorInput, actor: AuditActor): Promise<EndpointMonitor>;
  remove(id: string, actor: AuditActor): Promise<void>;
  /** FR-D3 pause/resume. Idempotent. Pausing never closes an open incident. */
  setEnabled(id: string, isEnabled: boolean, actor: AuditActor): Promise<EndpointMonitor>;
  /** Used by runners and the scheduler: updates the monitor's `oState` only. */
  updateState(id: string, patch: MonitorStatePatch): Promise<void>;
}

export interface EndpointMonitorsServiceDeps {
  repo: EndpointMonitorsRepository;
  audit: AuditService;
  scheduler: SchedulerPort;
  incidents: MonitorIncidentsPort;
  clock: Clock;
  daysPerMonth: number;
}

export function createEndpointMonitorsService(deps: EndpointMonitorsServiceDeps): EndpointMonitorsService {
  const { repo, audit, scheduler, incidents, clock, daysPerMonth } = deps;

  async function load(id: string): Promise<EndpointMonitor> {
    const monitor = await repo.findById(id);
    if (!monitor) throw new NotFoundError('Monitor not found');
    return monitor;
  }

  function mapSaveError(err: unknown): unknown {
    if (isDuplicateKeyError(err)) {
      return new ConflictError('A server with this name already exists', ERROR_CODE.CONFLICT, {
        details: { field: 'serverName' },
      });
    }
    return err;
  }

  function reschedule(monitor: EndpointMonitor, reason: 'CREATE' | 'EDIT'): Promise<void> {
    if (monitor.isEnabled) return scheduler.upsert(MONITOR_TYPE.ENDPOINT, monitor.id, reason);
    scheduler.remove(MONITOR_TYPE.ENDPOINT, monitor.id);
    return Promise.resolve();
  }

  return {
    list: () => repo.list(),
    listEnabled: () => repo.listEnabled(),
    getById: load,

    async create(input, actor) {
      let monitor: EndpointMonitor;
      try {
        monitor = await repo.insert(
          toEndpointMonitorDoc(input, { now: clock.now(), userId: toObjectId(actor.id), daysPerMonth }),
        );
      } catch (err) {
        throw mapSaveError(err);
      }
      await audit.record({
        actor,
        action: AUDIT_ACTION.CREATE,
        entityType: AUDIT_ENTITY_TYPE.ENDPOINT_MONITOR,
        entityId: monitor.id,
        after: monitor,
      });
      await reschedule(monitor, 'CREATE');
      return monitor;
    },

    async update(id, input, actor) {
      const before = await load(id);
      let after: EndpointMonitor | null;
      try {
        after = await repo.update(
          id,
          toEndpointMonitorUpdate(input, { now: clock.now(), userId: toObjectId(actor.id), daysPerMonth }),
        );
      } catch (err) {
        throw mapSaveError(err);
      }
      if (!after) throw new NotFoundError('Monitor not found');
      await audit.record({
        actor,
        action: AUDIT_ACTION.UPDATE,
        entityType: AUDIT_ENTITY_TYPE.ENDPOINT_MONITOR,
        entityId: id,
        before,
        after,
      });
      // D15: an open incident stays open; the next check decides using the new configuration.
      await reschedule(after, 'EDIT');
      return after;
    },

    async setEnabled(id, isEnabled, actor) {
      const before = await load(id);
      if (before.isEnabled === isEnabled) return before;
      const after = await repo.setEnabled(id, isEnabled, clock.now(), toObjectId(actor.id));
      if (!after) throw new NotFoundError('Monitor not found');
      await audit.record({
        actor,
        action: isEnabled ? AUDIT_ACTION.RESUME : AUDIT_ACTION.PAUSE,
        entityType: AUDIT_ENTITY_TYPE.ENDPOINT_MONITOR,
        entityId: id,
        before: { isEnabled: before.isEnabled },
        after: { isEnabled: after.isEnabled },
      });
      // D8: resuming runs the first check at once. After resume the next check decides the status.
      if (isEnabled) await scheduler.upsert(MONITOR_TYPE.ENDPOINT, id, 'RESUME');
      else scheduler.remove(MONITOR_TYPE.ENDPOINT, id);
      return after;
    },

    updateState: (id, patch) => repo.updateState(id, toStateSet(patch)),

    async remove(id, actor) {
      const before = await load(id);
      const deleted = await repo.softDelete(id, clock.now(), toObjectId(actor.id));
      if (!deleted) throw new NotFoundError('Monitor not found');
      scheduler.remove(MONITOR_TYPE.ENDPOINT, id);
      // D7: close the open incident without any email.
      await incidents.closeOpenIncidentForDeletedMonitor(MONITOR_TYPE.ENDPOINT, id);
      await audit.record({
        actor,
        action: AUDIT_ACTION.DELETE,
        entityType: AUDIT_ENTITY_TYPE.ENDPOINT_MONITOR,
        entityId: id,
        before,
      });
    },
  };
}
