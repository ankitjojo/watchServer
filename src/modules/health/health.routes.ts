import { Router } from 'express';

export interface HealthProbes {
  monitorDbPing(): Promise<boolean>;
  sourceDbPing(): Promise<boolean>;
  schedulerState(): 'leader' | 'standby' | 'stopped';
}

/** Ops endpoints: no auth, no secrets, no hostnames (api-standards, error-handling rules). */
export function createHealthRouter(probes: HealthProbes): Router {
  const router = Router();
  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  router.get('/readyz', async (_req, res) => {
    const [monitorDb, sourceDb] = await Promise.all([probes.monitorDbPing(), probes.sourceDbPing()]);
    // Without the Monitor DB we cannot store alerts, so we are not ready. A down Source DB is
    // reported but does not make us unready: it is handled as a MONITOR_ERROR (FR-A4a).
    res.status(monitorDb ? 200 : 503).json({
      status: monitorDb ? 'ready' : 'not_ready',
      monitorDb: monitorDb ? 'up' : 'down',
      sourceDb: sourceDb ? 'up' : 'down',
      scheduler: probes.schedulerState(),
    });
  });
  return router;
}
