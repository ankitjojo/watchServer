import type { RequestHandler } from 'express';
import type { AuthUser } from '../../types/express.js';
import { sendData } from '../../utils/response.js';
import { actionValidation, checksValidation, seriesValidation } from './monitorActions.schemas.js';
import type { MonitorActionsService } from './monitorActions.service.js';
import { toCheckView } from './monitorActions.view.js';

export interface MonitorActionsController {
  run: RequestHandler;
  pause: RequestHandler;
  resume: RequestHandler;
  testEmail: RequestHandler;
  checks: RequestHandler;
  series: RequestHandler;
}

function actorOf(user: AuthUser | undefined): { id: string; email: string } {
  // requireAuth ran before this controller, so a user is always present.
  if (!user) throw new Error('authenticated user missing');
  return { id: user.id, email: user.email };
}

export function createMonitorActionsController(deps: {
  actions: MonitorActionsService;
  timeZone: string;
}): MonitorActionsController {
  const { actions, timeZone } = deps;
  return {
    async run(_req, res) {
      const { params } = actionValidation.read(res);
      const check = await actions.run(params.type, params.id);
      sendData(res, toCheckView(check, timeZone));
    },

    async pause(req, res) {
      const { params } = actionValidation.read(res);
      sendData(res, await actions.pause(params.type, params.id, actorOf(req.user)));
    },

    async resume(req, res) {
      const { params } = actionValidation.read(res);
      sendData(res, await actions.resume(params.type, params.id, actorOf(req.user)));
    },

    async testEmail(req, res) {
      const { params } = actionValidation.read(res);
      const alert = await actions.testEmail(params.type, params.id, actorOf(req.user));
      // 202: stored and queued, not sent yet.
      sendData(res, { alertId: alert.id, status: 'queued' }, { status: 202 });
    },

    async checks(_req, res) {
      const { params, query } = checksValidation.read(res);
      const page = await actions.listChecks(
        params.type,
        params.id,
        {
          ...(query.result ? { result: query.result } : {}),
          ...(query.from ? { from: query.from } : {}),
          ...(query.to ? { to: query.to } : {}),
        },
        { ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.limit ? { limit: query.limit } : {}) },
      );
      sendData(
        res,
        page.items.map((c) => toCheckView(c, timeZone)),
        {
          ...(page.nextCursor ? { meta: { nextCursor: page.nextCursor } } : {}),
        },
      );
    },

    async series(_req, res) {
      const { params, query } = seriesValidation.read(res);
      const result = await actions.series(params.type, params.id, query);
      sendData(res, {
        points: result.points.map((p) => ({
          t: p.t.toISOString(),
          value: p.value,
          ...(p.isUp === undefined ? {} : { isUp: p.isUp }),
        })),
        ...(result.thresholdMs === undefined ? {} : { thresholdMs: result.thresholdMs }),
      });
    },
  };
}
