import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { BLOCKED_ADDRESS_CODE, isBlockedAddress, type ProbeDeps, type ProbeResponse } from './httpProbe.js';

interface ResolvedAddress {
  address: string;
  family: number;
}

export interface SystemProbeOptions {
  /** Resolves every address of a host. Tests replace it to simulate DNS rebinding. */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
}

const systemResolve = (host: string): Promise<ResolvedAddress[]> => dnsLookup(host, { all: true });

/**
 * Review M3: the socket's own DNS lookup. Every address it could connect to is vetted, so the
 * address checked IS the address used (no time-of-check / time-of-use gap, no DNS rebinding).
 * Node skips this hook for IP literals; those are vetted by the pre-check in `probeOnce`.
 */
function vettedLookup(resolve: (host: string) => Promise<ResolvedAddress[]>): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const usable = addresses.filter(
          (a) => options.family === undefined || options.family === 0 || a.family === options.family,
        );
        if (usable.length === 0 || usable.some((a) => isBlockedAddress(a.address))) {
          const blocked = Object.assign(new Error('The address is blocked'), { code: BLOCKED_ADDRESS_CODE });
          callback(blocked, '', 0);
          return;
        }
        const [first] = usable;
        if (options.all) callback(null, usable);
        else if (first) callback(null, first.address, first.family);
      },
      (err: unknown) => {
        callback(err instanceof Error ? err : new Error('DNS lookup failed'), '', 0);
      },
    );
  };
}

function request(lookup: LookupFunction, url: URL, options: { signal: AbortSignal }): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    // agent: false — a fresh socket per hop, never a pooled one connected to a previous host.
    const req = client.request(
      url,
      { method: 'GET', signal: options.signal, lookup, agent: false },
      (res) => {
        const { location } = res.headers;
        // Release the socket without reading the body (security 2.9).
        res.destroy();
        resolve({ status: res.statusCode ?? 0, location: typeof location === 'string' ? location : null });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Production wiring for the probe: node:http(s) with a vetting resolver, and the system clock/sleep. */
export function createSystemProbeDeps(options: SystemProbeOptions = {}): ProbeDeps {
  const resolve = options.resolve ?? systemResolve;
  const lookup = vettedLookup(resolve);
  return {
    request: (url, requestOptions) => request(lookup, url, requestOptions),
    lookup: async (host) => (await resolve(host)).map((entry) => entry.address),
    sleep: (ms) => delay(ms),
    nowMs: () => performance.now(),
  };
}

export const systemProbeDeps: ProbeDeps = createSystemProbeDeps();
