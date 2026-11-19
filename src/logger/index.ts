import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

// Security rule: never log credentials, cookies, CSRF tokens, password hashes or URIs.
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.sPassword',
  '*.sPasswordHash',
  '*._csrf',
  '*.smtpPass',
  '*.uri',
  'password',
  'sPasswordHash',
  '_csrf',
  'uri',
];

export interface LoggerOptions {
  level: string;
  /** Tests pass a stream to capture output. */
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      base: { service: 'payMonitor' },
    },
    options.destination,
  );
}
