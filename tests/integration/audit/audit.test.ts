import { COLLECTIONS } from '../../../src/constants/collections.js';
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

describe('audit trail written by real changes (FR-H2)', () => {
  it('records user and recipient changes, and logins, without any secret', async () => {
    const admin = await t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/users/new');
    await admin
      .post('/users/new')
      .type('form')
      .send({
        _csrf: token,
        name: 'New Viewer',
        email: 'nv@test.local',
        role: 'VIEWER',
        password: 'super-secret-password',
        isActive: 'on',
      })
      .expect(303);
    await admin
      .post('/recipients/new')
      .type('form')
      .send({ _csrf: token, name: 'Ops', email: 'ops@test.local', type: 'NORMAL', isActive: 'on' })
      .expect(303);

    const logs = await t.db.collection(COLLECTIONS.AUDIT_LOGS).find({}).toArray();
    const actions = logs.map((l) => `${String(l['eAction'])}:${String(l['eEntityType'])}`);
    expect(actions).toEqual(expect.arrayContaining(['LOGIN:USER', 'CREATE:USER', 'CREATE:RECIPIENT']));
    const created = logs.find((l) => l['eAction'] === 'CREATE' && l['eEntityType'] === 'USER');
    expect(created).toMatchObject({ sActorEmail: ADMIN.email, oAfter: { email: 'nv@test.local' } });

    const dump = JSON.stringify(logs);
    expect(dump).not.toContain('super-secret-password');
    expect(dump).not.toMatch(/\$2[aby]\$/);
    expect(dump).not.toMatch(/passwordHash|sPasswordHash/);
  });
});
