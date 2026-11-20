import type { CheckTrigger } from '../../constants/checkTrigger.js';
import { MONITOR_TYPE } from '../../constants/monitorType.js';
import { NotFoundError } from '../../errors/appError.js';
import type { Logger } from '../../logger/index.js';
import type { Clock } from '../../types/clock.js';
import type { AlertsPort, MonitorSnapshot } from '../alerts/alerts.port.js';
import { isStillRunnable, type CheckRunner } from '../checks/checkRunner.js';
import type { ChecksService } from '../checks/checks.service.js';
import type { Check, RecordCheckInput } from '../checks/checks.types.js';
import { isSourceOutage, SourceDataError, sourceErrorCode } from '../sourceData/sourceData.errors.js';
import type { SourceDataService } from '../sourceData/sourceData.service.js';
import { evaluateStaleness } from './staleness.evaluator.js';
import type { WebhookMonitorsService } from './webhookMonitors.service.js';
import type { WebhookMonitor } from './webhookMonitors.types.js';

export interface WebhookRunnerDeps {
  monitors: Pick<WebhookMonitorsService, 'getById' | 'updateState'>;
  sourceData: Pick<SourceDataService, 'getLatestTimestamp'>;
  checks: ChecksService;
  alerts: AlertsPort;
  clock: Clock;
  logger: Logger;
}

export function toWebhookSnapshot(monitor: WebhookMonitor): MonitorSnapshot {
  return {
    monitorType: MONITOR_TYPE.WEBHOOK,
    monitorId: monitor.id,
    name: monitor.name,
    gatewayName: monitor.gatewayName,
    sourceCollection: monitor.sourceCollection,
    timestampKey: monitor.timestampKey,
    thresholdMs: monitor.threshold.ms,
    checkIntervalMs: monitor.checkInterval.ms,
    alertMode: monitor.alertMode,
    ...(monitor.repeatInterval ? { repeatIntervalMs: monitor.repeatInterval.ms } : {}),
  };
}

export function createWebhookRunner(deps: WebhookRunnerDeps): CheckRunner {
  const { monitors, sourceData, checks, alerts, clock, logger } = deps;

  type Evaluation = Pick<RecordCheckInput, 'result' | 'webhook' | 'error'> & {
    /** TD-29: true only when the Source DB itself was unreachable (grouped outage, FR-A4a). */
    isSourceOutage: boolean;
  };

  /** FR-W3 steps 1-3: read the newest document and decide OK / STALE / NO_DATA / ERROR. */
  async function evaluate(monitor: WebhookMonitor): Promise<Evaluation> {
    const webhookBase = { thresholdMs: monitor.threshold.ms };
    try {
      const latest = await sourceData.getLatestTimestamp(monitor.sourceCollection, monitor.timestampKey);
      const outcome = evaluateStaleness({ latest, thresholdMs: monitor.threshold.ms, now: clock.now() });
      if (outcome.result === 'NO_DATA') {
        return {
          result: 'NO_DATA',
          isSourceOutage: false,
          webhook: {
            ...webhookBase,
            reason: outcome.reason,
            ...(outcome.lastDocId === undefined ? {} : { lastDocId: outcome.lastDocId }),
          },
        };
      }
      return {
        result: outcome.result,
        isSourceOutage: false,
        webhook: {
          ...webhookBase,
          lastDocId: outcome.lastDocId,
          lastDocTimestamp: outcome.lastDocTimestamp,
          ageMs: outcome.ageMs,
        },
      };
    } catch (err) {
      // FR-W3: a failing or timed-out source query is ERROR. Only an unreachable Source DB is an
      // outage (FR-A4a); a failure limited to this collection is this monitor's own error (TD-29).
      const known = err instanceof SourceDataError;
      const outage = known && isSourceOutage(err);
      logger.warn(
        {
          event: 'check.sourceError',
          monitorId: monitor.id,
          kind: known ? err.kind : 'UNEXPECTED',
          scope: outage ? 'SOURCE' : 'MONITOR',
        },
        'Source read failed',
      );
      return {
        result: 'ERROR',
        isSourceOutage: outage,
        webhook: webhookBase,
        error: {
          code: known ? sourceErrorCode(err.kind) : 'INTERNAL_ERROR',
          message: known ? err.message : 'Unexpected error while reading the source database',
        },
      };
    }
  }

  return {
    async run(monitorId, trigger: CheckTrigger): Promise<Check | null> {
      let monitor: WebhookMonitor;
      try {
        monitor = await monitors.getById(monitorId);
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
      if (!monitor.isEnabled && trigger === 'SCHEDULE') return null;

      const startedAt = clock.now();
      const { isSourceOutage: outage, ...evaluation } = await evaluate(monitor);
      // Store first: the check exists before any alert can refer to it (FR-A1).
      const check = await checks.record({
        monitorId: monitor.id,
        monitorType: MONITOR_TYPE.WEBHOOK,
        trigger,
        startedAt,
        finishedAt: clock.now(),
        ...evaluation,
      });

      if (!(await isStillRunnable(monitors, monitor.id, trigger))) {
        logger.info(
          { event: 'check.droppedDeleted', monitorId: monitor.id, checkId: check.id },
          'Monitor was deleted or paused during the check: stored the check, skipped alerts and state',
        );
        return check;
      }

      const snapshot = toWebhookSnapshot(monitor);
      let openIncidentId: string | null | undefined;
      let alertError: Error | undefined;
      try {
        if (outage) {
          await alerts.handleSourceError({ monitor: snapshot, check });
        } else {
          openIncidentId = (await alerts.processCheckOutcome({ monitor: snapshot, check })).openIncidentId;
        }
      } catch (err) {
        alertError = err instanceof Error ? err : new Error('Alert processing failed', { cause: err });
      }

      // The monitor's state reflects the check even if alerting failed. During a source outage
      // the STALE/NO_DATA status is left unchanged (FR-A4a); the monitor's own error shows ERROR (TD-29).
      await monitors.updateState(monitor.id, {
        lastResult: check.result,
        lastCheckAt: check.finishedAt,
        lastCheckId: check.id,
        ...(outage
          ? {}
          : {
              currentStatus: check.result,
              lastAgeMs: check.webhook?.ageMs ?? null,
              ...(openIncidentId === undefined ? {} : { openIncidentId }),
            }),
      });

      logger.info(
        {
          event: 'check.result',
          monitorId: monitor.id,
          monitorType: 'WEBHOOK',
          checkId: check.id,
          trigger,
          result: check.result,
          ageMs: check.webhook?.ageMs,
          durationMs: check.finishedAt.getTime() - startedAt.getTime(),
        },
        'Webhook check finished',
      );
      if (alertError) throw alertError;
      return check;
    },
  };
}
