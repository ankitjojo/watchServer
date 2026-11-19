import { Router } from 'express';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { renderPage } from '../../utils/renderPage.js';
import type { DashboardService } from './dashboard.service.js';

/** FR-D1: the overview page. Any logged-in user (viewers included). */
export function createDashboardRouter(deps: { dashboard: DashboardService }): Router {
  const router = Router();
  router.get('/', requireAuth, async (_req, res) => {
    await renderPage(res, 'pages/dashboard/overview', {
      pageTitle: 'Overview',
      overview: await deps.dashboard.overview(),
    });
  });
  return router;
}
