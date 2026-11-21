import { MONITOR_TYPE } from '../../constants/monitorType.js';
import { NotFoundError } from '../../errors/appError.js';
import type { Logger } from '../../logger/index.js';
import type { Clock } from '../../types/clock.js';
import { maskUrl } from '../../utils/maskUrl.js';
import type { AlertsPort, MonitorSnapshot } from '../alerts/alerts.port.js';
import { isStillRunnable, type CheckRunner } from '../checks/checkRunner.js';
import type { ChecksService } from '../checks/checks.service.js';
import type { EndpointMonitorsService } from './endpointMonitors.service.js';
import type { EndpointMonitor } from './endpointMonitors.types.js';
import { shouldProcessAlert } from './endpointMonitors.downConfirm.js';
import { probe, type ProbeDeps } from './httpProbe.js';

export interface EndpointRunnerDeps {
  monitors: Pick<EndpointMonitorsService, 'getById' | 'updateState'>;
  checks: ChecksService;
  alerts: AlertsPort;
  clock: Clock;
  logger: Logger;
  probeDeps: ProbeDeps;
  /** From config (requirements 5.1), never from the form. */
  probeOptions: { retryDelayMs: number; timeoutMs: number; maxRedirects: number };
  /** ENDPOINT_DOWN_AFTER_CHECKS (TD-39). */
  downAfterChecks: number;
}

export function toEndpointSnapshot(monitor: EndpointMonitor): MonitorSnapshot {
  return {
    monitorType: MONITOR_TYPE.ENDPOINT,
    monitorId: monitor.id,
    name: monitor.serverName,
    // Masked: emails and alerts never carry query values or credentials.
    url: maskUrl(monitor.url),
    checkIntervalMs: monitor.checkInterval.ms,
    alertMode: monitor.alertMode,
    ...(monitor.repeatInterval ? { repeatIntervalMs: monitor.repeatInterval.ms } : {}),
  };
}

export function createEndpointRunner(deps: EndpointRunnerDeps): CheckRunner {
  const { monitors, checks, alerts, clock, logger, probeDeps, probeOptions, downAfterChecks } = deps;

  return {
    async run(monitorId, trigger) {
      let monitor: EndpointMonitor;
      try {
        monitor = await monitors.getById(monitorId);
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
      if (!monitor.isEnabled && trigger === 'SCHEDULE') return null;

      const startedAt = clock.now();
      const probed = await probe(monitor.url, { ...probeOptions, retryCount: monitor.retryCount }, probeDeps);
      // Store first (FR-A1). A failing endpoint is DOWN, never ERROR: unreachable IS the alert.
      const check = await checks.record({
        monitorId: monitor.id,
        monitorType: MONITOR_TYPE.ENDPOINT,
        trigger,
        startedAt,
        finishedAt: clock.now(),
        result: probed.isUp ? 'OK' : 'DOWN',
        endpoint: { attempts: probed.attempts },
      });

      if (!(await isStillRunnable(monitors, monitor.id, trigger))) {
        logger.info(
          { event: 'check.droppedDeleted', monitorId: monitor.id, checkId: check.id },
          'Monitor was deleted or paused during the check: stored the check, skipped alerts and state',
        );
        return check;
      }

      const isDown = check.result === 'DOWN';
      const consecutiveFailures = isDown ? monitor.state.consecutiveFailures + 1 : 0;
      const processAlert = shouldProcessAlert({
        isDown,
        consecutiveFailures,
        downAfterChecks,
        hasOpenIncident: monitor.state.openIncidentId !== null,
      });

      let openIncidentId: string | null | undefined;
      let alertError: Error | undefined;
      if (processAlert) {
        try {
          openIncidentId = (await alerts.processCheckOutcome({ monitor: toEndpointSnapshot(monitor), check }))
            .openIncidentId;
        } catch (err) {
          alertError = err instanceof Error ? err : new Error('Alert processing failed', { cause: err });
        }
      } else {
        logger.warn(
          {
            event: 'check.downUnconfirmed',
            monitorId: monitor.id,
            checkId: check.id,
            consecutiveFailures,
            downAfterChecks,
          },
          'Endpoint check failed; waiting for more failed checks before alerting',
        );
      }

      const lastAttempt = probed.attempts.at(-1);
      await monitors.updateState(monitor.id, {
        lastResult: check.result,
        currentStatus: check.result === 'OK' ? 'OK' : 'DOWN',
        lastCheckAt: check.finishedAt,
        lastCheckId: check.id,
        lastResponseTimeMs: lastAttempt?.responseTimeMs ?? null,
        consecutiveFailures,
        ...(openIncidentId === undefined ? {} : { openIncidentId }),
      });

      logger.info(
        {
          event: 'check.result',
          monitorId: monitor.id,
          monitorType: 'ENDPOINT',
          checkId: check.id,
          trigger,
          result: check.result,
          attempts: probed.attempts.length,
          durationMs: check.finishedAt.getTime() - startedAt.getTime(),
        },
        'Endpoint check finished',
      );
      if (alertError) throw alertError;
      return check;
    },
  };
}
