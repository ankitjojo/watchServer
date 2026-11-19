import { MONITOR_TYPE, type MonitorType } from '../../constants/monitorType.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { AlertsService } from '../alerts/alerts.service.js';
import type { Alert } from '../alerts/alerts.types.js';
import type { AuditActor } from '../audit/audit.types.js';
import type { ChecksService } from '../checks/checks.service.js';
import type { Check, CheckListFilter, SeriesPoint } from '../checks/checks.types.js';
import type { EndpointMonitorsService } from '../endpointMonitors/endpointMonitors.service.js';
import { toEndpointSnapshot } from '../endpointMonitors/endpointMonitors.runner.js';
import type { WebhookMonitorsService } from '../webhookMonitors/webhookMonitors.service.js';
import { toWebhookSnapshot } from '../webhookMonitors/webhookMonitors.runner.js';
import type { Paginated } from '../../types/paginated.js';
import type { Clock } from '../../types/clock.js';
import type { MonitorTypeParam } from './monitorActions.schemas.js';

export const MONITOR_TYPE_BY_PARAM: Record<MonitorTypeParam, MonitorType> = {
  webhook: MONITOR_TYPE.WEBHOOK,
  endpoint: MONITOR_TYPE.ENDPOINT,
};

const RANGE_MS = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;

export interface MonitorActionsService {
  run(type: MonitorTypeParam, id: string): Promise<Check>;
  pause(
    type: MonitorTypeParam,
    id: string,
    actor: AuditActor,
  ): Promise<{ isEnabled: boolean; nextCheckAt: Date | null }>;
  resume(
    type: MonitorTypeParam,
    id: string,
    actor: AuditActor,
  ): Promise<{ isEnabled: boolean; nextCheckAt: Date | null }>;
  testEmail(type: MonitorTypeParam, id: string, actor: AuditActor): Promise<Alert>;
  listChecks(
    type: MonitorTypeParam,
    id: string,
    filter: Omit<CheckListFilter, 'monitorId'>,
    page: { cursor?: string; limit?: number },
  ): Promise<Paginated<Check>>;
  series(
    type: MonitorTypeParam,
    id: string,
    range: { range: '24h' | '7d' | '30d' | 'custom'; from?: Date | undefined; to?: Date | undefined },
  ): Promise<{ points: SeriesPoint[]; thresholdMs?: number }>;
}

export interface MonitorActionsDeps {
  webhookMonitors: WebhookMonitorsService;
  endpointMonitors: EndpointMonitorsService;
  scheduler: Pick<Scheduler, 'runNow'>;
  alerts: Pick<AlertsService, 'sendTestEmail'>;
  checks: ChecksService;
  clock: Clock;
}

/** One place for the actions both monitor types share, so each type's service stays small (api-standards 1). */
export function createMonitorActionsService(deps: MonitorActionsDeps): MonitorActionsService {
  const { webhookMonitors, endpointMonitors, scheduler, alerts, checks, clock } = deps;

  async function setEnabled(type: MonitorTypeParam, id: string, isEnabled: boolean, actor: AuditActor) {
    const monitor =
      type === 'webhook'
        ? await webhookMonitors.setEnabled(id, isEnabled, actor)
        : await endpointMonitors.setEnabled(id, isEnabled, actor);
    // Re-read so the caller sees the next check time the scheduler has just recorded.
    const fresh = type === 'webhook' ? await webhookMonitors.getById(id) : await endpointMonitors.getById(id);
    return { isEnabled: monitor.isEnabled, nextCheckAt: monitor.isEnabled ? fresh.state.nextCheckAt : null };
  }

  return {
    async run(type, id) {
      // Existence first, so an unknown id is a 404 rather than "could not complete".
      if (type === 'webhook') await webhookMonitors.getById(id);
      else await endpointMonitors.getById(id);
      return scheduler.runNow(MONITOR_TYPE_BY_PARAM[type], id);
    },
    pause: (type, id, actor) => setEnabled(type, id, false, actor),
    resume: (type, id, actor) => setEnabled(type, id, true, actor),

    async testEmail(type, id, actor) {
      const snapshot =
        type === 'webhook'
          ? toWebhookSnapshot(await webhookMonitors.getById(id))
          : toEndpointSnapshot(await endpointMonitors.getById(id));
      return alerts.sendTestEmail(snapshot, actor);
    },

    async listChecks(type, id, filter, page) {
      if (type === 'webhook') await webhookMonitors.getById(id);
      else await endpointMonitors.getById(id);
      return checks.listForMonitor({ monitorId: id, ...filter }, page);
    },

    async series(type, id, range) {
      const monitor =
        type === 'webhook' ? await webhookMonitors.getById(id) : await endpointMonitors.getById(id);
      const to = range.range === 'custom' ? (range.to ?? clock.now()) : clock.now();
      const from =
        range.range === 'custom' ? (range.from ?? to) : new Date(to.getTime() - RANGE_MS[range.range]);
      const points = await checks.series({
        monitorId: id,
        monitorType: MONITOR_TYPE_BY_PARAM[type],
        from,
        to,
      });
      return {
        points,
        ...(type === 'webhook' && 'threshold' in monitor ? { thresholdMs: monitor.threshold.ms } : {}),
      };
    },
  };
}
