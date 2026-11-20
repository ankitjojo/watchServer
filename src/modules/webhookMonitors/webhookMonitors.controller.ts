import type { RequestHandler, Response } from 'express';
import { AppError, ExternalServiceError } from '../../errors/appError.js';
import { ERROR_CODE } from '../../errors/errorCodes.js';
import type { AuthUser } from '../../types/express.js';
import type { MonitorDetailBuilder } from '../monitors/monitorDetail.js';
import { setFlash } from '../../utils/flash.js';
import { renderPage } from '../../utils/renderPage.js';
import type { SourceDataService } from '../sourceData/sourceData.service.js';
import type { WebhookMonitorValidations } from './webhookMonitors.schemas.js';
import type { WebhookMonitorsService } from './webhookMonitors.service.js';
import type { SaveResult } from './webhookMonitors.types.js';
import {
  ALERT_MODE_OPTIONS,
  DURATION_UNIT_OPTIONS,
  WEBHOOK_FORM_DEFAULTS,
  toWebhookDeletedRow,
  toWebhookDetailView,
  WEBHOOK_DELETED_COLUMNS,
  toWebhookFormValues,
  toWebhookRowView,
} from './webhookMonitors.view.js';

export interface WebhookMonitorsController {
  list: RequestHandler;
  newForm: RequestHandler;
  create: RequestHandler;
  detail: RequestHandler;
  editForm: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
}

function actorOf(user: AuthUser | undefined): { id: string; email: string } {
  // requireAuth ran before this controller, so a user is always present.
  if (!user) throw new Error('authenticated user missing');
  return { id: user.id, email: user.email };
}

/** Field-level errors carried by service errors (`details.field`), else a form-level message. */
function errorsFrom(err: AppError): Record<string, string> {
  const details = err.details;
  const field =
    typeof details === 'object' && details !== null && 'field' in details && typeof details.field === 'string'
      ? details.field
      : '_form';
  return { [field]: err.message };
}

export function createWebhookMonitorsController(deps: {
  monitors: WebhookMonitorsService;
  sourceData: Pick<SourceDataService, 'listCollections'>;
  detail: MonitorDetailBuilder;
  validations: WebhookMonitorValidations;
  timeZone: string;
}): WebhookMonitorsController {
  const { monitors, detail, sourceData, validations, timeZone } = deps;

  async function collectionsOrEmpty(): Promise<string[]> {
    try {
      return await sourceData.listCollections();
    } catch (err) {
      // The Source DB being down must not block the page; the admin can type the name.
      if (err instanceof ExternalServiceError) return [];
      throw err;
    }
  }

  async function renderForm(
    res: Response,
    model: {
      mode: 'create' | 'edit';
      id?: string;
      values: Record<string, unknown>;
      errors: Record<string, string>;
    },
    status = 200,
  ): Promise<void> {
    await renderPage(
      res,
      'pages/webhookMonitors/form',
      {
        pageTitle: model.mode === 'create' ? 'New webhook monitor' : 'Edit webhook monitor',
        scripts: ['/public/js/monitorForm.js'],
        collections: await collectionsOrEmpty(),
        alertModes: ALERT_MODE_OPTIONS,
        units: DURATION_UNIT_OPTIONS,
        ...model,
      },
      status,
    );
  }

  function flashResult(req: Parameters<RequestHandler>[0], result: SaveResult, verb: string): void {
    setFlash(req, 'success', `Monitor "${result.monitor.name}" ${verb}`);
    for (const warning of result.warnings) setFlash(req, 'warning', warning);
  }

  const isFormError = (err: unknown): err is AppError =>
    err instanceof AppError &&
    (err.code === ERROR_CODE.VALIDATION_FAILED ||
      err.code === ERROR_CODE.CONFLICT ||
      err.code === ERROR_CODE.EXTERNAL_SERVICE_ERROR);

  return {
    async list(_req, res) {
      const [live, deleted] = await Promise.all([monitors.list(), monitors.listDeleted()]);
      await renderPage(res, 'pages/webhookMonitors/list', {
        pageTitle: 'Webhook monitors',
        rows: live.map((m) => toWebhookRowView(m, timeZone)),
        deletedRows: deleted.map((m) => toWebhookDeletedRow(m, timeZone)),
        deletedColumns: WEBHOOK_DELETED_COLUMNS,
      });
    },

    async newForm(_req, res) {
      await renderForm(res, { mode: 'create', values: WEBHOOK_FORM_DEFAULTS, errors: {} });
    },

    async create(req, res) {
      const failure = validations.create.formFailure(res);
      if (failure) {
        await renderForm(res, { mode: 'create', values: failure.values, errors: failure.errors }, 400);
        return;
      }
      const { body } = validations.create.read(res);
      try {
        flashResult(req, await monitors.create(body, actorOf(req.user)), 'created');
        res.redirect(303, '/webhook-monitors');
      } catch (err) {
        if (isFormError(err)) {
          await renderForm(
            res,
            { mode: 'create', values: { ...body }, errors: errorsFrom(err) },
            err.httpStatus,
          );
          return;
        }
        throw err;
      }
    },

    async detail(req, res) {
      const { params, query } = validations.detail.read(res);
      // Deleted monitors stay readable here, but nothing on the page can act on them.
      const monitor = await monitors.getByIdIncludingDeleted(params.id);
      const isAdmin = req.user?.role === 'ADMIN' && monitor.deletedAt === null;
      const extras = await detail.build({
        type: 'WEBHOOK',
        monitorId: monitor.id,
        query,
        canResend: isAdmin,
        thresholdMs: monitor.threshold.ms,
      });
      await renderPage(res, 'pages/webhookMonitors/detail', {
        pageTitle: monitor.name,
        monitor: toWebhookDetailView(monitor, timeZone),
        extras,
        can: { edit: isAdmin },
        scripts: [
          '/vendor/chart.js/chart.umd.js',
          '/public/js/charts.js',
          '/public/js/alertActions.js',
          ...(isAdmin ? ['/public/js/monitorActions.js'] : []),
        ],
      });
    },

    async editForm(_req, res) {
      const { params } = validations.id.read(res);
      const monitor = await monitors.getById(params.id);
      await renderForm(res, {
        mode: 'edit',
        id: monitor.id,
        values: toWebhookFormValues(monitor),
        errors: {},
      });
    },

    async update(req, res) {
      const failure = validations.update.formFailure(res);
      if (failure) {
        const id = typeof req.params['id'] === 'string' ? req.params['id'] : undefined;
        await renderForm(
          res,
          {
            mode: 'edit',
            ...(id === undefined ? {} : { id }),
            values: failure.values,
            errors: failure.errors,
          },
          400,
        );
        return;
      }
      const { params, body } = validations.update.read(res);
      try {
        const result = await monitors.update(params.id, body, actorOf(req.user));
        flashResult(req, result, 'updated');
        res.redirect(303, `/webhook-monitors/${result.monitor.id}`);
      } catch (err) {
        if (isFormError(err)) {
          await renderForm(
            res,
            { mode: 'edit', id: params.id, values: { ...body }, errors: errorsFrom(err) },
            err.httpStatus,
          );
          return;
        }
        throw err;
      }
    },

    async remove(req, res) {
      const { params } = validations.id.read(res);
      const removed = await monitors.remove(params.id, actorOf(req.user));
      setFlash(
        req,
        'success',
        `Monitor "${removed.name}" stopped and moved to Deleted records. Its history is kept.`,
      );
      res.redirect(303, '/webhook-monitors');
    },
  };
}
