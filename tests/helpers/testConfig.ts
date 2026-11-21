import { loadConfig, type Config } from '../../src/config/loadConfig.js';

/** Built in code, never from .env or the real MONGO_URI / SOURCE_MONGO_URI / SMTP (testing rules). */
export function makeTestConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    MONGO_URI: 'mongodb://127.0.0.1:1/test',
    SOURCE_MONGO_URI: 'mongodb://127.0.0.1:1/test',
    SOURCE_DB_NAME: 'source_test',
    MAIL_TRANSPORT: 'outbox',
    MAIL_FROM: 'payMonitor <alerts@example.test>',
    SESSION_SECRET: 'test-session-secret-test-session-secret',
    LOG_LEVEL: 'silent',
    // Generous by default so unrelated tests never trip it; the rate-limit test sets the real value.
    LOGIN_RATE_LIMIT: '1000 per 15 min',
    // One failed check alerts, so tests about alert flows stay about them; TD-39 tests set 2.
    ENDPOINT_DOWN_AFTER_CHECKS: '1',
    ...overrides,
  });
}
