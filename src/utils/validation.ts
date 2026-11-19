import { z } from 'zod';

/** Rejects control characters (they break logs and email headers). */
function hasNoControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export const boundedString = (min: number, max: number): z.ZodType<string> =>
  z.string().trim().min(min).max(max).refine(hasNoControlChars, 'must not contain control characters');

export const emailSchema: z.ZodType<string> = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('must be a valid email address'));

/** HTML checkbox: present ("on"/"true") = true, absent = false. */
export const checkboxSchema: z.ZodType<boolean> = z
  .union([z.literal('on'), z.literal('true'), z.literal('false'), z.boolean()])
  // optional(): a browser omits an unchecked checkbox entirely, so a missing key means false.
  .optional()
  .transform((v) => v === 'on' || v === 'true' || v === true);

/** `{ value, unit }` where unit must come from the allowed set for that field. */
export function durationSchema<const U extends readonly [string, ...string[]]>(
  units: U,
): z.ZodObject<{ value: z.ZodCoercedNumber; unit: z.ZodEnum<{ [K in U[number]]: K }> }> {
  return z.object({
    value: z.coerce.number().int().min(1).max(10_000),
    unit: z.enum(units),
  });
}
