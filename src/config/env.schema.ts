import { z } from 'zod';

const intRange = (min: number, max: number): z.ZodType<number> => z.coerce.number().int().min(min).max(max);

const mongoUri = z.string().regex(/^mongodb(\+srv)?:\/\/.+/, 'must be a mongodb:// or mongodb+srv:// URI');

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const rateLimit = z
  .string()
  .regex(/^\d+ per \d+ (min|hour)$/, 'must look like "5 per 15 min" (units: min or hour)');

const backoff = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d+(,\d+)*$/, 'must be comma-separated whole minutes, for example 1,5,15'))
  .refine(
    (v) => v.split(',').every((n) => Number(n) >= 1 && Number(n) <= 1440),
    'each value must be between 1 and 1440 minutes',
  );

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'must be a valid IANA time zone');

const baseUrl = z
  .string()
  .regex(/^https?:\/\/[^\s]+$/, 'must be an http(s) URL')
  .transform((v) => v.replace(/\/+$/, ''));

/** Flat view of the environment. Requirements §5.1 and §6 are the source of every default. */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intRange(1, 65535).default(3000),
    TRUST_PROXY: intRange(0, 10).default(0),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    MONGO_URI: mongoUri,
    MONGO_DB_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 letters, digits, _ or -')
      .default('paymonitor'),
    SOURCE_MONGO_URI: mongoUri,
    SOURCE_DB_NAME: z.string().min(1).max(120),
    SOURCE_QUERY_TIMEOUT_MS: intRange(100, 60000).default(10000),

    MAIL_TRANSPORT: z.enum(['smtp', 'outbox']).default('smtp'),
    MAIL_OUTBOX_DIR: z.string().min(1).default('./.sandbox/outbox'),
    MAIL_FROM: z
      .string()
      .min(3)
      .refine((v) => v.includes('@'), 'must contain an email address'),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: intRange(1, 65535).optional(),
    SMTP_SECURE: bool.default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    SMTP_TIMEOUT_MS: intRange(1000, 120000).default(15000),

    SESSION_SECRET: z.string().min(32),
    SESSION_MAX_AGE_MS: intRange(60000, 31 * 86400000).default(28800000),

    SEED_ADMIN_EMAIL: z.string().min(3).optional(),
    SEED_ADMIN_PASSWORD: z.string().min(1).optional(),
    MASTER_ALERT_EMAIL: z.string().min(3).optional(),
    MASTER_ALERT_NAME: z.string().min(1).optional(),

    DASHBOARD_BASE_URL: baseUrl.default('http://localhost:3000'),

    ENDPOINT_TIMEOUT_MS: intRange(100, 120000).default(10000),
    ENDPOINT_RETRY_DELAY_MS: intRange(0, 60000).default(5000),
    ENDPOINT_MAX_REDIRECTS: intRange(0, 20).default(5),
    ENDPOINT_MAX_RETRY_COUNT: intRange(0, 10).default(5),
    ENDPOINT_DEFAULT_RETRY_COUNT: intRange(0, 10).default(2),

    EMAIL_RETRY_BACKOFF_MIN: backoff.default('1,5,15'),
    SOURCE_ERROR_GROUP_WINDOW_MS: intRange(0, 600000).default(60000),
    DISPATCHER_POLL_MS: intRange(1000, 60000).default(10000),
    DISPATCHER_LOCK_MS: intRange(30000, 600000).default(120000),

    DAYS_PER_MONTH: intRange(28, 31).default(30),
    MIN_CHECK_INTERVAL_MIN: intRange(1, 1440).default(1),
    // Review H1: 24 h at most, which also keeps every timer far below Node's 2^31-1 ms limit.
    MAX_CHECK_INTERVAL_MIN: intRange(1, 1440).default(1440),
    TIMEZONE: timeZone.default('UTC'),

    LOGIN_RATE_LIMIT: rateLimit.default('5 per 15 min'),
    ACTION_RATE_LIMIT: rateLimit.default('10 per 1 min'),

    LEASE_TTL_MS: intRange(5000, 600000).default(45000),
    LEASE_RENEW_MS: intRange(1000, 300000).default(15000),
    SHUTDOWN_TIMEOUT_MS: intRange(1000, 120000).default(15000),
    SCHEDULER_CONCURRENCY: intRange(1, 50).default(5),
  })
  .superRefine((env, ctx) => {
    // Review M5: the outbox only writes files, so every alert would show SENT while nobody gets email.
    if (env.MAIL_TRANSPORT === 'outbox' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'must be smtp when NODE_ENV=production (outbox never sends email)',
      });
    }
    if (env.MAIL_TRANSPORT === 'smtp') {
      for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'is required when MAIL_TRANSPORT=smtp' });
        }
      }
    }
    if (env.ENDPOINT_DEFAULT_RETRY_COUNT > env.ENDPOINT_MAX_RETRY_COUNT) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENDPOINT_DEFAULT_RETRY_COUNT'],
        message: 'must not exceed ENDPOINT_MAX_RETRY_COUNT',
      });
    }
    if (env.LEASE_RENEW_MS >= env.LEASE_TTL_MS / 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['LEASE_RENEW_MS'],
        message: 'must be less than half of LEASE_TTL_MS',
      });
    }
    if (env.MAX_CHECK_INTERVAL_MIN < env.MIN_CHECK_INTERVAL_MIN) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAX_CHECK_INTERVAL_MIN'],
        message: 'must not be less than MIN_CHECK_INTERVAL_MIN',
      });
    }
    // Review M6: the overall send deadline is 2 x SMTP_TIMEOUT_MS and must end inside the claim.
    if (env.DISPATCHER_LOCK_MS <= 2 * env.SMTP_TIMEOUT_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['DISPATCHER_LOCK_MS'],
        message: 'must be greater than 2 x SMTP_TIMEOUT_MS',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
