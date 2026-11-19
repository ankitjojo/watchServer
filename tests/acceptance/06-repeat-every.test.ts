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

// Criterion 6: "Repeat every N" (repeat 30 min, check every 10 min), a 1-hour outage sends:
// 1 alert when the incident opens, about 2 reminders, and 1 RECOVERED email.
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

it('sends 1 alert, 2 reminders and 1 RECOVERED for a one hour outage', async () => {
  const id = await createViaForm(
    await w.admin(),
    'endpoint',
    endpointForm({
      serverName: 'Reminded',
      url: `${endpoint.base}/switch`,
      retryCount: '0',
      checkInterval: { value: '10', unit: 'MINUTE' },
      alertMode: 'REPEAT_EVERY',
      repeatInterval: { value: '30', unit: 'MINUTE' },
    }),
  );
  endpoint.switchStatus = 500;
  for (let minute = 0; minute <= 60; minute += 10) {
    await w.check('ENDPOINT', id);
    await w.dispatch();
    w.clock.advance(10 * MIN);
  }
  endpoint.switchStatus = 200;
  await w.check('ENDPOINT', id);
  await w.dispatch();

  expect(w.subjects()).toEqual([
    '[payMonitor] ENDPOINT_DOWN – Reminded',
    '[payMonitor] ENDPOINT_DOWN – Reminded',
    '[payMonitor] ENDPOINT_DOWN – Reminded',
    '[payMonitor] RECOVERED – Reminded',
  ]);
  const texts = w.mailer.sent.map((m) => m.text);
  expect(texts[0]).not.toContain('Reminder');
  expect(texts[1]).toContain('Reminder: #1');
  expect(texts[1]).toContain('Incident open for: 30 min');
  expect(texts[2]).toContain('Reminder: #2');
  expect(texts[2]).toContain('Earlier reminders: 1');
  expect(texts[3]).toContain('Downtime: 1 h 10 min');
});
