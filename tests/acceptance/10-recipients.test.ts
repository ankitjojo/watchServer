import { csrfFor } from '../helpers/testApp.js';
import { startWorld, stopWorld, type World } from './support.js';

// Criterion 10: inactive recipients get no email. Master recipients always get email and cannot be
// deactivated or deleted.
let w: World;
let masterId: string;

beforeAll(async () => {
  w = await startWorld();
  masterId = (await w.t.services.recipients.list()).find((r) => r.type === 'MASTER')?.id ?? '';
}, 180_000);

afterAll(async () => {
  await stopWorld(w);
});

const monitor = {
  monitorType: 'WEBHOOK' as const,
  monitorId: 'a'.repeat(24),
  name: 'Razorpay',
  checkIntervalMs: 60_000,
  alertMode: 'ONCE_WITH_RECOVERY' as const,
};

it('emails the active recipients and the master, and nobody inactive', async () => {
  await w.t.services.alerts.sendTestEmail(monitor, w.actor);
  await w.dispatch();
  expect(w.mailer.sent[0]?.to.sort()).toEqual(['master@x.test', 'ops@x.test']);
});

it('an inactive recipient that becomes active starts receiving alerts, and an active one that is deactivated stops', async () => {
  const admin = await w.admin();
  const token = await csrfFor(admin, '/recipients');
  const all = await w.t.services.recipients.list();
  const off = all.find((r) => r.email === 'off@x.test');
  const ops = all.find((r) => r.email === 'ops@x.test');
  await admin
    .post(`/recipients/${off?.id}/edit`)
    .type('form')
    .send({ _csrf: token, name: 'Off', email: 'off@x.test', type: 'NORMAL', isActive: 'on' })
    .expect(303);
  await admin
    .post(`/recipients/${ops?.id}/edit`)
    .type('form')
    .send({ _csrf: token, name: 'Ops', email: 'ops@x.test', type: 'NORMAL' })
    .expect(303);
  await w.t.services.alerts.sendTestEmail(monitor, w.actor);
  await w.dispatch();
  expect(w.mailer.sent[1]?.to.sort()).toEqual(['master@x.test', 'off@x.test']);
});

it('the master cannot be deleted, deactivated or demoted, but can be renamed', async () => {
  const admin = await w.admin();
  const token = await csrfFor(admin, '/recipients');
  expect(
    (await admin.post(`/recipients/${masterId}/delete`).type('form').send({ _csrf: token })).status,
  ).toBe(409);
  expect(
    (
      await admin
        .post(`/recipients/${masterId}/edit`)
        .type('form')
        .send({ _csrf: token, name: 'Master', email: 'master@x.test', type: 'NORMAL' })
    ).status,
  ).toBe(409);
  // Deactivation is ignored: an omitted "active" checkbox cannot switch a master off.
  expect(
    (
      await admin
        .post(`/recipients/${masterId}/edit`)
        .type('form')
        .send({ _csrf: token, name: 'Master', email: 'master@x.test', type: 'MASTER' })
    ).status,
  ).toBe(303);
  expect((await w.t.services.recipients.getById(masterId)).isActive).toBe(true);
  expect(
    (
      await admin
        .post(`/recipients/${masterId}/edit`)
        .type('form')
        .send({ _csrf: token, name: 'Chief', email: 'chief@x.test', type: 'MASTER', isActive: 'on' })
    ).status,
  ).toBe(303);
  expect(await w.t.services.recipients.getById(masterId)).toMatchObject({
    name: 'Chief',
    email: 'chief@x.test',
    type: 'MASTER',
  });
  expect((await admin.get('/recipients')).text).toContain('badge-master');
  expect(await w.t.services.recipients.countMasters()).toBe(1);
});

it('the master still receives every alert, even with all other recipients inactive', async () => {
  for (const r of await w.t.services.recipients.list()) {
    if (r.type === 'NORMAL')
      await w.t.services.recipients.update(
        r.id,
        { name: r.name, email: r.email, type: 'NORMAL', isActive: false },
        w.actor,
      );
  }
  w.mailer.sent.length = 0;
  await w.t.services.alerts.sendTestEmail(monitor, w.actor);
  await w.dispatch();
  expect(w.mailer.sent[0]?.to).toEqual(['chief@x.test']);
});
