import { z } from 'zod';
import { ValidationError } from '../errors/appError.js';

export interface Cursor {
  /** Sort timestamp of the last row on the previous page. */
  t: Date;
  /** Tie-break `_id` (hex string) of the last row. */
  id: string;
}

const cursorSchema = z.object({ t: z.iso.datetime(), id: z.string().regex(/^[a-f0-9]{24}$/i) }).strict();

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.t.toISOString(), id: cursor.id })).toString('base64url');
}

export function decodeCursor(encoded: string): Cursor {
  try {
    const raw: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const parsed = cursorSchema.parse(raw);
    return { t: new Date(parsed.t), id: parsed.id };
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}
