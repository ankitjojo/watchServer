import { envSchema, type Env } from './env.schema.js';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  timeoutMs: number;
}

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export interface Config {
  env: Env['NODE_ENV'];
  /** Product name shown to people (UI, emails, log messages). Default `payMonitor`. */
  appName: string;
  http: { port: number; trustProxyHops: number };
  log: { level: Env['LOG_LEVEL'] };
  monitorDb: { uri: string; name: string };
  sourceDb: { uri: string; name: string; queryTimeoutMs: number };
  mail: {
    transport: Env['MAIL_TRANSPORT'];
    from: string;
    outboxDir: string;
    smtp?: SmtpConfig;
  };
  session: { secret: string; maxAgeMs: number };
  seed: {
    admin?: { email: string; password: string };
    master?: { email: string; name: string };
  };
  dashboardBaseUrl: string;
  endpoint: {
    timeoutMs: number;
    retryDelayMs: number;
    maxRedirects: number;
    maxRetryCount: number;
    defaultRetryCount: number;
  };
  email: { retryBackoffMs: number[] };
  alerts: {
    sourceErrorGroupWindowMs: number;
    dispatcherPollMs: number;
    dispatcherLockMs: number;
    /** Review M6: overall deadline for one email send = 2 × SMTP_TIMEOUT_MS (always < DISPATCHER_LOCK_MS). */
    sendTimeoutMs: number;
  };
  durations: { daysPerMonth: number; minCheckIntervalMs: number; maxCheckIntervalMs: number };
  display: { timeZone: string };
  rateLimit: { login: RateLimitConfig; action: RateLimitConfig };
  scheduler: { leaseTtlMs: number; leaseRenewMs: number; concurrency: number };
  shutdownTimeoutMs: number;
}

export interface ConfigIssue {
  variable: string;
  message: string;
}

/** Thrown when the environment is invalid. Carries variable NAMES and reasons only, never values. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((i) => i.variable).join(', ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Review M6: a send may use connect + greeting + data stages, so it gets twice the SMTP timeout overall. */
export const SEND_TIMEOUT_FACTOR = 2;

function parseRateLimit(value: string): RateLimitConfig {
  const [maxText, , amountText, unit] = value.split(' ');
  const amount = Number(amountText);
  return { max: Number(maxText), windowMs: amount * (unit === 'hour' ? 3_600_000 : 60_000) };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Pure: parses an environment object into the typed, frozen config. Throws ConfigError. */
export function loadConfig(source: NodeJS.ProcessEnv): Config {
  // An empty value in .env means "not set".
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        variable: String(issue.path[0] ?? 'env'),
        message: issue.message,
      })),
    );
  }
  const e = parsed.data;

  const config: Config = {
    env: e.NODE_ENV,
    appName: e.APP_NAME,
    http: { port: e.PORT, trustProxyHops: e.TRUST_PROXY },
    log: { level: e.LOG_LEVEL },
    monitorDb: { uri: e.MONGO_URI, name: e.MONGO_DB_NAME },
    sourceDb: { uri: e.SOURCE_MONGO_URI, name: e.SOURCE_DB_NAME, queryTimeoutMs: e.SOURCE_QUERY_TIMEOUT_MS },
    mail: {
      transport: e.MAIL_TRANSPORT,
      from: e.MAIL_FROM,
      outboxDir: e.MAIL_OUTBOX_DIR,
      ...(e.SMTP_HOST !== undefined &&
      e.SMTP_PORT !== undefined &&
      e.SMTP_USER !== undefined &&
      e.SMTP_PASS !== undefined
        ? {
            smtp: {
              host: e.SMTP_HOST,
              port: e.SMTP_PORT,
              secure: e.SMTP_SECURE,
              user: e.SMTP_USER,
              pass: e.SMTP_PASS,
              timeoutMs: e.SMTP_TIMEOUT_MS,
            },
          }
        : {}),
    },
    session: { secret: e.SESSION_SECRET, maxAgeMs: e.SESSION_MAX_AGE_MS },
    seed: {
      ...(e.SEED_ADMIN_EMAIL !== undefined && e.SEED_ADMIN_PASSWORD !== undefined
        ? { admin: { email: e.SEED_ADMIN_EMAIL, password: e.SEED_ADMIN_PASSWORD } }
        : {}),
      ...(e.MASTER_ALERT_EMAIL !== undefined
        ? { master: { email: e.MASTER_ALERT_EMAIL, name: e.MASTER_ALERT_NAME ?? 'Master Recipient' } }
        : {}),
    },
    dashboardBaseUrl: e.DASHBOARD_BASE_URL,
    endpoint: {
      timeoutMs: e.ENDPOINT_TIMEOUT_MS,
      retryDelayMs: e.ENDPOINT_RETRY_DELAY_MS,
      maxRedirects: e.ENDPOINT_MAX_REDIRECTS,
      maxRetryCount: e.ENDPOINT_MAX_RETRY_COUNT,
      defaultRetryCount: e.ENDPOINT_DEFAULT_RETRY_COUNT,
    },
    email: { retryBackoffMs: e.EMAIL_RETRY_BACKOFF_MIN.split(',').map((m) => Number(m) * 60_000) },
    alerts: {
      sourceErrorGroupWindowMs: e.SOURCE_ERROR_GROUP_WINDOW_MS,
      dispatcherPollMs: e.DISPATCHER_POLL_MS,
      dispatcherLockMs: e.DISPATCHER_LOCK_MS,
      sendTimeoutMs: SEND_TIMEOUT_FACTOR * e.SMTP_TIMEOUT_MS,
    },
    durations: {
      daysPerMonth: e.DAYS_PER_MONTH,
      minCheckIntervalMs: e.MIN_CHECK_INTERVAL_MIN * 60_000,
      maxCheckIntervalMs: e.MAX_CHECK_INTERVAL_MIN * 60_000,
    },
    display: { timeZone: e.TIMEZONE },
    rateLimit: { login: parseRateLimit(e.LOGIN_RATE_LIMIT), action: parseRateLimit(e.ACTION_RATE_LIMIT) },
    scheduler: {
      leaseTtlMs: e.LEASE_TTL_MS,
      leaseRenewMs: e.LEASE_RENEW_MS,
      concurrency: e.SCHEDULER_CONCURRENCY,
    },
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  };

  return deepFreeze(config);
}
