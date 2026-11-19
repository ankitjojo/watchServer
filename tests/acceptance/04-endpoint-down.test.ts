import {
  createViaForm,
  endpointForm,
  startFakeEndpoint,
  startWorld,
  stopWorld,
  type FakeEndpoint,
  type World,
} from './support.js';

// Criterion 4: an endpoint that returns 500 on all retry+1 attempts produces one ENDPOINT_DOWN alert;
// one that fails once and then returns 200 produces no alert.
let w: World;
let endpoint: FakeEndpoint;

beforeAll(async () => {
  w = await startWorld();
  endpoint = await startFakeEndpoint();
}, 180_000);

afterAll(async () => {
  await endpoint.close();
  await stopWorld(w);
});

it('500 on every attempt: one ENDPOINT_DOWN after retry count + 1 attempts', async () => {
  const id = await createViaForm(
    await w.admin(),
    'endpoint',
    endpointForm({ serverName: 'Always failing', url: `${endpoint.base}/fail`, retryCount: '2' }),
  );
  const check = await w.check('ENDPOINT', id);
  expect(check?.result).toBe('DOWN');
  expect(check?.endpoint?.attempts.map((a) => a.statusCode)).toEqual([500, 500, 500]);
  expect(endpoint.hits['/fail']).toBe(3);

  expect(await w.alerts({ eType: 'ENDPOINT_DOWN' })).toHaveLength(1);
  await w.dispatch();
  expect(w.subjects()).toEqual(['[payMonitor] ENDPOINT_DOWN – Always failing']);
  expect(w.mailer.sent[0]?.text).toContain('Attempts: 3');
  expect(w.mailer.sent[0]?.text).not.toContain('SECRET-BODY');
});

it('a timeout on every attempt is also DOWN', async () => {
  const slow = await startWorld({ config: { ENDPOINT_TIMEOUT_MS: '200' } });
  try {
    const id = await createViaForm(
      await slow.admin(),
      'endpoint',
      endpointForm({ serverName: 'Hangs', url: `${endpoint.base}/slow`, retryCount: '1' }),
    );
    const check = await slow.check('ENDPOINT', id);
    expect(check?.result).toBe('DOWN');
    expect(check?.endpoint?.attempts.map((a) => a.errorCode)).toEqual(['TIMEOUT', 'TIMEOUT']);
  } finally {
    await stopWorld(slow);
  }
});

it('fails once then returns 200: no alert, no email', async () => {
  const id = await createViaForm(
    await w.admin(),
    'endpoint',
    endpointForm({ serverName: 'Flaky', url: `${endpoint.base}/flaky`, retryCount: '2' }),
  );
  const check = await w.check('ENDPOINT', id);
  expect(check?.result).toBe('OK');
  expect(check?.endpoint?.attempts.map((a) => a.statusCode)).toEqual([500, 200]);
  expect(await w.alerts({ iMonitorId: { $exists: true }, eType: 'ENDPOINT_DOWN' })).toHaveLength(1); // only the first monitor's
  await w.dispatch();
  expect(w.subjects()).toEqual(['[payMonitor] ENDPOINT_DOWN – Always failing']);
});
