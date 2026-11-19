import { createServer, type Server, type ServerResponse } from 'node:http';

export interface FakeEndpoints {
  /** What GET /switch answers. Change it with `sandbox:ctl endpoint-status <code>`. */
  setSwitchStatus(code: number): void;
  switchStatus(): number;
  close(): Promise<void>;
}

/** A small server on 127.0.0.1 with endpoints that behave in useful ways for the runbook. */
export async function startFakeEndpoints(port: number): Promise<FakeEndpoints> {
  let switchStatus = 200;
  let flakyHits = 0;
  const hanging = new Set<ServerResponse>();

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    switch (path) {
      case '/ok':
        res.writeHead(200).end('ok');
        return;
      case '/fail':
        res.writeHead(500).end('internal error');
        return;
      case '/slow':
        hanging.add(res); // never answers: exercises the timeout
        res.on('close', () => hanging.delete(res));
        return;
      case '/flaky':
        // Every first request of a pair fails and the retry succeeds: "fails once, then 200".
        flakyHits++;
        res.writeHead(flakyHits % 2 === 1 ? 500 : 200).end();
        return;
      case '/redirect-loop':
        res.writeHead(302, { location: '/redirect-loop' }).end();
        return;
      case '/switch':
        res.writeHead(switchStatus).end(`status ${switchStatus}`);
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    setSwitchStatus: (code) => {
      switchStatus = code;
    },
    switchStatus: () => switchStatus,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hanging) res.destroy();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
