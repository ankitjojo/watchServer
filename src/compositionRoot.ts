import type { Db } from 'mongodb';
import type { Config } from './config/loadConfig.js';
import type { Logger } from './logger/index.js';
import {
  createScheduler,
  type Scheduler,
  type ScheduledMonitor,
  type Timers,
} from './scheduler/scheduler.js';
import { createLateBoundSchedulerPort } from './scheduler/schedulerPort.js';
import { NotFoundError } from './errors/appError.js';
import {
  createMonitorActionsService,
  type MonitorActionsService,
} from './modules/monitors/monitorActions.service.js';
import { createDashboardService, type DashboardService } from './modules/dashboard/dashboard.service.js';
import { createMonitorDetailBuilder, type MonitorDetailBuilder } from './modules/monitors/monitorDetail.js';
import type { Clock } from './types/clock.js';
import { createAuthService, type AuthService } from './modules/auth/auth.service.js';
import { createAuditRepository } from './modules/audit/audit.repository.js';
import { createAuditService } from './modules/audit/audit.service.js';
import type { AuditService } from './modules/audit/audit.types.js';
import { createAlertDispatcher, type AlertDispatcher } from './modules/alerts/alerts.dispatcher.js';
import type { AlertsPort } from './modules/alerts/alerts.port.js';
import { createAlertsRepository } from './modules/alerts/alerts.repository.js';
import { createAlertsService, type AlertsService } from './modules/alerts/alerts.service.js';
import { createMailer, type Mailer } from './notifications/email/transport.js';
import type { CheckRunner } from './modules/checks/checkRunner.js';
import { createChecksRepository } from './modules/checks/checks.repository.js';
import { createChecksService, type ChecksService } from './modules/checks/checks.service.js';
import { createEndpointRunner } from './modules/endpointMonitors/endpointMonitors.runner.js';
import type { ProbeDeps } from './modules/endpointMonitors/httpProbe.js';
import { systemProbeDeps } from './modules/endpointMonitors/httpProbe.deps.js';
import { createIncidentsRepository } from './modules/incidents/incidents.repository.js';
import { createIncidentsService, type IncidentsService } from './modules/incidents/incidents.service.js';
import { createWebhookRunner } from './modules/webhookMonitors/webhookMonitors.runner.js';
import { createSourceDataService, type SourceDataService } from './modules/sourceData/sourceData.service.js';
import { createEndpointMonitorsRepository } from './modules/endpointMonitors/endpointMonitors.repository.js';
import {
  createEndpointMonitorsService,
  type EndpointMonitorsService,
} from './modules/endpointMonitors/endpointMonitors.service.js';
import { createWebhookMonitorsRepository } from './modules/webhookMonitors/webhookMonitors.repository.js';
import {
  createWebhookMonitorsService,
  type WebhookMonitorsService,
} from './modules/webhookMonitors/webhookMonitors.service.js';
import { createRecipientsRepository } from './modules/recipients/recipients.repository.js';
import { createRecipientsService, type RecipientsService } from './modules/recipients/recipients.service.js';
import { createUsersRepository } from './modules/users/users.repository.js';
import { createUsersService, type UsersService } from './modules/users/users.service.js';
import { createPasswordHasher, type PasswordHasher } from './utils/password.js';

export interface Services {
  audit: AuditService;
  users: UsersService;
  auth: AuthService;
  recipients: RecipientsService;
  sourceData: SourceDataService;
  webhookMonitors: WebhookMonitorsService;
  endpointMonitors: EndpointMonitorsService;
  checks: ChecksService;
  incidents: IncidentsService;
  alerts: AlertsService;
  dispatcher: AlertDispatcher;
  mailer: Mailer;
  /** One runner per monitor type, called by the scheduler (Phase 9). */
  runners: { WEBHOOK: CheckRunner; ENDPOINT: CheckRunner };
  scheduler: Scheduler;
  monitorActions: MonitorActionsService;
  dashboard: DashboardService;
  monitorDetail: MonitorDetailBuilder;
}

export interface ServiceDeps {
  config: Config;
  logger: Logger;
  monitorDb: Db;
  /** READ ONLY handle to the Source DB. Only modules/sourceData receives it. */
  sourceDb: Db;
  clock: Clock;
  /** Tests may replace the alerts port seen by the runners (to record calls). Production uses the real service. */
  alerts?: AlertsPort;
  /** Tests inject virtual timers to drive the scheduler without waiting. */
  timers?: Timers;
  /** Tests inject a fake mailer so nothing is ever sent. */
  mailer?: Mailer;
  /** Gates sending to the process that holds the scheduler lease (Phase 9). */
  canDispatch?: () => boolean;
  /** Tests inject a fake request/lookup; production uses node:http(s) with a vetting resolver (M3). */
  probeDeps?: ProbeDeps;
  /** Tests inject a low-cost hasher to stay fast. */
  hasher?: PasswordHasher;
}

/**
 * The one place that wires services together (TD-28). It grows each phase; the order here is
 * the order in docs/implementation_plans (Appendix E). Everything receives its dependencies
 * through factory arguments, so there is no DI container.
 */
export function buildServices(deps: ServiceDeps): Services {
  const { config, logger, monitorDb, clock } = deps;
  // Monitor services get this port now; the real scheduler is bound below (plan App. E, TD-28).
  const schedulerPort = createLateBoundSchedulerPort();
  const hasher = deps.hasher ?? createPasswordHasher(12);

  const audit: AuditService = createAuditService({ repo: createAuditRepository(monitorDb), clock });
  const users = createUsersService({ repo: createUsersRepository(monitorDb), audit, hasher, clock });
  const auth = createAuthService({ users, audit, clock, logger });
  const recipients = createRecipientsService({ repo: createRecipientsRepository(monitorDb), audit, clock });
  const sourceData = createSourceDataService({
    db: deps.sourceDb,
    queryTimeoutMs: config.sourceDb.queryTimeoutMs,
    clock,
  });
  const mailer = deps.mailer ?? createMailer(config.mail);
  const alertsRepo = createAlertsRepository(monitorDb);
  const dispatcher = createAlertDispatcher({
    repo: alertsRepo,
    mailer,
    clock,
    logger,
    settings: {
      pollMs: config.alerts.dispatcherPollMs,
      lockMs: config.alerts.dispatcherLockMs,
      retryBackoffMs: config.email.retryBackoffMs,
      sendTimeoutMs: config.alerts.sendTimeoutMs,
    },
    ...(deps.canDispatch ? { canRun: deps.canDispatch } : {}),
  });
  const checks = createChecksService({ repo: createChecksRepository(monitorDb), clock });
  const incidents = createIncidentsService({ repo: createIncidentsRepository(monitorDb), clock });
  const webhookMonitors = createWebhookMonitorsService({
    repo: createWebhookMonitorsRepository(monitorDb),
    sourceData,
    audit,
    scheduler: schedulerPort,
    incidents,
    clock,
    daysPerMonth: config.durations.daysPerMonth,
  });
  const endpointMonitors = createEndpointMonitorsService({
    repo: createEndpointMonitorsRepository(monitorDb),
    audit,
    scheduler: schedulerPort,
    incidents,
    clock,
    daysPerMonth: config.durations.daysPerMonth,
  });
  const alertsService = createAlertsService({
    repo: alertsRepo,
    incidents,
    recipients,
    audit,
    clock,
    logger,
    nudge: () => {
      dispatcher.nudge();
    },
    settings: {
      sourceErrorGroupWindowMs: config.alerts.sourceErrorGroupWindowMs,
      dashboardBaseUrl: config.dashboardBaseUrl,
      timeZone: config.display.timeZone,
    },
  });
  const alerts: AlertsPort = deps.alerts ?? alertsService;
  const runners = {
    WEBHOOK: createWebhookRunner({ monitors: webhookMonitors, sourceData, checks, alerts, clock, logger }),
    ENDPOINT: createEndpointRunner({
      monitors: endpointMonitors,
      checks,
      alerts,
      clock,
      logger,
      probeDeps: deps.probeDeps ?? systemProbeDeps,
      probeOptions: {
        retryDelayMs: config.endpoint.retryDelayMs,
        timeoutMs: config.endpoint.timeoutMs,
        maxRedirects: config.endpoint.maxRedirects,
      },
    }),
  };
  const toScheduled = (
    type: 'WEBHOOK' | 'ENDPOINT',
    m: { id: string; isEnabled: boolean; checkInterval: { ms: number }; state: { lastCheckAt: Date | null } },
  ): ScheduledMonitor => ({
    type,
    id: m.id,
    intervalMs: m.checkInterval.ms,
    lastCheckAt: m.state.lastCheckAt,
  });
  const scheduler = createScheduler({
    runners,
    loadEnabled: async () => [
      ...(await webhookMonitors.listEnabled()).map((m) => toScheduled('WEBHOOK', m)),
      ...(await endpointMonitors.listEnabled()).map((m) => toScheduled('ENDPOINT', m)),
    ],
    async load(type, id) {
      try {
        const monitor =
          type === 'WEBHOOK' ? await webhookMonitors.getById(id) : await endpointMonitors.getById(id);
        return monitor.isEnabled ? toScheduled(type, monitor) : null;
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
    onScheduled: (type, id, nextRunAt) =>
      (type === 'WEBHOOK' ? webhookMonitors : endpointMonitors).updateState(id, { nextCheckAt: nextRunAt }),
    clock,
    logger,
    ...(deps.timers ? { timers: deps.timers } : {}),
    settings: { concurrency: config.scheduler.concurrency, shutdownTimeoutMs: config.shutdownTimeoutMs },
  });
  schedulerPort.bind(scheduler);
  const monitorActions = createMonitorActionsService({
    webhookMonitors,
    endpointMonitors,
    scheduler,
    alerts: alertsService,
    checks,
    clock,
  });
  return {
    audit,
    users,
    auth,
    recipients,
    sourceData,
    webhookMonitors,
    endpointMonitors,
    checks,
    incidents,
    alerts: alertsService,
    dispatcher,
    mailer,
    runners,
    scheduler,
    monitorActions,
    dashboard: createDashboardService({
      webhookMonitors,
      endpointMonitors,
      incidents,
      alerts: alertsService,
      timeZone: config.display.timeZone,
    }),
    monitorDetail: createMonitorDetailBuilder({
      checks,
      incidents,
      alerts: alertsService,
      clock,
      timeZone: config.display.timeZone,
    }),
  };
}
