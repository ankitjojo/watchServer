import { z } from 'zod';

export const INCIDENT_CLOSE_REASON = {
  RECOVERED: 'RECOVERED',
  MONITOR_DELETED: 'MONITOR_DELETED',
} as const;

export type IncidentCloseReason = (typeof INCIDENT_CLOSE_REASON)[keyof typeof INCIDENT_CLOSE_REASON];
export const incidentCloseReasonSchema = z.enum(INCIDENT_CLOSE_REASON);
