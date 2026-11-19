import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../../src/constants/collections.js';
import { createAlertsRepository } from '../../../src/modules/alerts/alerts.repository.js';
import { startAlertsHarness, webhookSnapshot } from '../../helpers/alertsHarness.js';
import { startTestMongo, type TestMongo } from '../../helpers/memoryMongo.js';
import { ADMIN, VIEWER, csrfFor } from '../../helpers/testApp.js';

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo();
}, 180_000);

afterAll(async () => {
  await mongo.stop();
});

describe('POST /api/v1/alerts/:id/resend', () => {
  async function setup() {
    const h = await startAlertsHarness(mongo);
    const alert = await h.t.services.alerts.sendTestEmail(webhookSnapshot(), h.actor);
    // The dispatcher writes outcomes only under its claim (review M6): take one as the test.
    await h.t.db
      .collection(COLLECTIONS.ALERTS)
      .updateOne({ _id: new ObjectId(alert.id) }, { $set: { sClaimId: 'test-claim' } });
    await createAlertsRepository(h.t.db).markFailed(alert.id, 'test-claim', {
      at: h.clock.now(),
      reason: 'The mail server could not be reached',
      attempt: { dAt: h.clock.now(), bIsSuccess: false },
    });
    return { h, alert };
  }

  it('queues a FAILED alert (202, "queued", never "sent") and refuses a second click with 409', async () => {
    const { h, alert } = await setup();
    const admin = await h.t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    const first = await admin.post(`/api/v1/alerts/${alert.id}/resend`).set('x-csrf-token', token);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ success: true, data: { status: 'queued' } });
    expect(
      await h.t.db.collection(COLLECTIONS.ALERTS).findOne({ _id: new ObjectId(alert.id) }),
    ).toMatchObject({ eStatus: 'PENDING' });

    const second = await admin.post(`/api/v1/alerts/${alert.id}/resend`).set('x-csrf-token', token);
    expect(second.status).toBe(409);
    expect(second.body).toHaveProperty('error.code', 'CONFLICT');
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    const { h } = await setup();
    const admin = await h.t.loginAs(ADMIN);
    const token = await csrfFor(admin, '/');
    expect(
      (await admin.post(`/api/v1/alerts/${new ObjectId().toHexString()}/resend`).set('x-csrf-token', token))
        .status,
    ).toBe(404);
    expect((await admin.post('/api/v1/alerts/not-an-id/resend').set('x-csrf-token', token)).status).toBe(400);
  });

  it('refuses viewers (403) and anonymous users (401), and needs a CSRF token', async () => {
    const { h, alert } = await setup();
    const viewer = await h.t.loginAs(VIEWER);
    const token = await csrfFor(viewer, '/');
    expect((await viewer.post(`/api/v1/alerts/${alert.id}/resend`).set('x-csrf-token', token)).status).toBe(
      403,
    );
    expect((await h.t.anonymous().post(`/api/v1/alerts/${alert.id}/resend`)).status).toBe(403);
    const admin = await h.t.loginAs(ADMIN);
    expect((await admin.post(`/api/v1/alerts/${alert.id}/resend`)).status).toBe(403);
    expect(
      await h.t.db.collection(COLLECTIONS.ALERTS).findOne({ _id: new ObjectId(alert.id) }),
    ).toMatchObject({ eStatus: 'FAILED' });
  });
});
