import type { RequestHandler } from 'express';
import type { AuthUser } from '../../types/express.js';
import { sendData } from '../../utils/response.js';
import { alertIdValidation } from './alerts.schemas.js';
import type { AlertsService } from './alerts.service.js';

export interface AlertsController {
  resend: RequestHandler;
}

function actorOf(user: AuthUser | undefined): { id: string; email: string } {
  // requireRole ran before this controller, so a user is always present.
  if (!user) throw new Error('authenticated user missing');
  return { id: user.id, email: user.email };
}

export function createAlertsController(deps: { alerts: AlertsService }): AlertsController {
  return {
    async resend(req, res) {
      const { params } = alertIdValidation.read(res);
      await deps.alerts.resend(params.id, actorOf(req.user));
      // 202: queued, not sent. "Sent" only after the mail server accepted it (api-standards 2).
      sendData(res, { status: 'queued' }, { status: 202 });
    },
  };
}
