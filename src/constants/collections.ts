// Monitor DB collection names (requirements §6, plus scheduler_locks per TD-05).
export const COLLECTIONS = {
  USERS: 'users',
  RECIPIENTS: 'recipients',
  WEBHOOK_MONITORS: 'webhook_monitors',
  ENDPOINT_MONITORS: 'endpoint_monitors',
  CHECKS: 'checks',
  INCIDENTS: 'incidents',
  ALERTS: 'alerts',
  AUDIT_LOGS: 'audit_logs',
  SCHEDULER_LOCKS: 'scheduler_locks',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
