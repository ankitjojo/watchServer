import { ConflictError, NotFoundError } from '../../../src/errors/appError.js';
import { ERROR_CODE } from '../../../src/errors/errorCodes.js';
import {
  createRecipientsService,
  type RecipientsService,
} from '../../../src/modules/recipients/recipients.service.js';
import { seedMasterRecipient } from '../../../src/modules/recipients/recipients.seed.js';
import { createLogger } from '../../../src/logger/index.js';
import { FakeClock } from '../../helpers/fakeClock.js';
import { createFakeRecipientsRepo } from '../../helpers/fakeRecipientsRepo.js';

const actor = { id: 'a'.repeat(24), email: 'admin@x.test' };

function setup(): { svc: RecipientsService; recorded: { action: string }[] } {
  const recorded: { action: string }[] = [];
  const svc = createRecipientsService({
    repo: createFakeRecipientsRepo(),
    audit: {
      record: (e) => {
        recorded.push({ action: e.action });
        return Promise.resolve();
      },
    },
    clock: new FakeClock(),
  });
  return { svc, recorded };
}

const normal = (email: string, isActive = true) => ({
  name: email,
  email,
  type: 'NORMAL' as const,
  isActive,
});
const master = (email: string) => ({ name: email, email, type: 'MASTER' as const, isActive: true });

describe('resolveAlertRecipients (FR-A5, FR-R2)', () => {
  it('returns active normal recipients plus every master, and skips inactive ones', async () => {
    const { svc } = setup();
    await svc.create(master('m@x.test'));
    await svc.create(normal('a@x.test'));
    await svc.create(normal('off@x.test', false));
    const emails = (await svc.resolveAlertRecipients('ALL')).map((r) => r.email).sort();
    expect(emails).toEqual(['a@x.test', 'm@x.test']);
  });

  it('returns masters only for MONITOR_ERROR (FR-A4a)', async () => {
    const { svc } = setup();
    await svc.create(master('m@x.test'));
    await svc.create(normal('a@x.test'));
    expect((await svc.resolveAlertRecipients('MASTERS_ONLY')).map((r) => r.email)).toEqual(['m@x.test']);
  });

  it('returns an empty list when nobody is eligible (the alert is then stored as FAILED)', async () => {
    const { svc } = setup();
    await svc.create(normal('off@x.test', false));
    await expect(svc.resolveAlertRecipients('ALL')).resolves.toEqual([]);
  });

  it('exposes only name, email and type', async () => {
    const { svc } = setup();
    await svc.create(master('m@x.test'));
    expect(Object.keys((await svc.resolveAlertRecipients('ALL'))[0] ?? {}).sort()).toEqual([
      'email',
      'name',
      'type',
    ]);
  });
});

describe('master protection (FR-R3)', () => {
  it('cannot delete a master', async () => {
    const { svc } = setup();
    const m = await svc.create(master('m@x.test'));
    await expect(svc.remove(m.id, actor)).rejects.toMatchObject({ code: ERROR_CODE.MASTER_PROTECTED });
  });

  it('cannot demote a master to normal', async () => {
    const { svc } = setup();
    const m = await svc.create(master('m@x.test'));
    await expect(svc.update(m.id, normal('m@x.test'), actor)).rejects.toMatchObject({
      code: ERROR_CODE.MASTER_PROTECTED,
    });
  });

  it('cannot deactivate a master: the flag is forced back to active', async () => {
    const { svc } = setup();
    const m = await svc.create(master('m@x.test'));
    const updated = await svc.update(m.id, { ...master('m@x.test'), isActive: false }, actor);
    expect(updated.isActive).toBe(true);
  });

  it('a master created as inactive is stored active', async () => {
    const { svc } = setup();
    expect((await svc.create({ ...master('m@x.test'), isActive: false })).isActive).toBe(true);
  });

  it('allows editing a master name and email', async () => {
    const { svc } = setup();
    const m = await svc.create(master('m@x.test'));
    await expect(
      svc.update(m.id, { ...master('new@x.test'), name: 'New Name' }, actor),
    ).resolves.toMatchObject({
      name: 'New Name',
      email: 'new@x.test',
      type: 'MASTER',
    });
  });

  it('allows promoting a normal recipient to master (D17)', async () => {
    const { svc } = setup();
    const n = await svc.create(normal('a@x.test', false));
    await expect(svc.update(n.id, master('a@x.test'), actor)).resolves.toMatchObject({
      type: 'MASTER',
      isActive: true,
    });
  });

  it('allows deleting a normal recipient', async () => {
    const { svc } = setup();
    const n = await svc.create(normal('a@x.test'));
    await expect(svc.remove(n.id, actor)).resolves.toMatchObject({ isActive: false });
    await expect(svc.getById(n.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('uniqueness and audit', () => {
  it('rejects a duplicate email with a field error', async () => {
    const { svc } = setup();
    await svc.create(normal('a@x.test'));
    await expect(svc.create(normal('a@x.test'))).rejects.toBeInstanceOf(ConflictError);
    await expect(svc.create(normal('a@x.test'))).rejects.toMatchObject({ details: { field: 'email' } });
  });

  it('audits create, update and delete when an actor is given', async () => {
    const { svc, recorded } = setup();
    await svc.create(master('seed@x.test'));
    expect(recorded).toHaveLength(0);
    const n = await svc.create(normal('a@x.test'), actor);
    await svc.update(n.id, { ...normal('a@x.test'), name: 'Renamed' }, actor);
    await svc.remove(n.id, actor);
    expect(recorded.map((r) => r.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
  });
});

describe('seedMasterRecipient', () => {
  const logger = createLogger({ level: 'silent' });

  it('creates a master from the environment when none exists', async () => {
    const { svc } = setup();
    await expect(
      seedMasterRecipient({
        recipients: svc,
        seed: { master: { email: 'Boss@X.test', name: 'Boss' } },
        logger,
      }),
    ).resolves.toBe(true);
    expect(await svc.resolveAlertRecipients('MASTERS_ONLY')).toEqual([
      { name: 'Boss', email: 'boss@x.test', type: 'MASTER' },
    ]);
  });

  it('does nothing when a master already exists', async () => {
    const { svc } = setup();
    await svc.create(master('m@x.test'));
    await expect(seedMasterRecipient({ recipients: svc, seed: {}, logger })).resolves.toBe(false);
  });

  it('fails loudly, naming the variable, when none exists and the env is missing', async () => {
    const { svc } = setup();
    await expect(seedMasterRecipient({ recipients: svc, seed: {}, logger })).rejects.toThrow(
      /MASTER_ALERT_EMAIL/,
    );
  });

  it('promotes an existing recipient with the same email instead of failing', async () => {
    const { svc } = setup();
    await svc.create(normal('boss@x.test', false));
    await seedMasterRecipient({
      recipients: svc,
      seed: { master: { email: 'boss@x.test', name: 'Boss' } },
      logger,
    });
    expect(await svc.resolveAlertRecipients('MASTERS_ONLY')).toHaveLength(1);
  });
});
