import { shouldProcessAlert } from '../../../src/modules/endpointMonitors/endpointMonitors.downConfirm.js';

describe('shouldProcessAlert (TD-39)', () => {
  const base = { isDown: true, consecutiveFailures: 1, downAfterChecks: 2, hasOpenIncident: false };

  it.each([
    [1, 1, true],
    [1, 2, false],
    [2, 2, true],
    [2, 3, false],
    [3, 3, true],
  ])('%i failure(s) in a row with N=%i -> %s', (consecutiveFailures, downAfterChecks, expected) => {
    expect(shouldProcessAlert({ ...base, consecutiveFailures, downAfterChecks })).toBe(expected);
  });

  it('always processes an OK check (recovery, closing incidents)', () => {
    expect(shouldProcessAlert({ ...base, isDown: false, consecutiveFailures: 0 })).toBe(true);
  });

  it('always processes while an incident is open (FR-A3 modes unchanged)', () => {
    expect(shouldProcessAlert({ ...base, hasOpenIncident: true })).toBe(true);
  });
});
