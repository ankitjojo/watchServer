import { ObjectId } from 'mongodb';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { ROUTE_MANIFEST } from '../../helpers/routeManifest.js';
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

const adminRoutes = ROUTE_MANIFEST.filter((r) => r.role === 'ADMIN');

describe('RBAC: every admin route refuses a viewer (server-side, not just hidden buttons)', () => {
  it.each(adminRoutes.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r] as const))(
    '%s -> 403',
    async (_name, route) => {
      const viewer = await t.loginAs(VIEWER);
      const url = route.path.replace(':id', new ObjectId().toHexString());
      const res =
        route.method === 'get'
          ? await viewer.get(url)
          : await viewer
              .post(url)
              .type('form')
              .send({ _csrf: await csrfFor(viewer, '/') });
      expect(res.status).toBe(403);
    },
  );

  it('lets an admin reach the same GET pages', async () => {
    const admin = await t.loginAs(ADMIN);
    expect((await admin.get('/users')).status).toBe(200);
    expect((await admin.get('/users/new')).status).toBe(200);
  });

  it('redirects an anonymous user to /login', async () => {
    const res = await t.anonymous().get('/users');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/login');
  });
});
