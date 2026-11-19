import { buildEndpointDown, type EndpointDownInput } from './endpointDown.js';
import { buildMonitorCheckError, type MonitorCheckErrorInput } from './monitorCheckError.js';
import { buildMonitorError, type MonitorErrorInput } from './monitorError.js';
import {
  buildRecovered,
  buildRecoveredSource,
  type RecoveredInput,
  type RecoveredSourceInput,
} from './recovered.js';
import { buildTestEmail, type TestEmailInput } from './test.js';
import type { BuiltEmail, EmailContext } from './types.js';
import { buildWebhookNoData, type WebhookNoDataInput } from './webhookNoData.js';
import { buildWebhookStale, type WebhookStaleInput } from './webhookStale.js';

export type AlertEmailSpec =
  | ({ type: 'WEBHOOK_STALE' } & WebhookStaleInput)
  | ({ type: 'WEBHOOK_NO_DATA' } & WebhookNoDataInput)
  | ({ type: 'ENDPOINT_DOWN' } & EndpointDownInput)
  | ({ type: 'RECOVERED' } & RecoveredInput)
  | ({ type: 'RECOVERED_SOURCE' } & RecoveredSourceInput)
  | ({ type: 'MONITOR_ERROR' } & MonitorErrorInput)
  | ({ type: 'MONITOR_CHECK_ERROR' } & MonitorCheckErrorInput)
  | ({ type: 'TEST' } & TestEmailInput);

/** Renders the subject, text and HTML for any alert (FR-A6). Pure. */
export function buildAlertEmail(spec: AlertEmailSpec, ctx: EmailContext): BuiltEmail {
  switch (spec.type) {
    case 'WEBHOOK_STALE':
      return buildWebhookStale(spec, ctx);
    case 'WEBHOOK_NO_DATA':
      return buildWebhookNoData(spec, ctx);
    case 'ENDPOINT_DOWN':
      return buildEndpointDown(spec, ctx);
    case 'RECOVERED':
      return buildRecovered(spec, ctx);
    case 'RECOVERED_SOURCE':
      return buildRecoveredSource(spec, ctx);
    case 'MONITOR_ERROR':
      return buildMonitorError(spec, ctx);
    case 'MONITOR_CHECK_ERROR':
      return buildMonitorCheckError(spec, ctx);
    case 'TEST':
      return buildTestEmail(spec, ctx);
  }
}

export type {
  EmailContext,
  BuiltEmail,
  EmailMonitor,
  AffectedMonitor,
  AttemptInfo,
  ReminderInfo,
} from './types.js';
