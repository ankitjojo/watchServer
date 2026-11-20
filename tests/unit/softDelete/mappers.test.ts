import { ObjectId } from 'mongodb';
import { DISPLAY_STATUS } from '../../../src/constants/display.js';
import {
  toEndpointMonitor,
  toEndpointMonitorDoc,
} from '../../../src/modules/endpointMonitors/endpointMonitors.mapper.js';
import { toRecipient, toRecipientDoc } from '../../../src/modules/recipients/recipients.mapper.js';
import { toUser, toUserDoc } from '../../../src/modules/users/users.mapper.js';
import {
  toWebhookMonitor,
  toWebhookMonitorDoc,
} from '../../../src/modules/webhookMonitors/webhookMonitors.mapper.js';
import { DISPLAY_STATUS_LABEL, displayStatus } from '../../../src/utils/displayStatus.js';

const now = new Date('2026-11-19T10:00:00Z');
const later = new Date('2026-11-19T11:00:00Z');
const userId = new ObjectId();

/** A copy of an old-style document that never had the soft-delete fields. */
function without<T extends object>(doc: T, keys: string[]): T {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k))) as T;
}

describe('T12: mappers carry the soft-delete fields', () => {
  it('users: new docs store false/null/null; deletedAt maps; a doc without the fields reads as not deleted', () => {
    const doc = {
      ...toUserDoc(
        { name: 'A', email: 'a@x.com', role: 'VIEWER', password: 'x', isActive: true },
        { now, passwordHash: 'h' },
      ),
      _id: new ObjectId(),
    };
    expect(doc).toMatchObject({ bIsDeleted: false, dDeletedAt: null, iDeletedBy: null });
    expect(toUser(doc).deletedAt).toBeNull();
    expect(toUser({ ...doc, bIsDeleted: true, dDeletedAt: later, iDeletedBy: userId }).deletedAt).toEqual(
      later,
    );
    const legacy = without(doc, ['bIsDeleted', 'dDeletedAt', 'iDeletedBy']);
    expect(toUser(legacy).deletedAt).toBeNull();
  });

  it('recipients: same', () => {
    const doc = {
      ...toRecipientDoc({ name: 'A', email: 'a@x.com', type: 'NORMAL', isActive: true }, { now }),
      _id: new ObjectId(),
    };
    expect(doc).toMatchObject({ bIsDeleted: false, dDeletedAt: null, iDeletedBy: null });
    expect(
      toRecipient({ ...doc, bIsDeleted: true, dDeletedAt: later, iDeletedBy: userId }).deletedAt,
    ).toEqual(later);
    const legacy = without(doc, ['bIsDeleted', 'dDeletedAt', 'iDeletedBy']);
    expect(toRecipient(legacy).deletedAt).toBeNull();
  });

  it('monitors: dDeletedAt stays the marker; iDeletedBy is optional; no bIsDeleted', () => {
    const w = {
      ...toWebhookMonitorDoc(
        {
          name: 'W',
          gatewayName: 'G',
          sourceCollection: 'c',
          timestampKey: 'dCreatedAt',
          checkInterval: { value: 1, unit: 'MINUTE' },
          threshold: { value: 1, unit: 'HOUR' },
          alertMode: 'ONCE_WITH_RECOVERY',
          isEnabled: true,
        },
        { now, userId, daysPerMonth: 30, hasIndex: true },
      ),
      _id: new ObjectId(),
    };
    expect(w).not.toHaveProperty('bIsDeleted');
    expect(toWebhookMonitor(w).deletedAt).toBeNull();
    expect(toWebhookMonitor({ ...w, dDeletedAt: later, iDeletedBy: userId }).deletedAt).toEqual(later);
    const e = {
      ...toEndpointMonitorDoc(
        {
          serverName: 'E',
          url: 'https://a.example.com',
          checkInterval: { value: 1, unit: 'MINUTE' },
          retryCount: 0,
          alertMode: 'ONCE_WITH_RECOVERY',
          isEnabled: true,
        },
        { now, userId, daysPerMonth: 30 },
      ),
      _id: new ObjectId(),
    };
    expect(toEndpointMonitor(e).deletedAt).toBeNull();
    expect(toEndpointMonitor({ ...e, dDeletedAt: later, iDeletedBy: userId }).deletedAt).toEqual(later);
  });

  it('displayStatus returns DELETED for a deleted monitor, before paused/last result', () => {
    const state = { lastResult: 'OK' } as never;
    expect(displayStatus({ isEnabled: false, state, deletedAt: later })).toBe(DISPLAY_STATUS.DELETED);
    expect(displayStatus({ isEnabled: true, state, deletedAt: null })).toBe('OK');
    expect(DISPLAY_STATUS_LABEL[DISPLAY_STATUS.DELETED]).toBe('Deleted');
  });
});
