import type { RequestHandler } from 'express';
import { ALERT_STATUS } from '../../constants/alertStatus.js';
import { ALERT_TYPE } from '../../constants/alertType.js';
import { renderPage } from '../../utils/renderPage.js';
import { alertListValidation } from './alerts.schemas.js';
import type { AlertsService } from './alerts.service.js';
import type { AlertListFilter } from './alerts.types.js';
import { toAlertRowView } from './alerts.view.js';

export interface AlertsPageController {
  list: RequestHandler;
}

const PAGE_SIZE = 50;

export function createAlertsPageController(deps: {
  alerts: Pick<AlertsService, 'list'>;
  /** Monitor names for the filter. Passed in so `alerts` never imports the monitor modules. */
  monitorOptions: () => Promise<{ id: string; name: string }[]>;
  timeZone: string;
}): AlertsPageController {
  return {
    async list(req, res) {
      const { query } = alertListValidation.read(res);
      const filter: AlertListFilter = {
        ...(query.monitorId ? { monitorId: query.monitorId } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.from ? { from: new Date(`${query.from}T00:00:00.000Z`) } : {}),
        ...(query.to ? { to: new Date(`${query.to}T23:59:59.999Z`) } : {}),
      };
      const page = await deps.alerts.list(filter, {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: PAGE_SIZE,
      });
      const canResend = req.user?.role === 'ADMIN';
      const filters = {
        monitorId: query.monitorId ?? '',
        type: query.type ?? '',
        status: query.status ?? '',
        from: query.from ?? '',
        to: query.to ?? '',
      };
      const older = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value) older.set(key, value);
      if (page.nextCursor) older.set('cursor', page.nextCursor);
      await renderPage(res, 'pages/alerts/list', {
        pageTitle: 'Alerts',
        scripts: canResend ? ['/public/js/alertActions.js'] : [],
        rows: page.items.map((a) => toAlertRowView(a, { timeZone: deps.timeZone, canResend })),
        filters,
        options: {
          monitors: await deps.monitorOptions(),
          types: Object.values(ALERT_TYPE),
          statuses: Object.values(ALERT_STATUS),
        },
        olderHref: page.nextCursor ? `?${older.toString()}` : undefined,
      });
    },
  };
}
