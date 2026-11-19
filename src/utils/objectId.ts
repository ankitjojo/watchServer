import { ObjectId } from 'mongodb';
import { z } from 'zod';

/** A 24-char hex id string. Validate before it reaches the database. */
export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a valid id');

export function toObjectId(id: string): ObjectId {
  return new ObjectId(objectIdSchema.parse(id));
}
