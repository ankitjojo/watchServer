import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { COLLECTIONS } from '../../src/constants/collections.js';
import { ConfigError, loadConfig } from '../../src/config/loadConfig.js';
import {
  MIN,
  createViaForm,
  endpointForm,
  startFakeEndpoint,
  startWorld,
  stopWorld,
  webhookForm,
  type FakeEndpoint,
  type World,
} from './support.js';
import { makeTestConfig } from '../helpers/testConfig.js';

// Criterion 8: changing ENDPOINT_TIMEOUT_MS, EMAIL_RETRY_BACKOFF_MIN or DAYS_PER_MONTH in the environment
// and restarting changes behaviour without any code change. An invalid value stops startup with an error.
let endpoint: FakeEndpoint;

beforeAll(async () => {
  endpoint = await startFakeEndpoint();
}, 60_000);

afterAll(async () => {
  await endpoint.close();
});

describe('ENDPOINT_TIMEOUT_MS', () => {
  it.each([
    ['150', 5_000],
    ['2500', 10_000],
  ])(
    '=%s makes a hanging endpoint time out after about that long',
    async (timeoutMs, ceiling) => {
      const w: World = await startWorld({ config: { ENDPOINT_TIMEOUT_MS: timeoutMs } });
      try {
        const id = await createViaForm(
          await w.admin(),
          'endpoint',
          endpointForm({ serverName: `Hangs ${timeoutMs}`, url: `${endpoint.base}/slow`, retryCount: '0' }),
        );
        const started = Date.now();
        const check = await w.check('ENDPOINT', id);
        const took = Date.now() - started;
        expect(check?.endpoint?.attempts[0]?.errorCode).toBe('TIMEOUT');
        expect(took).toBeGreaterThanOrEqual(Number(timeoutMs) - 50);
        expect(took).toBeLessThan(ceiling);
      } finally {
        await stopWorld(w);
      }
    },
    30_000,
  );
});

describe('EMAIL_RETRY_BACKOFF_MIN', () => {
  it.each([
    ['2', [2]],
    ['3,7', [3, 7]],
  ])(
    '=%s retries after %j minutes, then gives up',
    async (value, expected) => {
      const w = await startWorld({ config: { EMAIL_RETRY_BACKOFF_MIN: value } });
      try {
        await w.t.services.alerts.sendTestEmail(
          {
            monitorType: 'WEBHOOK',
            monitorId: 'a'.repeat(24),
            name: 'X',
            checkIntervalMs: 60_000,
            alertMode: 'ONCE_WITH_RECOVERY',
          },
          w.actor,
        );
        w.mailer.failAlways = true;
        await w.dispatch();
        for (const minutes of expected) {
          const [alert] = await w.alerts();
          expect(alert?.['dNextAttemptAt']).toEqual(new Date(w.clock.now().getTime() + minutes * MIN));
          w.clock.advance(minutes * MIN);
          await w.dispatch();
        }
        expect((await w.alerts())[0]?.['eStatus']).toBe('FAILED');
        expect(w.mailer.attempts).toBe(expected.length + 1);
      } finally {
        await stopWorld(w);
      }
    },
    60_000,
  );
});

describe('DAYS_PER_MONTH', () => {
  it.each([
    ['30', 30],
    ['31', 31],
  ])(
    '=%s makes "1 month" worth that many days',
    async (value, days) => {
      const w = await startWorld({ config: { DAYS_PER_MONTH: value } });
      try {
        await w.seedSource('razor_pay_webhook_data', [MIN]);
        await createViaForm(
          await w.admin(),
          'webhook',
          webhookForm({ threshold: { value: '1', unit: 'MONTH' } }),
        );
        const stored = await w.t.db.collection(COLLECTIONS.WEBHOOK_MONITORS).findOne({});
        expect(stored?.['oThreshold']).toMatchObject({ nValue: 1, eUnit: 'MONTH', nMs: days * 86_400_000 });
      } finally {
        await stopWorld(w);
      }
    },
    60_000,
  );
});

describe('an invalid value stops startup with a clear error', () => {
  it.each([
    ['ENDPOINT_TIMEOUT_MS', 'soon'],
    ['EMAIL_RETRY_BACKOFF_MIN', 'abc'],
    ['DAYS_PER_MONTH', '45'],
  ])('loadConfig names %s and never prints the value', (name, value) => {
    let error: unknown;
    try {
      loadConfig({ ...process.env, ...base(), [name]: value });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.map((i) => i.variable)).toContain(name);
    expect(JSON.stringify((error as ConfigError).issues)).not.toContain(value);
  });

  it('the real entry point exits with code 1 and a message naming the variable', () => {
    const run = spawnSync(path.resolve('node_modules/.bin/tsx'), ['-e', "import('./src/config/index.ts')"], {
      env: {
        ...base(),
        PATH: process.env['PATH'] ?? '',
        EMAIL_RETRY_BACKOFF_MIN: 'abc-not-minutes',
        NODE_ENV: 'production',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('EMAIL_RETRY_BACKOFF_MIN');
    expect(run.stderr).not.toContain('abc-not-minutes');
  });
});

/** The minimum valid environment, built in code (never from .env). */
function base(): Record<string, string> {
  const config = makeTestConfig();
  expect(config.env).toBe('test');
  return {
    NODE_ENV: 'test',
    MONGO_URI: 'mongodb://127.0.0.1:27017',
    SOURCE_MONGO_URI: 'mongodb://127.0.0.1:27017',
    SOURCE_DB_NAME: 's',
    MAIL_TRANSPORT: 'outbox',
    MAIL_FROM: 'a@b.test',
    SESSION_SECRET: 'x'.repeat(32),
  };
}
