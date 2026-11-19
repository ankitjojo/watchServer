import { AUDIT_ACTION } from '../../constants/auditAction.js';
import { AUDIT_ENTITY_TYPE } from '../../constants/auditEntityType.js';
import { MONITOR_TYPE } from '../../constants/monitorType.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors/appError.js';
import { ERROR_CODE } from '../../errors/errorCodes.js';
import { isDuplicateKeyError } from '../../errors/mongoErrors.js';
import type { SchedulerPort } from '../../scheduler/schedulerPort.js';
import type { Clock } from '../../types/clock.js';
import { toStateSet, type MonitorStatePatch } from '../../utils/monitorState.js';
import { toObjectId } from '../../utils/objectId.js';
import type { AuditActor, AuditService } from '../audit/audit.types.js';
import type { MonitorIncidentsPort } from '../incidents/incidents.port.js';
import { SourceDataError } from '../sourceData/sourceData.errors.js';
import {
  describeInvalidKey,
  type KeyInspection,
  type SourceDataService,
} from '../sourceData/sourceData.service.js';
import { toWebhookMonitorDoc, toWebhookMonitorUpdate } from './webhookMonitors.mapper.js';
import type { WebhookMonitorsRepository } from './webhookMonitors.repository.js';
import type { SaveResult, WebhookMonitor, WebhookMonitorInput } from './webhookMonitors.types.js';

export interface WebhookMonitorsService {
  list(): Promise<WebhookMonitor[]>;
  listEnabled(): Promise<WebhookMonitor[]>;
  getById(id: string): Promise<WebhookMonitor>;
  create(input: WebhookMonitorInput, actor: AuditActor): Promise<SaveResult>;
  update(id: string, input: WebhookMonitorInput, actor: AuditActor): Promise<SaveResult>;
  remove(id: string, actor: AuditActor): Promise<void>;
  /** FR-D3 pause/resume. Idempotent. Pausing never closes an open incident. */
  setEnabled(id: string, isEnabled: boolean, actor: AuditActor): Promise<WebhookMonitor>;
  /** Used by runners and the scheduler: updates the monitor's `oState` only. */
  updateState(id: string, patch: MonitorStatePatch): Promise<void>;
}

export interface WebhookMonitorsServiceDeps {
  repo: WebhookMonitorsRepository;
  sourceData: Pick<SourceDataService, 'inspectTimestampKey'>;
  audit: AuditService;
  scheduler: SchedulerPort;
  incidents: MonitorIncidentsPort;
  clock: Clock;
  daysPerMonth: number;
}

const fieldError = (field: string, message: string): ValidationError =>
  new ValidationError(message, { details: { field } });

export function createWebhookMonitorsService(deps: WebhookMonitorsServiceDeps): WebhookMonitorsService {
  const { repo, sourceData, audit, scheduler, incidents, clock, daysPerMonth } = deps;

  async function load(id: string): Promise<WebhookMonitor> {
    const monitor = await repo.findById(id);
    if (!monitor) throw new NotFoundError('Monitor not found');
    return monitor;
  }

  /** FR-W2: reject an invalid key, warn (but save) for an empty collection, warn when unindexed. */
  async function inspect(input: WebhookMonitorInput): Promise<{ hasIndex: boolean; warnings: string[] }> {
    let inspection: KeyInspection;
    try {
      inspection = await sourceData.inspectTimestampKey(input.sourceCollection, input.timestampKey);
    } catch (err) {
      if (err instanceof SourceDataError && err.kind === 'COLLECTION_NOT_FOUND') {
        throw fieldError('sourceCollection', 'This collection does not exist in the source database');
      }
      throw err;
    }
    if (inspection.status === 'INVALID') {
      throw fieldError('timestampKey', describeInvalidKey(input.timestampKey, inspection.reason));
    }
    const warnings: string[] = [];
    if (inspection.status === 'EMPTY_COLLECTION') {
      warnings.push('The collection is empty, so the timestamp key could not be validated yet.');
    }
    if (!inspection.hasIndex) {
      warnings.push(
        `No index starts with "${input.timestampKey}" on ${input.sourceCollection}: every check will scan the collection. Ask the source backend owners to add { ${input.timestampKey}: -1 }; payMonitor cannot create it.`,
      );
    }
    return { hasIndex: inspection.hasIndex, warnings };
  }

  function mapSaveError(err: unknown): unknown {
    if (isDuplicateKeyError(err)) {
      return new ConflictError('A monitor with this name already exists', ERROR_CODE.CONFLICT, {
        details: { field: 'name' },
      });
    }
    return err;
  }

  function reschedule(monitor: WebhookMonitor, reason: 'CREATE' | 'EDIT'): Promise<void> {
    if (monitor.isEnabled) return scheduler.upsert(MONITOR_TYPE.WEBHOOK, monitor.id, reason);
    scheduler.remove(MONITOR_TYPE.WEBHOOK, monitor.id);
    return Promise.resolve();
  }

  return {
    list: () => repo.list(),
    listEnabled: () => repo.listEnabled(),
    getById: load,

    async create(input, actor) {
      const { hasIndex, warnings } = await inspect(input);
      let monitor: WebhookMonitor;
      try {
        monitor = await repo.insert(
          toWebhookMonitorDoc(input, {
            now: clock.now(),
            userId: toObjectId(actor.id),
            daysPerMonth,
            hasIndex,
          }),
        );
      } catch (err) {
        throw mapSaveError(err);
      }
      await audit.record({
        actor,
        action: AUDIT_ACTION.CREATE,
        entityType: AUDIT_ENTITY_TYPE.WEBHOOK_MONITOR,
        entityId: monitor.id,
        after: monitor,
      });
      await reschedule(monitor, 'CREATE');
      return { monitor, warnings };
    },

    async update(id, input, actor) {
      const before = await load(id);
      // Only re-read the Source DB when what we watch changed.
      const sourceChanged =
        before.sourceCollection !== input.sourceCollection || before.timestampKey !== input.timestampKey;
      const inspection = sourceChanged ? await inspect(input) : undefined;
      let after: WebhookMonitor | null;
      try {
        after = await repo.update(
          id,
          toWebhookMonitorUpdate(input, {
            now: clock.now(),
            userId: toObjectId(actor.id),
            daysPerMonth,
            ...(inspection ? { hasIndex: inspection.hasIndex } : {}),
          }),
        );
      } catch (err) {
        throw mapSaveError(err);
      }
      if (!after) throw new NotFoundError('Monitor not found');
      await audit.record({
        actor,
        action: AUDIT_ACTION.UPDATE,
        entityType: AUDIT_ENTITY_TYPE.WEBHOOK_MONITOR,
        entityId: id,
        before,
        after,
      });
      // D15: an open incident stays open; the next check decides using the new configuration.
      await reschedule(after, 'EDIT');
      return { monitor: after, warnings: inspection?.warnings ?? [] };
    },

    async setEnabled(id, isEnabled, actor) {
      const before = await load(id);
      if (before.isEnabled === isEnabled) return before;
      const after = await repo.setEnabled(id, isEnabled, clock.now(), toObjectId(actor.id));
      if (!after) throw new NotFoundError('Monitor not found');
      await audit.record({
        actor,
        action: isEnabled ? AUDIT_ACTION.RESUME : AUDIT_ACTION.PAUSE,
        entityType: AUDIT_ENTITY_TYPE.WEBHOOK_MONITOR,
        entityId: id,
        before: { isEnabled: before.isEnabled },
        after: { isEnabled: after.isEnabled },
      });
      // D8: resuming runs the first check at once. After resume the next check decides the status.
      if (isEnabled) await scheduler.upsert(MONITOR_TYPE.WEBHOOK, id, 'RESUME');
      else scheduler.remove(MONITOR_TYPE.WEBHOOK, id);
      return after;
    },

    updateState: (id, patch) => repo.updateState(id, toStateSet(patch)),

    async remove(id, actor) {
      const before = await load(id);
      const deleted = await repo.softDelete(id, clock.now(), toObjectId(actor.id));
      if (!deleted) throw new NotFoundError('Monitor not found');
      scheduler.remove(MONITOR_TYPE.WEBHOOK, id);
      // D7: close the open incident without any email.
      await incidents.closeOpenIncidentForDeletedMonitor(MONITOR_TYPE.WEBHOOK, id);
      await audit.record({
        actor,
        action: AUDIT_ACTION.DELETE,
        entityType: AUDIT_ENTITY_TYPE.WEBHOOK_MONITOR,
        entityId: id,
        before,
      });
    },
  };
}
