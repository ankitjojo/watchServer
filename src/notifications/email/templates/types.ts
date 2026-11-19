/** Plain values only: templates know nothing about modules, documents or the database. */
export interface EmailContext {
  /** No trailing slash. */
  dashboardBaseUrl: string;
  timeZone: string;
  /** The product name people see (APP_NAME): subject prefix, footers and wording. */
  appName: string;
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

export interface EmailMonitor {
  type: 'WEBHOOK' | 'ENDPOINT';
  id: string;
  name: string;
  gatewayName?: string;
  collection?: string;
  timestampKey?: string;
  /** Already masked by the caller. */
  url?: string;
  thresholdMs?: number;
  checkIntervalMs: number;
}

export interface ReminderInfo {
  number: number;
  openForMs: number;
}

export interface AttemptInfo {
  attempt: number;
  statusCode?: number;
  responseTimeMs: number;
  errorMessage?: string;
}

export interface AffectedMonitor {
  id: string;
  name: string;
  type: 'WEBHOOK' | 'ENDPOINT';
}
