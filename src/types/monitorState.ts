import type { ObjectId } from 'mongodb';
import type { CheckResult } from '../constants/checkResult.js';

/** Stored `oState` of a monitor (persistence layer only, TD-16). Plan Appendix A.1. */
export interface MonitorStateDoc {
  eLastResult: CheckResult | null;
  /** Last result outside a source outage: unchanged during one (FR-A4a); ERROR for a monitor's own error (TD-29). */
  eCurrentStatus: CheckResult | null;
  dLastCheckAt: Date | null;
  dNextCheckAt: Date | null;
  iLastCheckId: ObjectId | null;
  iOpenIncidentId: ObjectId | null;
  nLastAgeMs: number | null;
  nLastResponseTimeMs: number | null;
}

export interface MonitorState {
  lastResult: CheckResult | null;
  currentStatus: CheckResult | null;
  lastCheckAt: Date | null;
  nextCheckAt: Date | null;
  lastCheckId: string | null;
  openIncidentId: string | null;
  lastAgeMs: number | null;
  lastResponseTimeMs: number | null;
}
