import {
  alertTypeForResult,
  decideAlert,
  dedupeKey,
  type AlertDecision,
  type DecideInput,
} from '../../../src/modules/alerts/alert.policy.js';

const MIN = 60_000;
const now = new Date('2026-11-18T12:00:00.000Z');
const ago = (ms: number): Date => new Date(now.getTime() - ms);

const incident = (over: { openedAgo?: number; lastAlertAgo?: number | null; reminders?: number } = {}) => ({
  openedAt: ago(over.openedAgo ?? 90 * MIN),
  lastAlertAt: over.lastAlertAgo === null ? null : ago(over.lastAlertAgo ?? 90 * MIN),
  reminderCount: over.reminders ?? 0,
});

const decide = (over: Partial<DecideInput>): AlertDecision =>
  decideAlert({
    result: 'STALE',
    openIncident: null,
    alertMode: 'ONCE_WITH_RECOVERY',
    repeatIntervalMs: 30 * MIN,
    now,
    ...over,
  });

describe('decideAlert: no open incident', () => {
  it.each(['ONCE_WITH_RECOVERY', 'EVERY_CHECK', 'REPEAT_EVERY'] as const)(
    '%s: failing opens an incident and sends the first email',
    (alertMode) => {
      for (const result of ['STALE', 'NO_DATA', 'DOWN', 'ERROR'] as const) {
        expect(decide({ result, alertMode })).toEqual({ incident: 'OPEN', email: { kind: 'FAILURE' } });
      }
    },
  );

  it.each(['ONCE_WITH_RECOVERY', 'EVERY_CHECK', 'REPEAT_EVERY'] as const)(
    '%s: OK does nothing',
    (alertMode) => {
      expect(decide({ result: 'OK', alertMode })).toEqual({ incident: 'NONE', email: null });
    },
  );
});

describe('decideAlert: ONCE_WITH_RECOVERY', () => {
  it('stays silent while the incident keeps failing', () => {
    expect(decide({ openIncident: incident() })).toEqual({ incident: 'KEEP', email: null });
  });
  it('sends one RECOVERED email with the downtime and closes the incident', () => {
    expect(decide({ result: 'OK', openIncident: incident({ openedAgo: 75 * MIN }) })).toEqual({
      incident: 'CLOSE',
      email: { kind: 'RECOVERED', downtimeMs: 75 * MIN },
    });
  });
});

describe('decideAlert: EVERY_CHECK (D5)', () => {
  const alertMode = 'EVERY_CHECK' as const;
  it('emails every failing check', () => {
    expect(decide({ alertMode, openIncident: incident({ lastAlertAgo: 1 }) })).toEqual({
      incident: 'KEEP',
      email: { kind: 'FAILURE' },
    });
  });
  it('closes the incident on recovery WITHOUT a RECOVERED email', () => {
    expect(decide({ alertMode, result: 'OK', openIncident: incident() })).toEqual({
      incident: 'CLOSE',
      email: null,
    });
  });
});

describe('decideAlert: REPEAT_EVERY reminder timing', () => {
  const alertMode = 'REPEAT_EVERY' as const;
  const repeatIntervalMs = 30 * MIN;

  it('sends no reminder one millisecond before the interval', () => {
    expect(
      decide({ alertMode, repeatIntervalMs, openIncident: incident({ lastAlertAgo: repeatIntervalMs - 1 }) }),
    ).toEqual({ incident: 'KEEP', email: null });
  });
  it('sends a reminder at exactly the interval', () => {
    expect(
      decide({ alertMode, repeatIntervalMs, openIncident: incident({ lastAlertAgo: repeatIntervalMs }) }),
    ).toEqual({
      incident: 'KEEP',
      email: { kind: 'REMINDER', reminderNumber: 1 },
    });
  });
  it('sends it at the first check after the interval has passed', () => {
    expect(
      decide({ alertMode, repeatIntervalMs, openIncident: incident({ lastAlertAgo: 41 * MIN }) }).email,
    ).toEqual({ kind: 'REMINDER', reminderNumber: 1 });
  });
  it('numbers reminders from the stored counter', () => {
    expect(
      decide({
        alertMode,
        repeatIntervalMs,
        openIncident: incident({ lastAlertAgo: 30 * MIN, reminders: 4 }),
      }).email,
    ).toEqual({ kind: 'REMINDER', reminderNumber: 5 });
  });
  it('measures the interval from the LAST email, not from when the incident opened', () => {
    expect(
      decide({
        alertMode,
        repeatIntervalMs,
        openIncident: incident({ openedAgo: 10 * 60 * MIN, lastAlertAgo: 5 * MIN, reminders: 3 }),
      }).email,
    ).toBeNull();
  });
  it('sends no reminders without a repeat interval', () => {
    expect(
      decide({ alertMode, repeatIntervalMs: null, openIncident: incident({ lastAlertAgo: 999 * MIN }) })
        .email,
    ).toBeNull();
  });
  it('sends RECOVERED on recovery, with the downtime', () => {
    expect(decide({ alertMode, result: 'OK', openIncident: incident({ openedAgo: 60 * MIN }) })).toEqual({
      incident: 'CLOSE',
      email: { kind: 'RECOVERED', downtimeMs: 60 * MIN },
    });
  });
});

describe('decideAlert: STALE <-> NO_DATA (D4)', () => {
  it('does not open a new incident or send a new "open" email when the failure type changes', () => {
    for (const result of ['STALE', 'NO_DATA'] as const) {
      expect(decide({ result, openIncident: incident() })).toEqual({ incident: 'KEEP', email: null });
    }
  });
});

describe('decideAlert: per-monitor ERROR (review H2, TD-29)', () => {
  it("stays in the same incident when STALE / NO_DATA turns into the monitor's own ERROR and back", () => {
    for (const result of ['ERROR', 'STALE', 'NO_DATA'] as const) {
      expect(decide({ result, openIncident: incident() })).toEqual({ incident: 'KEEP', email: null });
    }
  });
  it('follows the alert mode like any other failure', () => {
    expect(decide({ result: 'ERROR', alertMode: 'EVERY_CHECK', openIncident: incident() }).email).toEqual({
      kind: 'FAILURE',
    });
    expect(
      decide({
        result: 'ERROR',
        alertMode: 'REPEAT_EVERY',
        openIncident: incident({ lastAlertAgo: 30 * MIN }),
      }).email,
    ).toEqual({ kind: 'REMINDER', reminderNumber: 1 });
  });
});

describe('decideAlert: crash safety', () => {
  it.each(['ONCE_WITH_RECOVERY', 'EVERY_CHECK', 'REPEAT_EVERY'] as const)(
    '%s: an open incident whose first email was never stored gets it now (idempotent via the dedupe key)',
    (alertMode) => {
      expect(decide({ alertMode, openIncident: incident({ lastAlertAgo: null }) })).toEqual({
        incident: 'KEEP',
        email: { kind: 'FAILURE' },
      });
    },
  );
  it('clamps a negative downtime (clock skew) to zero', () => {
    const skewed = { openedAt: new Date(now.getTime() + 5000), lastAlertAt: null, reminderCount: 0 };
    expect(decide({ result: 'OK', openIncident: skewed }).email).toEqual({
      kind: 'RECOVERED',
      downtimeMs: 0,
    });
  });
});

describe('alert type and dedupe keys (TD-09)', () => {
  it('maps results to alert types', () => {
    expect(alertTypeForResult('STALE')).toBe('WEBHOOK_STALE');
    expect(alertTypeForResult('NO_DATA')).toBe('WEBHOOK_NO_DATA');
    expect(alertTypeForResult('DOWN')).toBe('ENDPOINT_DOWN');
    expect(alertTypeForResult('ERROR')).toBe('MONITOR_ERROR');
  });
  it('builds the documented keys', () => {
    expect(dedupeKey.incidentOpen('i1')).toBe('incident:i1:open');
    expect(dedupeKey.incidentReminder('i1', 2)).toBe('incident:i1:reminder:2');
    expect(dedupeKey.incidentRecovered('i1')).toBe('incident:i1:recovered');
    expect(dedupeKey.everyCheck('c1')).toBe('check:c1:every');
    expect(dedupeKey.sourceErrorOpen('i1')).toBe('sourceError:i1:open');
    expect(dedupeKey.sourceErrorRecovered('i1')).toBe('sourceError:i1:recovered');
    expect(dedupeKey.test('u')).toBe('test:u');
  });
});
