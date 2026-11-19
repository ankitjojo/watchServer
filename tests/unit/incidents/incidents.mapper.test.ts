import { ObjectId } from 'mongodb';
import {
  toIncident,
  toMonitorIncidentDoc,
  toSourceErrorIncidentDoc,
} from '../../../src/modules/incidents/incidents.mapper.js';

const now = new Date('2026-11-18T10:00:00Z');

describe('incidents.mapper (TD-16)', () => {
  it('maps a monitor incident, stored open with an explicit null close time', () => {
    const monitorId = new ObjectId();
    const checkId = new ObjectId();
    const doc = {
      ...toMonitorIncidentDoc(
        { monitorId: monitorId.toHexString(), openingResult: 'STALE', checkId: checkId.toHexString() },
        { now },
      ),
      _id: new ObjectId(),
    };
    expect(doc).toMatchObject({
      eKind: 'MONITOR',
      dClosedAt: null,
      dLastAlertAt: null,
      nReminderCount: 0,
      eOpeningResult: 'STALE',
      aAffectedMonitorIds: [],
    });
    expect(toIncident(doc)).toEqual({
      id: doc._id.toHexString(),
      monitorId: monitorId.toHexString(),
      kind: 'MONITOR',
      openedAt: now,
      closedAt: null,
      openingResult: 'STALE',
      affectedMonitorIds: [],
      lastCheckId: checkId.toHexString(),
      lastAlertAt: null,
      reminderCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  });

  it('maps a source outage with no monitor and a list of affected monitors', () => {
    const a = new ObjectId().toHexString();
    const b = new ObjectId().toHexString();
    const doc = {
      ...toSourceErrorIncidentDoc(
        { affectedMonitorIds: [a, b], checkId: new ObjectId().toHexString() },
        { now },
      ),
      _id: new ObjectId(),
    };
    expect(doc.iMonitorId).toBeNull();
    expect(doc.dClosedAt).toBeNull();
    expect(toIncident(doc)).toMatchObject({
      monitorId: null,
      kind: 'SOURCE_ERROR',
      affectedMonitorIds: [a, b],
      openingResult: 'ERROR',
    });
  });

  it('maps an old document without the counters or close reason', () => {
    const doc = {
      ...toMonitorIncidentDoc(
        {
          monitorId: new ObjectId().toHexString(),
          openingResult: 'DOWN',
          checkId: new ObjectId().toHexString(),
        },
        { now },
      ),
      _id: new ObjectId(),
    };
    const old = {
      ...doc,
      dLastAlertAt: undefined,
      nReminderCount: undefined,
      aAffectedMonitorIds: undefined,
    } as unknown as Parameters<typeof toIncident>[0];
    expect(toIncident(old)).toMatchObject({ lastAlertAt: null, reminderCount: 0, affectedMonitorIds: [] });
    expect('closeReason' in toIncident(old)).toBe(false);
  });

  it('exposes the close reason once closed', () => {
    const doc = {
      ...toMonitorIncidentDoc(
        {
          monitorId: new ObjectId().toHexString(),
          openingResult: 'DOWN',
          checkId: new ObjectId().toHexString(),
        },
        { now },
      ),
      _id: new ObjectId(),
    };
    expect(toIncident({ ...doc, dClosedAt: now, eCloseReason: 'MONITOR_DELETED' }).closeReason).toBe(
      'MONITOR_DELETED',
    );
  });
});
