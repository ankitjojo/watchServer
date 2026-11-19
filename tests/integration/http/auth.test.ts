import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { ADMIN, VIEWER, csrfFor, startTestApp, type TestApp } from '../../helpers/testApp.js';

let mongo: TestMongo;
let t: TestApp;

beforeAll(async () => {
  mongo = await startTestMongo();
  t = await startTestApp({ mongo });
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

describe('login', () => {
  it('signs in with valid credentials and opens the overview', async () => {
    const agent = t.anonymous();
    const token = await csrfFor(agent);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: token, ...ADMIN });
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/');
    const home = await agent.get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Overview');
  });

  it('gives the same message for a wrong password and an unknown email', async () => {
    const agent = t.anonymous();
    const token = await csrfFor(agent);
    const wrong = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: token, email: ADMIN.email, password: 'wrong-password-1' });
    const unknown = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: token, email: 'nobody@test.local', password: 'wrong-password-1' });
    expect(wrong.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(wrong.text).toContain('Invalid email or password');
    expect(unknown.text).toContain('Invalid email or password');
  });

  it('rejects an inactive user', async () => {
    await t.services.users.create({
      name: 'Off',
      email: 'off@test.local',
      role: 'VIEWER',
      password: 'off-password-1234',
      isActive: false,
    });
    const agent = t.anonymous();
    const token = await csrfFor(agent);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: token, email: 'off@test.local', password: 'off-password-1234' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Invalid email or password');
  });

  it('cuts off a user deactivated while signed in', async () => {
    const created = await t.services.users.create({
      name: 'Temp',
      email: 'temp@test.local',
      role: 'VIEWER',
      password: 'temp-password-1234',
      isActive: true,
    });
    const agent = await t.loginAs({ email: 'temp@test.local', password: 'temp-password-1234' });
    expect((await agent.get('/')).status).toBe(200);
    await t.services.users.update(
      created.id,
      { name: 'Temp', email: 'temp@test.local', role: 'VIEWER', isActive: false },
      { id: created.id, email: 'admin@test.local' },
    );
    const res = await agent.get('/');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/login');
  });

  it('redirects unauthenticated page requests to /login', async () => {
    const res = await t.anonymous().get('/');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/login');
  });

  it('rate limits repeated failed attempts (429 on the 6th)', async () => {
    const limited = await startTestApp({ mongo, config: { LOGIN_RATE_LIMIT: '5 per 15 min' } });
    const agent = limited.anonymous();
    const token = await csrfFor(agent);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await agent
        .post('/login')
        .type('form')
        .send({ _csrf: token, email: 'limit@test.local', password: 'wrong-password-1' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses[5]).toBe(429);
  });
});

describe('session fixation protection', () => {
  it('issues a NEW session id when logging in', async () => {
    const agent = t.anonymous();
    const page = await agent.get('/login');
    const before = /pm\.sid=([^;]+)/.exec(String(page.headers['set-cookie']))?.[1];
    const token = /name="csrf-token" content="([^"]+)"/.exec(page.text)?.[1] ?? '';
    const res = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: token, ...ADMIN });
    const after = /pm\.sid=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1];
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });
});

describe('logout', () => {
  it('needs a CSRF token, then ends the session', async () => {
    const agent = await t.loginAs(VIEWER);
    const without = await agent.post('/logout');
    expect(without.status).toBe(403);
    const token = await csrfFor(agent, '/');
    const res = await agent.post('/logout').type('form').send({ _csrf: token });
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/login');
    expect((await agent.get('/')).status).toBe(302);
  });
});
