import { z } from 'zod';
import type { AlertMode } from '../constants/alertMode.js';
import type { DurationInput } from '../types/duration.js';
import { toMs } from './duration.js';
import { durationSchema } from './validation.js';

/** Limits that come from config (requirements 5.1), so monitor schemas are built by factories. */
export interface DurationLimits {
  daysPerMonth: number;
  minCheckIntervalMs: number;
  maxCheckIntervalMs: number;
}

/** The form always posts repeatInterval fields; a blank value means "not set". */
export function optionalDuration<const U extends readonly [string, ...string[]]>(units: U) {
  return z.preprocess((value) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'value' in value &&
      (value.value === '' || value.value === undefined)
    ) {
      return undefined;
    }
    return value;
  }, durationSchema(units).optional());
}

/**
 * Cross-field rules shared by webhook and endpoint monitors (FR-W1, FR-E1):
 * minimum and maximum check interval (review H1); repeat interval required for REPEAT_EVERY and not shorter than the check interval.
 */
export function addIntervalIssues(
  body: { checkInterval: DurationInput; alertMode: AlertMode; repeatInterval?: DurationInput | undefined },
  limits: DurationLimits,
  ctx: z.RefinementCtx,
): void {
  const checkMs = toMs(body.checkInterval, limits.daysPerMonth);
  if (checkMs < limits.minCheckIntervalMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['checkInterval', 'value'],
      message: `must be at least ${limits.minCheckIntervalMs / 60_000} minute(s)`,
    });
  } else if (checkMs > limits.maxCheckIntervalMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['checkInterval', 'value'],
      message: `must be at most ${limits.maxCheckIntervalMs / 60_000} minutes (${limits.maxCheckIntervalMs / 3_600_000} hours)`,
    });
  }
  if (body.alertMode !== 'REPEAT_EVERY') return;
  if (!body.repeatInterval) {
    ctx.addIssue({
      code: 'custom',
      path: ['repeatInterval', 'value'],
      message: 'is required when the alert mode is "Repeat every N"',
    });
  } else if (toMs(body.repeatInterval, limits.daysPerMonth) < checkMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['repeatInterval', 'value'],
      message: 'must not be shorter than the check interval',
    });
  }
}
