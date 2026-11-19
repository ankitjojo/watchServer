import { MongoNetworkError, MongoNetworkTimeoutError, MongoServerError } from 'mongodb';
import {
  isSourceOutage,
  SourceDataError,
  toSourceDataError,
} from '../../../src/modules/sourceData/sourceData.errors.js';

// Review H2 / TD-29: only connection-level failures are a Source DB outage (grouped, masters only).
// Everything the server itself answered (timeout, query error) belongs to the one monitor.
describe('toSourceDataError classification', () => {
  // The driver marks these constructors "do not use" (it creates them itself); tests have no other way.
  const outages: [string, () => unknown][] = [
    ['a network error', () => new MongoNetworkError('connect ECONNREFUSED')],
    ['a network timeout', () => new MongoNetworkTimeoutError('timed out')],
    ['failed authentication (code 18)', () => new MongoServerError({ code: 18, errmsg: 'auth failed' })],
  ];
  it.each(outages)('%s is an outage (UNAVAILABLE)', (_label, make) => {
    const mapped = toSourceDataError(make(), 'read the latest document');
    expect(mapped.kind).toBe('UNAVAILABLE');
    expect(isSourceOutage(mapped)).toBe(true);
  });

  it('maxTimeMS expired (code 50) is a per-monitor TIMEOUT', () => {
    const mapped = toSourceDataError(
      new MongoServerError({ code: 50, errmsg: 'operation exceeded time limit' }),
      'x',
    );
    expect(mapped.kind).toBe('TIMEOUT');
    expect(isSourceOutage(mapped)).toBe(false);
  });

  it.each([
    ['a server error the server answered with', new MongoServerError({ code: 2, errmsg: 'BadValue' })],
    ['an unexpected error', new Error('boom')],
  ])('%s is a per-monitor QUERY_FAILED', (_label, err) => {
    const mapped = toSourceDataError(err, 'x');
    expect(mapped.kind).toBe('QUERY_FAILED');
    expect(isSourceOutage(mapped)).toBe(false);
    expect(mapped.message).not.toContain('BadValue');
  });

  it('a missing collection is per-monitor', () => {
    expect(isSourceOutage(new SourceDataError('COLLECTION_NOT_FOUND', 'gone'))).toBe(false);
  });
});
