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

describe('CSRF protection', () => {
  it('rejects a POST without a token (403 CSRF_INVALID in the JSON envelope)', async () => {
    const res = await t.anonymous().post('/api/v1/anything').type('json').send({});
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('error.code', 'CSRF_INVALID');
    expect(res.body).toHaveProperty('error.requestId');
  });

  it('rejects a form POST with a wrong token', async () => {
    const agent = t.anonymous();
    await csrfFor(agent);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: 'nope', ...ADMIN });
    expect(res.status).toBe(403);
  });

  it('accepts the header form of the token and a form post whose body also carries _csrf', async () => {
    const agent = t.anonymous();
    const token = await csrfFor(agent);
    const viaHeader = await agent.post('/api/v1/anything').set('x-csrf-token', token).type('json').send({});
    // The token is valid, so the request reaches routing and is a plain 404.
    expect(viaHeader.status).toBe(404);
    const viaForm = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: token, ...ADMIN });
    expect(viaForm.status).toBe(303);
  });
});
