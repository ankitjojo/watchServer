import type { DurationUnit } from '../constants/durationUnit.js';

/** What the admin typed. */
export interface DurationInput {
  value: number;
  unit: DurationUnit;
}

/** Domain shape: what was typed plus the normalised milliseconds (TD-08). */
export interface Duration extends DurationInput {
  ms: number;
}

/** Stored shape (persistence layer only, TD-16). */
export interface StoredDuration {
  nValue: number;
  eUnit: DurationUnit;
  nMs: number;
}
