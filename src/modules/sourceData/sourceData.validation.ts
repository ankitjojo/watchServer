import { z } from 'zod';

// database-design A.2 / security 2.8: admin-supplied names reach sort/projection, so they are
// validated strictly. No `$`, no operators, no path tricks.
export const TIMESTAMP_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
export const COLLECTION_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/;

export function isValidTimestampKey(key: string): boolean {
  return TIMESTAMP_KEY_PATTERN.test(key) && !key.includes('..') && !key.endsWith('.');
}

export function isValidCollectionName(name: string): boolean {
  return COLLECTION_NAME_PATTERN.test(name) && !name.startsWith('system.');
}

export const timestampKeySchema = z
  .string()
  .trim()
  .refine(isValidTimestampKey, 'must start with a letter or _, then letters, digits, _ or . (max 64)');

export const collectionNameSchema = z
  .string()
  .trim()
  .refine(isValidCollectionName, 'is not a valid collection name');
