import type { Agent } from 'supertest';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { ADMIN, VIEWER, csrfFor, startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;
let actor: { id: string; email: string };

beforeAll(async () => {
  mongo = await startTestMongo();
  t = await startTestApp({ mongo });
  const admin = (await t.services.users.list()).find((u) => u.email === ADMIN.email);
  actor = { id: admin?.id ?? '', email: admin?.email ?? '' };
  await t.sourceDb.collection('wh_ok').insertOne({ dCreatedAt: new Date() });
  await t.sourceDb.collection('wh_ok').createIndex({ dCreatedAt: -1 }, {}, undefined);
}, 180_000);

afterAll(async () => {
  await t.services.scheduler.stop();
  await mongo.stop();
});

let n = 0;
const uniq = (p: string): string => `${p}${(n += 1)}`;

const mkWebhook = async (name = uniq('Hook ')) =>
  (
    await t.services.webhookMonitors.create(
      {
        name,
        gatewayName: 'G',
        sourceCollection: 'wh_ok',
        timestampKey: 'dCreatedAt',
        checkInterval: { value: 10, unit: 'MINUTE' },
        threshold: { value: 2, unit: 'HOUR' },
        alertMode: 'ONCE_WITH_RECOVERY',
        isEnabled: true,
      },
      actor,
    )
  ).monitor;
const mkEndpoint = (serverName = uniq('Api ')) =>
  t.services.endpointMonitors.create(
    {
      serverName,
      url: 'http://127.0.0.1:9/health',
      checkInterval: { value: 5, unit: 'MINUTE' },
      retryCount: 0,
      alertMode: 'ONCE_WITH_RECOVERY',
      isEnabled: true,
    },
    actor,
  );
const mkRecipient = (name = uniq('Rec '), email = `${uniq('r')}@test.local`) =>
  t.services.recipients.create({ name, email, type: 'NORMAL', isActive: true });
const mkUser = (name = uniq('User '), email = `${uniq('u')}@test.local`) =>
  t.services.users.create({ name, email, role: 'VIEWER', password: 'a-long-password-123', isActive: true });

async function del(agent: Agent, path: string, listPath: string) {
  const token = await csrfFor(agent, listPath);
  return agent.post(path).type('form').send({ _csrf: token });
}

const screens = [
  {
    label: 'webhook monitors',
    list: '/webhook-monitors',
    newHref: '/webhook-monitors/new',
    make: async (name: string) => (await mkWebhook(name)).id,
    del: (id: string) => `/webhook-monitors/${id}/delete`,
    flash: 'stopped and moved to Deleted records. Its history is kept.',
  },
  {
    label: 'endpoint monitors',
    list: '/endpoint-monitors',
    newHref: '/endpoint-monitors/new',
    make: async (name: string) => (await mkEndpoint(name)).id,
    del: (id: string) => `/endpoint-monitors/${id}/delete`,
    flash: 'stopped and moved to Deleted records. Its history is kept.',
  },
  {
    label: 'recipients',
    list: '/recipients',
    newHref: '/recipients/new',
    make: async (name: string) => (await mkRecipient(name)).id,
    del: (id: string) => `/recipients/${id}/delete`,
    flash: 'no longer receives alerts and was moved to Deleted records.',
  },
  {
    label: 'users',
    list: '/users',
    newHref: '/users/new',
    make: async (name: string) => (await mkUser(name)).id,
    del: (id: string) => `/users/${id}/delete`,
    flash: 'can no longer sign in and was moved to Deleted records.',
  },
] as const;

const count = (html: string, needle: string): number => html.split(needle).length - 1;
/** The Deleted records modal markup of a list page. */
const modalOf = (html: string): string => html.slice(html.indexOf('<dialog'), html.indexOf('</dialog>'));

describe.each(screens)('$label: Deleted records button and delete flash', (s) => {
  it('T7: exactly one button in the page header, before the New button, "No deleted records" when empty', async () => {
    // Own app (own database) so the list starts without deleted records.
    const fresh = await startTestApp({ mongo });
    const admin = await fresh.loginAs(ADMIN);
    const html = (await admin.get(s.list)).text;
    expect(count(html, 'data-deleted-open=')).toBe(1);
    expect(count(html, '<dialog ')).toBe(1);
    expect(html).toContain('Deleted records (0)');
    expect(modalOf(html)).toContain('No deleted records');
    expect(modalOf(html)).not.toContain('<table');
    const head = html.slice(html.indexOf('class="page-head"'));
    expect(head.indexOf('data-deleted-open=')).toBeLessThan(head.indexOf(s.newHref));
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="deleted-records-dialog-title"/);
    expect(html).toContain('data-deleted-close');
    await fresh.stop();
  });

  it('T1/T7/T10: delete shows the new flash, lists the record (escaped, IST), and it leaves the live list', async () => {
    const admin = await t.loginAs(ADMIN);
    const name = `<b>evil</b> ${uniq('x')}`;
    const id = await s.make(name);
    const res = await del(admin, s.del(id), s.list);
    expect(res.status).toBe(303);
    const html = (await admin.get(s.list)).text;
    expect(html).toContain(s.flash);
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(html).not.toContain('<b>evil</b>');
    const modal = modalOf(html);
    expect(modal).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(modal).toContain('<table');
    expect(count(modal, '<tr>')).toBe(2); // header + the one deleted row
    expect(modal).toContain('Deleted on');
    expect(modal).toMatch(/\d{4}-\d{2}-\d{2}.*IST/s);
    expect(modal).not.toContain('<button type="submit"');
    expect(modal).not.toContain('<form');
    expect(modal).not.toMatch(/>(Edit|Delete)</);
    expect(html).not.toMatch(/Deleted records \(0\)/);
    expect(count(html, 'data-deleted-open=')).toBe(1);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

describe('T7: a button lists only its own page type', () => {
  it('a deleted endpoint monitor is not listed on the webhook page', async () => {
    const admin = await t.loginAs(ADMIN);
    const e = await mkEndpoint('OnlyEndpointGone');
    expect((await del(admin, `/endpoint-monitors/${e.id}/delete`, '/endpoint-monitors')).status).toBe(303);
    // Load the endpoint page first: it consumes the one-time flash that also names the monitor.
    expect((await admin.get('/endpoint-monitors')).text).toContain('OnlyEndpointGone');
    expect((await admin.get('/webhook-monitors')).text).not.toContain('OnlyEndpointGone');
  });
});

describe('T8: monitor pages for viewers and the read-only deleted detail page', () => {
  it('a viewer sees the button and can open a deleted monitor read-only; nobody sees action buttons', async () => {
    const m = await mkWebhook('Viewer can read');
    await t.services.webhookMonitors.remove(m.id, actor);
    const viewer = await t.loginAs(VIEWER);
    const list = (await viewer.get('/webhook-monitors')).text;
    expect(count(list, 'data-deleted-open=')).toBe(1);
    expect(modalOf(list)).toContain(`<a href="/webhook-monitors/${m.id}">Viewer can read</a>`);
    expect(modalOf(list)).not.toContain('data-action=');
    const admin = await t.loginAs(ADMIN);
    for (const agent of [viewer, admin]) {
      const res = await agent.get(`/webhook-monitors/${m.id}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Viewer can read');
      expect(res.text).toMatch(/no longer runs/i);
      expect(res.text).not.toContain('/delete');
      expect(res.text).not.toContain('/edit');
      expect(res.text).not.toContain('data-action=');
      expect(res.text).not.toContain('monitorActions.js');
    }
  });

  it('endpoint deleted detail page is read-only too', async () => {
    const e = await mkEndpoint('Endpoint read only');
    await t.services.endpointMonitors.remove(e.id, actor);
    const res = await (await t.loginAs(VIEWER)).get(`/endpoint-monitors/${e.id}`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/no longer runs/i);
    expect(res.text).not.toContain('data-action=');
  });

  it('viewers cannot open the recipients or users pages (so no Deleted records button there)', async () => {
    const viewer = await t.loginAs(VIEWER);
    expect((await viewer.get('/recipients')).status).toBe(403);
    expect((await viewer.get('/users')).status).toBe(403);
  });
});

describe('T9: every write route on a deleted id is 404', () => {
  it('monitors, recipients and users', async () => {
    const admin = await t.loginAs(ADMIN);
    const w = await mkWebhook();
    const e = await mkEndpoint();
    const r = await mkRecipient();
    const u = await mkUser();
    await t.services.webhookMonitors.remove(w.id, actor);
    await t.services.endpointMonitors.remove(e.id, actor);
    await t.services.recipients.remove(r.id, actor);
    await t.services.users.remove(u.id, actor);
    const token = await csrfFor(admin, '/');
    // Edit posts carry a valid body so the 404 comes from the missing record, not from validation.
    const bodies: Record<string, Record<string, unknown>> = {
      [`/webhook-monitors/${w.id}/edit`]: {
        name: 'x',
        gatewayName: 'G',
        sourceCollection: 'wh_ok',
        timestampKey: 'dCreatedAt',
        checkInterval: { value: '10', unit: 'MINUTE' },
        threshold: { value: '2', unit: 'HOUR' },
        alertMode: 'ONCE_WITH_RECOVERY',
        repeatInterval: { value: '', unit: 'MINUTE' },
        isEnabled: 'on',
      },
      [`/endpoint-monitors/${e.id}/edit`]: {
        serverName: 'x',
        url: 'http://127.0.0.1:9/health',
        checkInterval: { value: '5', unit: 'MINUTE' },
        retryCount: '0',
        alertMode: 'ONCE_WITH_RECOVERY',
        repeatInterval: { value: '', unit: 'MINUTE' },
        isEnabled: 'on',
      },
      [`/recipients/${r.id}/edit`]: { name: 'x', email: 'x@test.local', type: 'NORMAL', isActive: 'on' },
      [`/users/${u.id}/edit`]: { name: 'x', email: 'x@test.local', role: 'VIEWER', isActive: 'on' },
    };
    const posts = [
      ...Object.keys(bodies),
      `/webhook-monitors/${w.id}/delete`,
      `/endpoint-monitors/${e.id}/delete`,
      `/recipients/${r.id}/delete`,
      `/users/${u.id}/delete`,
    ];
    for (const path of posts) {
      const res = await admin
        .post(path)
        .type('form')
        .send({ _csrf: token, ...bodies[path] });
      expect([path, res.status]).toEqual([path, 404]);
    }
    const gets = [
      `/webhook-monitors/${w.id}/edit`,
      `/endpoint-monitors/${e.id}/edit`,
      `/recipients/${r.id}/edit`,
      `/users/${u.id}/edit`,
    ];
    for (const path of gets) expect([path, (await admin.get(path)).status]).toEqual([path, 404]);
    for (const [type, id] of [
      ['webhook', w.id],
      ['endpoint', e.id],
    ] as const) {
      for (const action of ['pause', 'resume', 'run', 'test-email']) {
        const res = await admin.post(`/api/v1/monitors/${type}/${id}/${action}`).set('x-csrf-token', token);
        expect([`${type}/${action}`, res.status]).toEqual([`${type}/${action}`, 404]);
      }
    }
  });
});

describe('T5/T17: deleted user', () => {
  it('cannot log in, and an open session ends on the next request', async () => {
    const email = `${uniq('sess')}@test.local`;
    const second = await t.services.users.create({
      name: 'Second',
      email,
      role: 'ADMIN',
      password: 'second-password-123',
      isActive: true,
    });
    const theirs = await t.loginAs({ email, password: 'second-password-123' });
    expect((await theirs.get('/')).status).toBe(200);
    const admin = await t.loginAs(ADMIN);
    expect((await del(admin, `/users/${second.id}/delete`, '/users')).status).toBe(303);
    const after = await theirs.get('/');
    expect(after.status).toBe(302);
    expect(after.headers['location']).toBe('/login');

    const anon = t.anonymous();
    const token = await csrfFor(anon);
    const login = await anon
      .post('/login')
      .type('form')
      .send({ _csrf: token, email, password: 'second-password-123' });
    expect(login.status).toBe(400);
    expect(login.text).toContain('Invalid email or password');
  });
});

describe('T11: email reuse over HTTP', () => {
  it('a deleted recipient/user email can be created again; an active duplicate still gets 409', async () => {
    const admin = await t.loginAs(ADMIN);
    const r = await mkRecipient('Reuse R', 'reuse-http-r@test.local');
    expect((await del(admin, `/recipients/${r.id}/delete`, '/recipients')).status).toBe(303);
    const token = await csrfFor(admin, '/recipients/new');
    const again = await admin.post('/recipients/new').type('form').send({
      _csrf: token,
      name: 'Again',
      email: ' Reuse-HTTP-R@test.local ',
      type: 'NORMAL',
      isActive: 'on',
    });
    expect(again.status).toBe(303);
    const dup = await admin.post('/recipients/new').type('form').send({
      _csrf: token,
      name: 'Dup',
      email: 'reuse-http-r@test.local',
      type: 'NORMAL',
      isActive: 'on',
    });
    expect(dup.status).toBe(409);

    const u = await mkUser('Reuse U', 'reuse-http-u@test.local');
    expect((await del(admin, `/users/${u.id}/delete`, '/users')).status).toBe(303);
    const tokenU = await csrfFor(admin, '/users/new');
    const userAgain = await admin.post('/users/new').type('form').send({
      _csrf: tokenU,
      name: 'Again U',
      email: 'REUSE-http-u@test.local',
      role: 'VIEWER',
      password: 'a-long-password-123',
      isActive: 'on',
    });
    expect(userAgain.status).toBe(303);
  });
});

describe('T13: alerts filter keeps deleted monitors', () => {
  it('lists a deleted monitor as "(deleted)" so its old alerts stay filterable', async () => {
    const m = await mkWebhook('Filter me');
    await t.services.webhookMonitors.remove(m.id, actor);
    const html = (await (await t.loginAs(VIEWER)).get('/alerts')).text;
    expect(html).toContain(`value="${m.id}"`);
    expect(html).toContain('Filter me (deleted)');
  });
});
