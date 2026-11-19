import { z } from 'zod';
import { THRESHOLD_UNITS } from '../../../src/constants/durationUnit.js';
import { boundedString, checkboxSchema, durationSchema, emailSchema } from '../../../src/utils/validation.js';
import { objectIdSchema } from '../../../src/utils/objectId.js';

describe('emailSchema', () => {
  it('trims and lower-cases', () => {
    expect(emailSchema.parse('  Admin@Example.COM ')).toBe('admin@example.com');
  });
  it.each(['nope', '', { $gt: '' }, 5])('rejects %j (NoSQL operator objects included)', (bad) => {
    expect(emailSchema.safeParse(bad).success).toBe(false);
  });
});

describe('checkboxSchema', () => {
  it.each([
    ['on', true],
    ['true', true],
    [true, true],
    ['false', false],
    [false, false],
    [undefined, false],
  ])('%j -> %s', (input, expected) => {
    expect(checkboxSchema.parse(input)).toBe(expected);
  });
});

describe('checkboxSchema inside a strict form object', () => {
  const form = z.object({ isActive: checkboxSchema }).strict();
  it('treats an omitted key (unchecked box) as false', () => {
    expect(form.parse({})).toEqual({ isActive: false });
    expect(form.parse({ isActive: 'on' })).toEqual({ isActive: true });
  });
});

describe('durationSchema', () => {
  const schema = durationSchema(THRESHOLD_UNITS);
  it('coerces form strings', () => {
    expect(schema.parse({ value: '2', unit: 'HOUR' })).toEqual({ value: 2, unit: 'HOUR' });
  });
  it.each([
    { value: '0', unit: 'HOUR' },
    { value: '1.5', unit: 'HOUR' },
    { value: '20000', unit: 'HOUR' },
    { value: '1', unit: 'YEAR' },
  ])('rejects %j', (bad) => {
    expect(schema.safeParse(bad).success).toBe(false);
  });
});

describe('boundedString', () => {
  it('trims, bounds and rejects control characters', () => {
    const s = boundedString(1, 5);
    expect(s.parse('  ab ')).toBe('ab');
    expect(s.safeParse('abcdef').success).toBe(false);
    expect(s.safeParse('').success).toBe(false);
    expect(s.safeParse('a\nb').success).toBe(false);
  });
});

describe('objectIdSchema', () => {
  it('accepts 24 hex chars only', () => {
    expect(objectIdSchema.safeParse('a'.repeat(24)).success).toBe(true);
    expect(objectIdSchema.safeParse('xyz').success).toBe(false);
    expect(objectIdSchema.safeParse({ $ne: '' }).success).toBe(false);
  });
});
