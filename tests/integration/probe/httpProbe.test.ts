import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isBlockedAddress,
  probe,
  probeOnce,
  type ProbeDeps,
} from '../../../src/modules/endpointMonitors/httpProbe.js';
import {
  createSystemProbeDeps,
  systemProbeDeps,
} from '../../../src/modules/endpointMonitors/httpProbe.deps.js';

let server: Server;
let base: string;
const hits: Record<string, number> = {};
const openSockets = new Set<ServerResponse>();

function handler(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '/';
  hits[path] = (hits[path] ?? 0) + 1;
  switch (path) {
    case '/ok':
      res.writeHead(200).end('fine');
      return;
    case '/fail':
      res.writeHead(500).end('boom');
      return;
    case '/flaky':
      res.writeHead(hits[path] === 1 ? 500 : 200).end();
      return;
    case '/slow':
      return; // never answers
    case '/redirect-ok':
      res.writeHead(302, { location: '/ok' }).end();
      return;
    case '/redirect-loop':
      res.writeHead(302, { location: '/redirect-loop' }).end();
      return;
    case '/redirect-ftp':
      res.writeHead(302, { location: 'ftp://example.com/x' }).end();
      return;
    case '/redirect-creds':
      res.writeHead(302, { location: 'http://user:pw@127.0.0.1/x' }).end();
      return;
    case '/redirect-metadata':
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
      return;
    case '/redirect-no-location':
      res.writeHead(302).end();
      return;
    case '/endless-200':
    case '/endless-500': {
      res.writeHead(path === '/endless-200' ? 200 : 500, { 'content-type': 'text/plain' });
      openSockets.add(res);
      const timer = setInterval(() => res.write('x'.repeat(1024)), 5);
      res.on('close', () => {
        clearInterval(timer);
        openSockets.delete(res);
      });
      return;
    }
    default:
      res.writeHead(404).end();
  }
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of openSockets) res.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** A port nothing listens on. (Port 1 would not do: fetch refuses well-known "bad ports".) */
async function closedPort(): Promise<number> {
  const probeServer = createServer();
  await new Promise<void>((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
  const port = (probeServer.address() as AddressInfo).port;
  await new Promise((resolve) => probeServer.close(resolve));
  return port;
}

const opts = { retryCount: 2, retryDelayMs: 0, timeoutMs: 1000, maxRedirects: 5 };
const deps: ProbeDeps = { ...systemProbeDeps, sleep: () => Promise.resolve() };

describe('probe (FR-E2)', () => {
  it('is up after one attempt when the endpoint returns 200', async () => {
    const result = await probe(`${base}/ok`, opts, deps);
    expect(result.isUp).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ attempt: 1, statusCode: 200 });
    expect(result.attempts[0]?.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('is down only when all retryCount + 1 attempts fail, recording each one', async () => {
    hits['/fail'] = 0;
    const result = await probe(`${base}/fail`, opts, deps);
    expect(result.isUp).toBe(false);
    expect(result.attempts.map((a) => a.statusCode)).toEqual([500, 500, 500]);
    expect(result.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(hits['/fail']).toBe(3);
  });

  it('does not retry at all with retryCount 0', async () => {
    hits['/fail'] = 0;
    const result = await probe(`${base}/fail`, { ...opts, retryCount: 0 }, deps);
    expect(result.attempts).toHaveLength(1);
    expect(hits['/fail']).toBe(1);
  });

  it('is up (and stops) when an attempt fails once and then returns 200', async () => {
    hits['/flaky'] = 0;
    const result = await probe(`${base}/flaky`, { ...opts, retryCount: 5 }, deps);
    expect(result.isUp).toBe(true);
    expect(result.attempts.map((a) => a.statusCode)).toEqual([500, 200]);
    expect(hits['/flaky']).toBe(2);
  });

  it('waits retryDelayMs between attempts only', async () => {
    const sleeps: number[] = [];
    await probe(
      `${base}/fail`,
      { ...opts, retryDelayMs: 1234 },
      {
        ...deps,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(sleeps).toEqual([1234, 1234]);
  });

  it('only exactly 200 counts as up: 201, 204 and 404 are failures', async () => {
    for (const status of [201, 204, 301]) {
      const fake: ProbeDeps = { ...deps, request: () => Promise.resolve({ status, location: null }) };
      expect(
        (
          await probe(
            'http://example.test/x',
            { ...opts, retryCount: 0 },
            { ...fake, lookup: () => Promise.resolve(['93.184.216.34']) },
          )
        ).isUp,
      ).toBe(false);
    }
    expect((await probe(`${base}/missing`, { ...opts, retryCount: 0 }, deps)).isUp).toBe(false);
  });
});

describe('failures', () => {
  it('times out a server that never answers', async () => {
    const result = await probe(`${base}/slow`, { ...opts, retryCount: 0, timeoutMs: 150 }, deps);
    expect(result.isUp).toBe(false);
    expect(result.attempts[0]).toMatchObject({ errorCode: 'TIMEOUT', errorMessage: 'The request timed out' });
    expect(result.attempts[0]?.statusCode).toBeUndefined();
  });

  it('times out a DNS lookup that never answers within timeoutMs (no ~30 s OS wait)', async () => {
    const hungDns = createSystemProbeDeps({ resolve: () => new Promise(() => undefined) });
    const result = await probeOnce('http://hangs.example/x', { ...opts, timeoutMs: 150 }, hungDns);
    expect(result).toMatchObject({ errorCode: 'TIMEOUT', errorMessage: 'The request timed out' });
    expect(result.responseTimeMs).toBeLessThan(1000);
  });

  it('reports a refused connection', async () => {
    const result = await probe(`http://127.0.0.1:${await closedPort()}/x`, { ...opts, retryCount: 0 }, deps);
    expect(result.attempts[0]?.errorCode).toBe('CONNECTION_REFUSED');
  });

  it('reports an unresolvable host', async () => {
    const result = await probeOnce('http://nonexistent.invalid/x', opts, deps);
    expect(result.errorCode).toBe('DNS_ERROR');
  });

  it('never surfaces response bodies or raw error text', async () => {
    const ok = await probeOnce(`${base}/fail`, opts, deps);
    expect(JSON.stringify(ok)).not.toContain('boom');
    const refused = await probeOnce(`http://127.0.0.1:${await closedPort()}/x`, opts, deps);
    expect(refused.errorMessage).not.toMatch(/127\.0\.0\.1|ECONN/);
  });
});

describe('redirects (TD-12)', () => {
  it('follows a redirect to a 200', async () => {
    const result = await probe(`${base}/redirect-ok`, opts, deps);
    expect(result.isUp).toBe(true);
    expect(result.attempts[0]?.statusCode).toBe(200);
  });

  it('stops a redirect loop at ENDPOINT_MAX_REDIRECTS', async () => {
    hits['/redirect-loop'] = 0;
    const result = await probeOnce(`${base}/redirect-loop`, { ...opts, maxRedirects: 3 }, deps);
    expect(result.errorCode).toBe('TOO_MANY_REDIRECTS');
    expect(hits['/redirect-loop']).toBe(4);
  });

  it('allows exactly maxRedirects hops', async () => {
    const result = await probeOnce(`${base}/redirect-ok`, { ...opts, maxRedirects: 1 }, deps);
    expect(result.statusCode).toBe(200);
    expect((await probeOnce(`${base}/redirect-ok`, { ...opts, maxRedirects: 0 }, deps)).errorCode).toBe(
      'TOO_MANY_REDIRECTS',
    );
  });

  it.each(['/redirect-ftp', '/redirect-creds'])('refuses %s', async (path) => {
    expect((await probeOnce(`${base}${path}`, opts, deps)).errorCode).toBe('INVALID_REDIRECT');
  });

  it('treats a 3xx without Location as a plain (failing) response', async () => {
    expect((await probeOnce(`${base}/redirect-no-location`, opts, deps)).statusCode).toBe(302);
  });
});

describe('SSRF guard (security 2.9)', () => {
  it('blocks a host that resolves to the cloud metadata address, without sending a request', async () => {
    let requests = 0;
    const result = await probeOnce('http://innocent.example/x', opts, {
      ...deps,
      request: () => {
        requests++;
        return Promise.reject(new Error('must not be called'));
      },
      lookup: () => Promise.resolve(['169.254.169.254']),
    });
    expect(result.errorCode).toBe('BLOCKED_ADDRESS');
    expect(requests).toBe(0);
  });

  it('blocks IPv4-mapped IPv6 literals of the metadata address in every spelling (review M3)', async () => {
    for (const host of ['[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[0:0:0:0:0:ffff:a9fe:a9fe]']) {
      expect((await probeOnce(`http://${host}/latest/meta-data/`, opts, deps)).errorCode).toBe(
        'BLOCKED_ADDRESS',
      );
    }
  });

  it('vets the address the socket really connects to, so DNS rebinding cannot reach metadata (review M3)', async () => {
    // The pre-check sees a harmless address; the connection-time resolution returns the metadata IP.
    let resolutions = 0;
    const rebinding = createSystemProbeDeps({
      resolve: () => {
        resolutions++;
        return Promise.resolve([
          resolutions === 1 ? { address: '127.0.0.1', family: 4 } : { address: '169.254.169.254', family: 4 },
        ]);
      },
    });
    const port = new URL(base).port;
    const result = await probeOnce(`http://rebind.test:${port}/ok`, opts, rebinding);
    expect(result.errorCode).toBe('BLOCKED_ADDRESS');
    expect(resolutions).toBe(2);
  });

  it('connects to the vetted address of a host name (pinning works for allowed hosts)', async () => {
    const pinned = createSystemProbeDeps({
      resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    });
    const port = new URL(base).port;
    expect((await probeOnce(`http://internal.test:${port}/ok`, opts, pinned)).statusCode).toBe(200);
  });

  it('blocks a direct metadata IP literal and the other known metadata addresses', async () => {
    for (const host of ['169.254.169.254', '100.100.100.200', '[fd00:ec2::254]']) {
      expect((await probeOnce(`http://${host}/x`, opts, deps)).errorCode).toBe('BLOCKED_ADDRESS');
    }
  });

  it('blocks a redirect that leads to the metadata address', async () => {
    const result = await probeOnce(`${base}/redirect-metadata`, opts, deps);
    expect(result.errorCode).toBe('BLOCKED_ADDRESS');
  });

  it('allows loopback and private ranges (monitoring internal servers is a requirement, open question A3)', async () => {
    expect((await probeOnce(`${base}/ok`, opts, deps)).statusCode).toBe(200);
    expect(isBlockedAddress('10.0.0.5')).toBe(false);
    expect(isBlockedAddress('127.0.0.1')).toBe(false);
  });

  it.each([
    ['169.254.0.1', true],
    ['169.254.255.255', true],
    ['169.253.1.1', false],
    ['100.100.100.200', true],
    ['100.100.100.201', false],
    ['fd00:ec2::254', true],
    ['FD00:EC2::254', true],
    ['::ffff:169.254.169.254', true],
    ['::ffff:a9fe:a9fe', true],
    ['0:0:0:0:0:ffff:a9fe:a9fe', true],
    ['fd00:ec2:0::254', true],
    ['::ffff:10.0.0.1', false],
    ['fe80::1', true],
    ['2001:db8::1', false],
    ['8.8.8.8', false],
  ])('isBlockedAddress(%s) = %s', (address, expected) => {
    expect(isBlockedAddress(address)).toBe(expected);
  });
});

describe('response bodies are never read', () => {
  it('returns promptly for a 200 whose body never ends', async () => {
    const started = Date.now();
    const result = await probeOnce(`${base}/endless-200`, { ...opts, timeoutMs: 3000 }, deps);
    expect(result.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns promptly for a 500 whose body never ends', async () => {
    const result = await probeOnce(`${base}/endless-500`, { ...opts, timeoutMs: 3000 }, deps);
    expect(result.statusCode).toBe(500);
  });
});
