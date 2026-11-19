import type { RequestHandler, Response } from 'express';
import { AppError } from '../../errors/appError.js';
import { ERROR_CODE } from '../../errors/errorCodes.js';
import type { AuthUser } from '../../types/express.js';
import type { MonitorDetailBuilder } from '../monitors/monitorDetail.js';
import { setFlash } from '../../utils/flash.js';
import { renderPage } from '../../utils/renderPage.js';
import { ALERT_MODE_OPTIONS, DURATION_UNIT_OPTIONS } from '../webhookMonitors/webhookMonitors.view.js';
import type { EndpointMonitorValidations } from './endpointMonitors.schemas.js';
import type { EndpointMonitorsService } from './endpointMonitors.service.js';
import {
  endpointFormDefaults,
  toEndpointDetailView,
  toEndpointFormValues,
  toEndpointRowView,
} from './endpointMonitors.view.js';

export interface EndpointMonitorsController {
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

function errorsFrom(err: AppError): Record<string, string> {
  const details = err.details;
  const field =
    typeof details === 'object' && details !== null && 'field' in details && typeof details.field === 'string'
      ? details.field
      : '_form';
  return { [field]: err.message };
}

export function createEndpointMonitorsController(deps: {
  monitors: EndpointMonitorsService;
  detail: MonitorDetailBuilder;
  validations: EndpointMonitorValidations;
  timeZone: string;
  defaultRetryCount: number;
  maxRetryCount: number;
}): EndpointMonitorsController {
  const { monitors, detail, validations, timeZone } = deps;

  function renderForm(
    res: Response,
    model: {
      mode: 'create' | 'edit';
      id?: string;
      values: Record<string, unknown>;
      errors: Record<string, string>;
    },
    status = 200,
  ): Promise<void> {
    return renderPage(
      res,
      'pages/endpointMonitors/form',
      {
        pageTitle: model.mode === 'create' ? 'New endpoint monitor' : 'Edit endpoint monitor',
        scripts: ['/public/js/monitorForm.js'],
        alertModes: ALERT_MODE_OPTIONS,
        units: DURATION_UNIT_OPTIONS,
        maxRetryCount: deps.maxRetryCount,
        ...model,
      },
      status,
    );
  }

  const isFormError = (err: unknown): err is AppError =>
    err instanceof AppError && err.code === ERROR_CODE.CONFLICT;

  return {
    async list(_req, res) {
      const rows = (await monitors.list()).map((m) => toEndpointRowView(m, timeZone));
      await renderPage(res, 'pages/endpointMonitors/list', { pageTitle: 'Endpoint monitors', rows });
    },

    async newForm(_req, res) {
      await renderForm(res, {
        mode: 'create',
        values: endpointFormDefaults(deps.defaultRetryCount),
        errors: {},
      });
    },

    async create(req, res) {
      const failure = validations.create.formFailure(res);
      if (failure) {
        await renderForm(res, { mode: 'create', values: failure.values, errors: failure.errors }, 400);
        return;
      }
      const { body } = validations.create.read(res);
      try {
        const monitor = await monitors.create(body, actorOf(req.user));
        setFlash(req, 'success', `Monitor "${monitor.serverName}" created`);
        res.redirect(303, '/endpoint-monitors');
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
      const monitor = await monitors.getById(params.id);
      const isAdmin = req.user?.role === 'ADMIN';
      const extras = await detail.build({
        type: 'ENDPOINT',
        monitorId: monitor.id,
        query,
        canResend: isAdmin,
      });
      await renderPage(res, 'pages/endpointMonitors/detail', {
        pageTitle: monitor.serverName,
        monitor: toEndpointDetailView(monitor, timeZone),
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
        values: toEndpointFormValues(monitor),
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
        const monitor = await monitors.update(params.id, body, actorOf(req.user));
        setFlash(req, 'success', `Monitor "${monitor.serverName}" updated`);
        res.redirect(303, `/endpoint-monitors/${monitor.id}`);
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
      await monitors.remove(params.id, actorOf(req.user));
      setFlash(req, 'success', 'Monitor deleted. Its history is kept.');
      res.redirect(303, '/endpoint-monitors');
    },
  };
}
