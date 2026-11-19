import path from 'node:path';
import express, { type Express } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './config/loadConfig.js';
import type { Logger } from './logger/index.js';
import { csrfProtection, exposeCsrfToken } from './middlewares/csrf.js';
import { createErrorHandler } from './middlewares/errorHandler.js';
import { createLoadCurrentUser } from './middlewares/loadCurrentUser.js';
import { noStore } from './middlewares/noStore.js';
import { notFound } from './middlewares/notFound.js';
import { createActionLimiter, createLoginLimiters } from './middlewares/rateLimit.js';
import { requestContext } from './middlewares/requestContext.js';
import { createAlertsController } from './modules/alerts/alerts.controller.js';
import { createAlertsApiRouter } from './modules/alerts/alerts.routes.js';
import type { AlertsService } from './modules/alerts/alerts.service.js';
import { createMonitorActionsController } from './modules/monitors/monitorActions.controller.js';
import { createMonitorActionsRouter } from './modules/monitors/monitorActions.routes.js';
import type { MonitorActionsService } from './modules/monitors/monitorActions.service.js';
import { createAuthController } from './modules/auth/auth.controller.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import type { AuthService } from './modules/auth/auth.service.js';
import { createDashboardRouter } from './modules/dashboard/dashboard.routes.js';
import type { DashboardService } from './modules/dashboard/dashboard.service.js';
import { createAlertsPageController } from './modules/alerts/alerts.pages.controller.js';
import { createAlertsPageRouter } from './modules/alerts/alerts.pages.routes.js';
import type { MonitorDetailBuilder } from './modules/monitors/monitorDetail.js';
import { createHealthRouter, type HealthProbes } from './modules/health/health.routes.js';
import { createRecipientsController } from './modules/recipients/recipients.controller.js';
import { createRecipientsRouter } from './modules/recipients/recipients.routes.js';
import type { RecipientsService } from './modules/recipients/recipients.service.js';
import { createSourceDataController } from './modules/sourceData/sourceData.controller.js';
import { createSourceDataRouter } from './modules/sourceData/sourceData.routes.js';
import type { SourceDataService } from './modules/sourceData/sourceData.service.js';
import { createWebhookMonitorsController } from './modules/webhookMonitors/webhookMonitors.controller.js';
import { createWebhookMonitorsRouter } from './modules/webhookMonitors/webhookMonitors.routes.js';
import { createWebhookMonitorValidations } from './modules/webhookMonitors/webhookMonitors.schemas.js';
import type { WebhookMonitorsService } from './modules/webhookMonitors/webhookMonitors.service.js';
import { createEndpointMonitorsController } from './modules/endpointMonitors/endpointMonitors.controller.js';
import { createEndpointMonitorsRouter } from './modules/endpointMonitors/endpointMonitors.routes.js';
import { createEndpointMonitorValidations } from './modules/endpointMonitors/endpointMonitors.schemas.js';
import type { EndpointMonitorsService } from './modules/endpointMonitors/endpointMonitors.service.js';
import { createUsersController } from './modules/users/users.controller.js';
import { createUsersRouter } from './modules/users/users.routes.js';
import type { UsersService } from './modules/users/users.service.js';
import { consumeFlash } from './utils/flash.js';
import { maskUrl } from './utils/maskUrl.js';
import './types/express.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  auth: AuthService;
  users: UsersService;
  recipients: RecipientsService;
  sourceData: SourceDataService;
  webhookMonitors: WebhookMonitorsService;
  endpointMonitors: EndpointMonitorsService;
  alerts: AlertsService;
  monitorActions: MonitorActionsService;
  dashboard: DashboardService;
  monitorDetail: MonitorDetailBuilder;
  health: HealthProbes;
  /** connect-mongo in production; tests use the default in-memory store. */
  sessionStore?: session.Store;
}

const SRC_DIR = import.meta.dirname;

/** Express app factory (no listen), so tests can drive it with supertest. */
export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  // Never `true` blindly (api-standards 6): trust exactly the configured number of proxy hops.
  app.set('trust proxy', config.http.trustProxyHops > 0 ? config.http.trustProxyHops : false);
  app.set('view engine', 'ejs');
  app.set('views', path.join(SRC_DIR, 'views'));

  app.use(requestContext);
  // The product name people see (APP_NAME). Set first so even early errors (CSRF, bad session) can render
  // an error page; views print it with <%= %>, so it is escaped.
  app.use((req, res, next) => {
    res.locals.appName = config.appName;
    // Lets the nav mark the current section (the path only, never the query string).
    res.locals.currentPath = req.path;
    next();
  });
  // Ops endpoints need no session and no logging noise.
  app.use(createHealthRouter(deps.health));

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url.startsWith('/public') },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          // Query values can hold tokens: mask them.
          url: maskUrl(new URL(req.url, 'http://x').toString()).replace('http://x', ''),
        }),
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'same-origin' },
      hsts: config.env === 'production',
    }),
  );

  app.use(express.urlencoded({ extended: true, limit: '50kb' }));
  app.use(express.json({ limit: '50kb' }));

  // Static assets. Chart.js is served locally so CSP can stay `script-src 'self'` (TD-13).
  const staticOptions = { maxAge: config.env === 'production' ? '7d' : 0 };
  app.use('/public', express.static(path.join(SRC_DIR, 'public'), staticOptions));
  // src/ and dist/ both sit one level below the project root, where node_modules lives.
  const chartDist = path.resolve(SRC_DIR, '..', 'node_modules', 'chart.js', 'dist');
  app.use('/vendor/chart.js', express.static(chartDist, staticOptions));
  // Bootstrap: CSS only (no JS), so CSP stays `script-src 'self'` and `style-src 'self'`.
  const bootstrapCss = path.resolve(SRC_DIR, '..', 'node_modules', 'bootstrap', 'dist', 'css');
  app.use('/vendor/bootstrap', express.static(bootstrapCss, staticOptions));

  app.use(
    session({
      name: 'pm.sid',
      secret: config.session.secret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      ...(deps.sessionStore ? { store: deps.sessionStore } : {}),
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.env === 'production',
        maxAge: config.session.maxAgeMs,
      },
    }),
  );

  app.use(noStore);
  app.use(csrfProtection);
  app.use(exposeCsrfToken);
  app.use(createLoadCurrentUser((id) => deps.auth.resolveSessionUser(id)));
  app.use((req, res, next) => {
    res.locals.flash = consumeFlash(req);
    next();
  });

  app.use(
    createAuthRouter({
      controller: createAuthController({ auth: deps.auth }),
      loginLimiters: createLoginLimiters(config.rateLimit.login),
    }),
  );
  app.use(createDashboardRouter({ dashboard: deps.dashboard }));
  app.use(
    '/users',
    createUsersRouter(createUsersController({ users: deps.users, timeZone: config.display.timeZone })),
  );

  app.use(
    '/recipients',
    createRecipientsRouter(
      createRecipientsController({ recipients: deps.recipients, timeZone: config.display.timeZone }),
    ),
  );

  const webhookValidations = createWebhookMonitorValidations(config.durations);
  app.use(
    '/webhook-monitors',
    createWebhookMonitorsRouter(
      createWebhookMonitorsController({
        monitors: deps.webhookMonitors,
        detail: deps.monitorDetail,
        sourceData: deps.sourceData,
        validations: webhookValidations,
        timeZone: config.display.timeZone,
      }),
      webhookValidations,
    ),
  );
  const endpointValidations = createEndpointMonitorValidations({
    ...config.durations,
    maxRetryCount: config.endpoint.maxRetryCount,
  });
  app.use(
    '/endpoint-monitors',
    createEndpointMonitorsRouter(
      createEndpointMonitorsController({
        monitors: deps.endpointMonitors,
        detail: deps.monitorDetail,
        validations: endpointValidations,
        timeZone: config.display.timeZone,
        defaultRetryCount: config.endpoint.defaultRetryCount,
        maxRetryCount: config.endpoint.maxRetryCount,
      }),
      endpointValidations,
    ),
  );
  app.use(
    '/api/v1/monitors',
    createMonitorActionsRouter({
      controller: createMonitorActionsController({
        actions: deps.monitorActions,
        timeZone: config.display.timeZone,
      }),
      actionLimiter: createActionLimiter(config.rateLimit.action),
    }),
  );
  app.use(
    '/alerts',
    createAlertsPageRouter(
      createAlertsPageController({
        alerts: deps.alerts,
        timeZone: config.display.timeZone,
        monitorOptions: async () => [
          ...(await deps.webhookMonitors.list()).map((m) => ({ id: m.id, name: m.name })),
          ...(await deps.endpointMonitors.list()).map((m) => ({ id: m.id, name: m.serverName })),
        ],
      }),
    ),
  );
  app.use('/api/v1/alerts', createAlertsApiRouter(createAlertsController({ alerts: deps.alerts })));
  app.use(
    '/api/v1/source',
    createSourceDataRouter(createSourceDataController({ sourceData: deps.sourceData })),
  );

  app.use(notFound);
  app.use(createErrorHandler(logger));
  return app;
}
