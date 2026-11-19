import { randomUUID } from 'node:crypto';
import { AUDIT_ACTION } from '../../constants/auditAction.js';
import { AUDIT_ENTITY_TYPE } from '../../constants/auditEntityType.js';
import { ConflictError, NotFoundError } from '../../errors/appError.js';
import type { Logger } from '../../logger/index.js';
import {
  buildAlertEmail,
  type AffectedMonitor,
  type AlertEmailSpec,
  type EmailContext,
  type EmailMonitor,
} from '../../notifications/email/templates/index.js';
import type { Clock } from '../../types/clock.js';
import type { Paginated } from '../../types/paginated.js';
import { formatHumanDuration } from '../../utils/duration.js';
import type { AuditActor, AuditService } from '../audit/audit.types.js';
import type { Check } from '../checks/checks.types.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { Incident } from '../incidents/incidents.types.js';
import type { RecipientsService } from '../recipients/recipients.service.js';
import type { RecipientAudience } from '../recipients/recipients.types.js';
import { alertTypeForResult, decideAlert, dedupeKey, type FailingResult } from './alert.policy.js';
import type { AlertsPort, MonitorSnapshot } from './alerts.port.js';
import type { AlertsRepository } from './alerts.repository.js';
import { toAlertDoc } from './alerts.mapper.js';
import type { Alert, AlertDoc, AlertListFilter, NewAlert } from './alerts.types.js';

export interface AlertsService extends AlertsPort {
  /** FR-D3: stores a sample TEST alert for the current recipients (status PENDING until sent). */
  sendTestEmail(monitor: MonitorSnapshot, actor: AuditActor): Promise<Alert>;
  /** FR-A2: FAILED -> PENDING. Throws ConflictError unless the alert is FAILED. */
  resend(alertId: string, actor: AuditActor): Promise<Alert>;
  listForMonitor(monitorId: string, limit?: number): Promise<Alert[]>;
  list(filter: AlertListFilter, page?: { cursor?: string; limit?: number }): Promise<Paginated<Alert>>;
  countFailed(): Promise<number>;
}

export interface AlertsServiceDeps {
  repo: AlertsRepository;
  incidents: Pick<
    IncidentsService,
    | 'findOpen'
    | 'open'
    | 'markAlerted'
    | 'close'
    | 'findOpenSourceError'
    | 'openSourceError'
    | 'addAffectedMonitor'
  >;
  recipients: Pick<RecipientsService, 'resolveAlertRecipients'>;
  audit: AuditService;
  clock: Clock;
  logger: Logger;
  /** Wakes the dispatcher so a new alert goes out at once instead of at the next poll. */
  nudge: () => void;
  settings: { sourceErrorGroupWindowMs: number; dashboardBaseUrl: string; timeZone: string };
  uuid?: () => string;
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const NO_RECIPIENTS = 'no recipients';

function toEmailMonitor(m: MonitorSnapshot): EmailMonitor {
  return {
    type: m.monitorType,
    id: m.monitorId,
    name: m.name,
    ...(m.gatewayName === undefined ? {} : { gatewayName: m.gatewayName }),
    ...(m.sourceCollection === undefined ? {} : { collection: m.sourceCollection }),
    ...(m.timestampKey === undefined ? {} : { timestampKey: m.timestampKey }),
    ...(m.url === undefined ? {} : { url: m.url }),
    ...(m.thresholdMs === undefined ? {} : { thresholdMs: m.thresholdMs }),
    checkIntervalMs: m.checkIntervalMs,
  };
}

function toSnapshotDoc(m: MonitorSnapshot): NonNullable<AlertDoc['oMonitorSnapshot']> {
  return {
    eMonitorType: m.monitorType,
    sName: m.name,
    nCheckIntervalMs: m.checkIntervalMs,
    eAlertMode: m.alertMode,
    ...(m.gatewayName === undefined ? {} : { sGatewayName: m.gatewayName }),
    ...(m.sourceCollection === undefined ? {} : { sSourceCollection: m.sourceCollection }),
    ...(m.timestampKey === undefined ? {} : { sTimestampKey: m.timestampKey }),
    ...(m.url === undefined ? {} : { sUrl: m.url }),
    ...(m.thresholdMs === undefined ? {} : { nThresholdMs: m.thresholdMs }),
    ...(m.repeatIntervalMs === undefined ? {} : { nRepeatIntervalMs: m.repeatIntervalMs }),
  };
}

function currentState(check: Check): string | undefined {
  if (check.webhook?.ageMs !== undefined) {
    return `The newest document is ${formatHumanDuration(check.webhook.ageMs)} old.`;
  }
  const last = check.endpoint?.attempts.at(-1);
  return last ? `The endpoint answered in ${last.responseTimeMs} ms.` : undefined;
}

export function createAlertsService(deps: AlertsServiceDeps): AlertsService {
  const { repo, incidents, recipients, audit, clock, logger, nudge, settings } = deps;
  const newUuid = deps.uuid ?? randomUUID;
  const ctx: EmailContext = { dashboardBaseUrl: settings.dashboardBaseUrl, timeZone: settings.timeZone };

  /**
   * Store first (FR-A1): the alert row exists, with its rendered email, before anything is sent.
   * No eligible recipient: the alert is still stored, as FAILED with the reason (FR-A5).
   */
  async function store(
    input: Omit<NewAlert, 'recipients' | 'subject' | 'textBody' | 'htmlBody'>,
    spec: AlertEmailSpec,
    audience: RecipientAudience,
  ): Promise<{ created: boolean; alert: Alert }> {
    const resolved = await recipients.resolveAlertRecipients(audience);
    const built = buildAlertEmail(spec, ctx);
    const doc = toAlertDoc(
      { ...input, recipients: resolved, subject: built.subject, textBody: built.text, htmlBody: built.html },
      resolved.length > 0
        ? { now: clock.now(), status: 'PENDING' }
        : { now: clock.now(), status: 'FAILED', failureReason: NO_RECIPIENTS },
    );
    const result = await repo.insert(doc);
    logger.info(
      {
        event: result.created ? 'alert.created' : 'alert.deduped',
        alertId: result.alert.id,
        type: input.type,
        monitorId: input.monitorId ?? undefined,
        recipientCount: resolved.length,
        dedupeKey: input.dedupeKey,
      },
      result.created ? 'Alert stored' : 'Alert already existed',
    );
    return result;
  }

  async function emitMonitorEmail(args: {
    monitor: MonitorSnapshot;
    check: Check;
    incident: Incident;
    email: NonNullable<ReturnType<typeof decideAlert>['email']>;
    now: Date;
  }): Promise<void> {
    const { monitor, check, incident, email, now } = args;
    const em = toEmailMonitor(monitor);
    const common = {
      incidentId: incident.id,
      checkId: check.id,
      monitorId: monitor.monitorId,
      snapshot: toSnapshotDoc(monitor),
      dueAt: now,
    };

    if (email.kind === 'RECOVERED') {
      const state = currentState(check);
      await store(
        { ...common, dedupeKey: dedupeKey.incidentRecovered(incident.id), type: 'RECOVERED' },
        {
          type: 'RECOVERED',
          monitor: em,
          openedAt: incident.openedAt,
          recoveredAt: now,
          downtimeMs: email.downtimeMs,
          ...(state === undefined ? {} : { currentState: state }),
        },
        'ALL',
      );
      return;
    }

    const failing = check.result as FailingResult;
    const reminder =
      email.kind === 'REMINDER'
        ? {
            number: email.reminderNumber,
            openForMs: Math.max(0, now.getTime() - incident.openedAt.getTime()),
          }
        : undefined;
    const key =
      email.kind === 'REMINDER'
        ? dedupeKey.incidentReminder(incident.id, email.reminderNumber)
        : monitor.alertMode === 'EVERY_CHECK'
          ? dedupeKey.everyCheck(check.id)
          : dedupeKey.incidentOpen(incident.id);
    const base = { ...common, dedupeKey: key, type: alertTypeForResult(failing) };
    const reminderPart = reminder ? { reminder } : {};

    let spec: AlertEmailSpec;
    if (failing === 'STALE') {
      spec = {
        type: 'WEBHOOK_STALE',
        monitor: em,
        ageMs: check.webhook?.ageMs ?? 0,
        checkedAt: check.finishedAt,
        ...(check.webhook?.lastDocId === undefined ? {} : { lastDocId: check.webhook.lastDocId }),
        ...(check.webhook?.lastDocTimestamp === undefined
          ? {}
          : { lastDocTimestamp: check.webhook.lastDocTimestamp }),
        ...reminderPart,
      };
    } else if (failing === 'ERROR') {
      spec = {
        type: 'MONITOR_CHECK_ERROR',
        monitor: em,
        errorCode: check.error?.code ?? 'SOURCE_QUERY_FAILED',
        errorMessage: check.error?.message ?? 'The collection could not be read',
        checkedAt: check.finishedAt,
        ...reminderPart,
      };
    } else if (failing === 'NO_DATA') {
      spec = {
        type: 'WEBHOOK_NO_DATA',
        monitor: em,
        reason: check.webhook?.reason ?? 'MISSING',
        checkedAt: check.finishedAt,
        ...(check.webhook?.lastDocId === undefined ? {} : { lastDocId: check.webhook.lastDocId }),
        ...reminderPart,
      };
    } else {
      spec = {
        type: 'ENDPOINT_DOWN',
        monitor: em,
        attempts: check.endpoint?.attempts ?? [],
        checkedAt: check.finishedAt,
        ...reminderPart,
      };
    }
    await store(base, spec, 'ALL');
    // Only after the alert is stored: a crash in between re-creates the same alert (dedupe key).
    await incidents.markAlerted(incident.id, now, reminder?.number);
  }

  const affectedFor = (
    list: { monitorId: string; name: string; monitorType: 'WEBHOOK' | 'ENDPOINT' }[],
  ): AffectedMonitor[] => list.map((m) => ({ id: m.monitorId, name: m.name, type: m.monitorType }));

  async function mergeAffected(
    alert: Alert,
    joining: { monitorId: string; name: string; monitorType: 'WEBHOOK' | 'ENDPOINT' },
    incident: Incident,
    error: { code: string; message: string },
  ): Promise<void> {
    // Already sent (or being sent): the incident still lists the monitor, but no second email goes out.
    if (alert.status !== 'PENDING') return;
    // Review M2: join atomically, then render from the list as stored after OUR change.
    const affected = await repo.addAffectedToPending(alert.id, clock.now(), joining);
    if (!affected) return;
    const built = buildAlertEmail(
      {
        type: 'MONITOR_ERROR',
        firstErrorAt: incident.openedAt,
        errorCode: error.code,
        errorMessage: error.message,
        affected: affectedFor(affected),
      },
      ctx,
    );
    // Skipped when another monitor joined meanwhile: its render (with a longer list) is the one kept.
    await repo.updatePendingContent(alert.id, clock.now(), {
      subject: built.subject,
      textBody: built.text,
      htmlBody: built.html,
      affectedCount: affected.length,
    });
  }

  async function handleSourceHealthy(): Promise<void> {
    const incident = await incidents.findOpenSourceError();
    if (!incident) return;
    const now = clock.now();
    const openAlert = await repo.findByDedupeKey(dedupeKey.sourceErrorOpen(incident.id));
    // If the outage mail is still waiting for its grouping window, send it first so the order is right.
    if (openAlert) await repo.expedite(openAlert.id, now);
    const affected = openAlert ? await repo.findAffectedMonitors(openAlert.id) : [];
    await store(
      {
        dedupeKey: dedupeKey.sourceErrorRecovered(incident.id),
        type: 'RECOVERED',
        monitorId: null,
        incidentId: incident.id,
        checkId: null,
        snapshot: null,
        dueAt: new Date(now.getTime() + 1),
      },
      {
        type: 'RECOVERED_SOURCE',
        openedAt: incident.openedAt,
        recoveredAt: now,
        downtimeMs: Math.max(0, now.getTime() - incident.openedAt.getTime()),
        affected: affectedFor(affected),
      },
      'MASTERS_ONLY',
    );
    // Close only after the RECOVERED alert is stored (plan 4.6).
    await incidents.close(incident.id, 'RECOVERED');
    logger.info(
      { event: 'incident.closed', incidentId: incident.id, kind: 'SOURCE_ERROR' },
      'Source outage ended',
    );
  }

  return {
    async processCheckOutcome({ monitor, check }) {
      const now = clock.now();
      // A webhook check that READ the source proves the source is back. A monitor's own error does
      // not count: it must never end an outage (and never another monitor's incident, TD-29).
      if (monitor.monitorType === 'WEBHOOK' && check.result !== 'ERROR') await handleSourceHealthy();

      let incident = await incidents.findOpen(monitor.monitorId);
      const decision = decideAlert({
        result: check.result,
        openIncident: incident
          ? {
              openedAt: incident.openedAt,
              lastAlertAt: incident.lastAlertAt,
              reminderCount: incident.reminderCount,
            }
          : null,
        alertMode: monitor.alertMode,
        repeatIntervalMs: monitor.repeatIntervalMs ?? null,
        now,
      });

      if (decision.incident === 'OPEN') {
        incident = await incidents.open({
          monitorId: monitor.monitorId,
          openingResult: check.result,
          checkId: check.id,
        });
        logger.warn(
          {
            event: 'incident.opened',
            incidentId: incident.id,
            monitorId: monitor.monitorId,
            kind: 'MONITOR',
          },
          'Incident opened',
        );
      }
      if (decision.email && incident) {
        await emitMonitorEmail({ monitor, check, incident, email: decision.email, now });
      }
      if (decision.incident === 'CLOSE' && incident) {
        await incidents.close(incident.id, 'RECOVERED');
        logger.info(
          {
            event: 'incident.closed',
            incidentId: incident.id,
            monitorId: monitor.monitorId,
            kind: 'MONITOR',
            reason: 'RECOVERED',
            durationMs: now.getTime() - incident.openedAt.getTime(),
          },
          'Incident closed',
        );
      }
      nudge();
      const stillOpen = decision.incident === 'OPEN' || decision.incident === 'KEEP';
      return { openIncidentId: stillOpen && incident ? incident.id : null };
    },

    async handleSourceError({ monitor, check }) {
      let incident = await incidents.findOpenSourceError();
      if (!incident) {
        incident = await incidents.openSourceError({
          affectedMonitorIds: [monitor.monitorId],
          checkId: check.id,
        });
      }
      if (!incident.affectedMonitorIds.includes(monitor.monitorId)) {
        incident = (await incidents.addAffectedMonitor(incident.id, monitor.monitorId)) ?? incident;
      }
      logger.warn(
        { event: 'sourceOutage.joined', incidentId: incident.id, monitorId: monitor.monitorId },
        'Monitor affected by source outage',
      );

      const joining = { monitorId: monitor.monitorId, name: monitor.name, monitorType: monitor.monitorType };
      const error = {
        code: check.error?.code ?? 'SOURCE_UNAVAILABLE',
        message: check.error?.message ?? 'The source database could not be read',
      };
      const key = dedupeKey.sourceErrorOpen(incident.id);
      const existing = await repo.findByDedupeKey(key);
      if (existing) {
        await mergeAffected(existing, joining, incident, error);
      } else {
        // FR-A4a: masters only; the first email waits for the grouping window so affected monitors share it.
        const { created, alert } = await store(
          {
            dedupeKey: key,
            type: 'MONITOR_ERROR',
            monitorId: null,
            incidentId: incident.id,
            checkId: check.id,
            snapshot: null,
            affectedMonitors: [joining],
            dueAt: new Date(incident.openedAt.getTime() + settings.sourceErrorGroupWindowMs),
          },
          {
            type: 'MONITOR_ERROR',
            firstErrorAt: incident.openedAt,
            errorCode: error.code,
            errorMessage: error.message,
            affected: affectedFor([joining]),
          },
          'MASTERS_ONLY',
        );
        // Lost a creation race with another monitor: join the alert that won.
        if (!created) await mergeAffected(alert, joining, incident, error);
      }
      nudge();
    },

    async sendTestEmail(monitor, actor) {
      const { alert } = await store(
        {
          dedupeKey: dedupeKey.test(newUuid()),
          type: 'TEST',
          monitorId: monitor.monitorId,
          incidentId: null,
          checkId: null,
          snapshot: toSnapshotDoc(monitor),
          dueAt: clock.now(),
        },
        { type: 'TEST', monitor: toEmailMonitor(monitor), requestedBy: actor.email, at: clock.now() },
        'ALL',
      );
      nudge();
      return alert;
    },

    async resend(alertId, actor) {
      const existing = await repo.findById(alertId);
      if (!existing) throw new NotFoundError('Alert not found');
      if (existing.status !== 'FAILED') throw new ConflictError('Only failed alerts can be resent');

      // D18: keep the stored recipients (FR-A5) unless there were none; then look again.
      let fresh: Awaited<ReturnType<RecipientsService['resolveAlertRecipients']>> | undefined;
      if (existing.recipients.length === 0) {
        fresh = await recipients.resolveAlertRecipients(existing.monitorId === null ? 'MASTERS_ONLY' : 'ALL');
        if (fresh.length === 0)
          throw new ConflictError('There are still no recipients to send this alert to');
      }
      const requeued = await repo.requeueFailed(alertId, clock.now(), fresh);
      if (!requeued) throw new ConflictError('Only failed alerts can be resent');
      await audit.record({
        actor,
        action: AUDIT_ACTION.RESEND,
        entityType: AUDIT_ENTITY_TYPE.ALERT,
        entityId: alertId,
        before: { status: 'FAILED', type: existing.type },
        after: { status: 'PENDING', type: existing.type },
      });
      logger.info({ event: 'alert.resend', alertId, actorUserId: actor.id }, 'Alert queued for resend');
      nudge();
      return requeued;
    },

    listForMonitor: (monitorId, limit = DEFAULT_PAGE) =>
      repo.listForMonitor(monitorId, Math.min(limit, MAX_PAGE)),
    list(filter, page = {}) {
      const limit = Math.min(Math.max(page.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
      return repo.list(filter, { ...(page.cursor ? { cursor: page.cursor } : {}), limit });
    },
    countFailed: () => repo.countFailed(),
  };
}
