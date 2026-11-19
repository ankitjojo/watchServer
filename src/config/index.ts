import { existsSync } from 'node:fs';
import { ConfigError, loadConfig, type Config } from './loadConfig.js';

export { ConfigError, loadConfig };
export type { Config } from './loadConfig.js';

/** This is the only place that touches process.env (architecture rule). */
function loadConfigOrExit(): Config {
  // TD-14: .env is a dev convenience. Production supplies real environment variables.
  if (process.env['NODE_ENV'] !== 'production' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Variable names and reasons only, never values.
      process.stderr.write(
        `${JSON.stringify({ level: 'fatal', event: 'config.invalid', variables: err.issues })}\n`,
      );
      process.exit(1);
    }
    throw err;
  }
}

export const config: Config = loadConfigOrExit();
