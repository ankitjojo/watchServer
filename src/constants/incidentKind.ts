import { z } from 'zod';

export const INCIDENT_KIND = {
  MONITOR: 'MONITOR',
  SOURCE_ERROR: 'SOURCE_ERROR',
} as const;

export type IncidentKind = (typeof INCIDENT_KIND)[keyof typeof INCIDENT_KIND];
export const incidentKindSchema = z.enum(INCIDENT_KIND);
