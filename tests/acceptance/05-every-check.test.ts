import {
  MIN,
  createViaForm,
  endpointForm,
  startFakeEndpoint,
  startWorld,
  stopWorld,
  type FakeEndpoint,
  type World,
} from './support.js';

// Criterion 5: with "Every check" mode, every failing check produces an email (and recovery does not).
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

it('emails every failing check, and sends no recovery email', async () => {
  const id = await createViaForm(
    await w.admin(),
    'endpoint',
    endpointForm({
      serverName: 'Noisy',
      url: `${endpoint.base}/switch`,
      retryCount: '0',
      alertMode: 'EVERY_CHECK',
    }),
  );
  endpoint.switchStatus = 500;
  for (let i = 1; i <= 4; i++) {
    expect((await w.check('ENDPOINT', id))?.result).toBe('DOWN');
    await w.dispatch();
    expect(w.mailer.sent).toHaveLength(i);
    w.clock.advance(5 * MIN);
  }
  expect(new Set(w.subjects())).toEqual(new Set(['[payMonitor] ENDPOINT_DOWN – Noisy']));

  endpoint.switchStatus = 200;
  expect((await w.check('ENDPOINT', id))?.result).toBe('OK');
  await w.dispatch();
  expect(w.mailer.sent).toHaveLength(4);
  expect(await w.alerts({ eType: 'RECOVERED' })).toHaveLength(0);
});
