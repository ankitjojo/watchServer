import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { ADMIN, csrfFor, startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;

beforeAll(async () => {
  mongo = await startTestMongo();
  t = await startTestApp({ mongo });
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

describe('recipients pages', () => {
  it('creates a recipient, lists it, and rejects a duplicate email with a field error', async () => {
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/recipients/new');
    await admin
      .post('/recipients/new')
      .type('form')
      .send({ _csrf: token, name: 'Ops', email: 'ops@test.local', type: 'NORMAL', isActive: 'on' })
      .expect(303);
    const list = await admin.get('/recipients');
    expect(list.text).toContain('ops@test.local');
    const dup = await admin
      .post('/recipients/new')
      .type('form')
      .send({ _csrf: token, name: 'Ops 2', email: 'OPS@test.local', type: 'NORMAL', isActive: 'on' });
    expect(dup.status).toBe(409);
    expect(dup.text).toContain('already exists');
    expect(dup.text).toContain('Ops 2');
  });

  it('shows validation errors and keeps the entered values', async () => {
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/recipients/new');
    const res = await admin
      .post('/recipients/new')
      .type('form')
      .send({ _csrf: token, name: 'Keep Me', email: 'not-an-email', type: 'NORMAL', isActive: 'on' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('must be a valid email address');
    expect(res.text).toContain('Keep Me');
  });

  it('shows the Master badge and refuses to delete or demote a master (acceptance 10)', async () => {
    const admin = await t.loginAs(ADMIN);
    const master = await t.services.recipients.create({
      name: 'Boss',
      email: 'boss@test.local',
      type: 'MASTER',
      isActive: true,
    });
    const list = await admin.get('/recipients');
    expect(list.text).toContain('badge-master');
    const token = await csrfFor(admin, '/recipients');
    const del = await admin.post(`/recipients/${master.id}/delete`).type('form').send({ _csrf: token });
    expect(del.status).toBe(409);
    const demote = await admin
      .post(`/recipients/${master.id}/edit`)
      .type('form')
      .send({ _csrf: token, name: 'Boss', email: 'boss@test.local', type: 'NORMAL' });
    expect(demote.status).toBe(409);
    const deactivate = await admin
      .post(`/recipients/${master.id}/edit`)
      .type('form')
      .send({ _csrf: token, name: 'Boss', email: 'boss@test.local', type: 'MASTER' });
    expect(deactivate.status).toBe(303);
    expect((await t.services.recipients.getById(master.id)).isActive).toBe(true);
  });

  it('escapes recipient names in the list', async () => {
    const admin = await t.loginAs(ADMIN);
    await t.services.recipients.create({
      name: '<script>alert(1)</script>',
      email: 'xss@test.local',
      type: 'NORMAL',
      isActive: true,
    });
    const list = await admin.get('/recipients');
    expect(list.text).not.toContain('<script>alert(1)</script>');
    expect(list.text).toContain('&lt;script&gt;');
  });
});
