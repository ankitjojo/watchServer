import { ObjectId } from 'mongodb';
import {
  toAlertRecipient,
  toRecipient,
  toRecipientDoc,
  toRecipientUpdate,
} from '../../../src/modules/recipients/recipients.mapper.js';

const now = new Date('2026-11-18T10:00:00Z');
const input = { name: 'Ann', email: 'ann@x.test', type: 'MASTER' as const, isActive: true };

describe('recipients.mapper (TD-16)', () => {
  it('round-trips input -> doc -> domain', () => {
    const doc = { ...toRecipientDoc(input, { now }), _id: new ObjectId() };
    expect(doc).toEqual({
      _id: doc._id,
      sName: 'Ann',
      sEmail: 'ann@x.test',
      bIsActive: true,
      eType: 'MASTER',
      dCreatedAt: now,
      dUpdatedAt: now,
    });
    expect(toRecipient(doc)).toEqual({
      id: doc._id.toHexString(),
      name: 'Ann',
      email: 'ann@x.test',
      isActive: true,
      type: 'MASTER',
      createdAt: now,
      updatedAt: now,
    });
  });

  it('never sets dCreatedAt in an update', () => {
    const update = toRecipientUpdate(input, { now });
    expect(update).toEqual({
      sName: 'Ann',
      sEmail: 'ann@x.test',
      bIsActive: true,
      eType: 'MASTER',
      dUpdatedAt: now,
    });
    expect('dCreatedAt' in update).toBe(false);
  });

  it('maps to the alert recipient shape without ids or timestamps', () => {
    const doc = { ...toRecipientDoc(input, { now }), _id: new ObjectId() };
    expect(toAlertRecipient(toRecipient(doc))).toEqual({ name: 'Ann', email: 'ann@x.test', type: 'MASTER' });
  });
});
