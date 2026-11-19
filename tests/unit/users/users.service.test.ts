import { ConflictError, NotFoundError, ValidationError } from '../../../src/errors/appError.js';
import { ERROR_CODE } from '../../../src/errors/errorCodes.js';
import { createUsersService, type UsersService } from '../../../src/modules/users/users.service.js';
import { createPasswordHasher } from '../../../src/utils/password.js';
import { FakeClock } from '../../helpers/fakeClock.js';
import { createFakeUsersRepo } from '../../helpers/fakeUsersRepo.js';

const actor = { id: 'a'.repeat(24), email: 'admin@x.test' };
const PASSWORD = 'a-long-enough-password';

function setup(): { users: UsersService; recorded: unknown[] } {
  const recorded: unknown[] = [];
  const users = createUsersService({
    repo: createFakeUsersRepo(),
    audit: {
      record: (e) => {
        recorded.push(e);
        return Promise.resolve();
      },
    },
    hasher: createPasswordHasher(4),
    clock: new FakeClock(),
  });
  return { users, recorded };
}

const admin = (email: string) => ({
  name: 'A',
  email,
  role: 'ADMIN' as const,
  password: PASSWORD,
  isActive: true,
});
const viewer = (email: string) => ({
  name: 'V',
  email,
  role: 'VIEWER' as const,
  password: PASSWORD,
  isActive: true,
});

describe('users.service', () => {
  it('never returns the password hash', async () => {
    const { users } = setup();
    const created = await users.create(admin('a@x.test'));
    expect(JSON.stringify(created)).not.toMatch(/hash|\$2[aby]\$/i);
    expect(JSON.stringify(await users.list())).not.toMatch(/hash|\$2[aby]\$/i);
  });

  describe('password policy (D3)', () => {
    it('rejects fewer than 12 characters', async () => {
      const { users } = setup();
      await expect(users.create({ ...admin('a@x.test'), password: 'short' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
    it('rejects more than 72 bytes', async () => {
      const { users } = setup();
      await expect(users.create({ ...admin('a@x.test'), password: 'x'.repeat(73) })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(users.create({ ...admin('b@x.test'), password: 'é'.repeat(37) })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
    it('accepts exactly 72 bytes', async () => {
      const { users } = setup();
      await expect(users.create({ ...admin('a@x.test'), password: 'x'.repeat(72) })).resolves.toBeDefined();
    });
  });

  it('rejects a duplicate email with a field-level conflict', async () => {
    const { users } = setup();
    await users.create(admin('a@x.test'));
    await expect(users.create(viewer('a@x.test'))).rejects.toMatchObject({
      code: ERROR_CODE.CONFLICT,
      details: { field: 'email' },
    });
  });

  describe('last active admin protection', () => {
    it('cannot demote the only admin', async () => {
      const { users } = setup();
      const a = await users.create(admin('a@x.test'));
      await expect(
        users.update(a.id, { name: 'A', email: 'a@x.test', role: 'VIEWER', isActive: true }, actor),
      ).rejects.toMatchObject({ code: ERROR_CODE.LAST_ADMIN });
    });
    it('cannot deactivate the only admin', async () => {
      const { users } = setup();
      const a = await users.create(admin('a@x.test'));
      await expect(
        users.update(a.id, { name: 'A', email: 'a@x.test', role: 'ADMIN', isActive: false }, actor),
      ).rejects.toBeInstanceOf(ConflictError);
    });
    it('cannot delete the only admin', async () => {
      const { users } = setup();
      const a = await users.create(admin('a@x.test'));
      await expect(users.remove(a.id, actor)).rejects.toMatchObject({ code: ERROR_CODE.LAST_ADMIN });
    });
    it('ignores inactive admins when counting', async () => {
      const { users } = setup();
      const a = await users.create(admin('a@x.test'));
      await users.create({ ...admin('b@x.test'), isActive: false });
      await expect(users.remove(a.id, actor)).rejects.toMatchObject({ code: ERROR_CODE.LAST_ADMIN });
    });
    it('allows changes when another active admin exists', async () => {
      const { users } = setup();
      const a = await users.create(admin('a@x.test'));
      await users.create(admin('b@x.test'));
      await expect(
        users.update(a.id, { name: 'A', email: 'a@x.test', role: 'VIEWER', isActive: true }, actor),
      ).resolves.toMatchObject({ role: 'VIEWER' });
      await expect(users.remove(a.id, actor)).resolves.toBeUndefined();
    });
    it('does not block editing a viewer', async () => {
      const { users } = setup();
      await users.create(admin('a@x.test'));
      const v = await users.create(viewer('v@x.test'));
      await expect(users.remove(v.id, actor)).resolves.toBeUndefined();
    });
  });

  describe('authenticate', () => {
    it('returns the user for correct credentials', async () => {
      const { users } = setup();
      await users.create(admin('a@x.test'));
      await expect(users.authenticate('a@x.test', PASSWORD)).resolves.toMatchObject({ email: 'a@x.test' });
    });
    it('returns null for wrong password, unknown email and inactive user', async () => {
      const { users } = setup();
      await users.create(admin('a@x.test'));
      await users.create({ ...viewer('off@x.test'), isActive: false });
      await expect(users.authenticate('a@x.test', 'wrong-password-1')).resolves.toBeNull();
      await expect(users.authenticate('nobody@x.test', PASSWORD)).resolves.toBeNull();
      await expect(users.authenticate('off@x.test', PASSWORD)).resolves.toBeNull();
    });
  });

  it('keeps the current password when none is given on edit (D16)', async () => {
    const { users } = setup();
    const a = await users.create(admin('a@x.test'));
    await users.create(admin('b@x.test'));
    await users.update(a.id, { name: 'Renamed', email: 'a@x.test', role: 'ADMIN', isActive: true }, actor);
    await expect(users.authenticate('a@x.test', PASSWORD)).resolves.not.toBeNull();
    await users.update(
      a.id,
      { name: 'Renamed', email: 'a@x.test', role: 'ADMIN', isActive: true, password: 'a-brand-new-password' },
      actor,
    );
    await expect(users.authenticate('a@x.test', PASSWORD)).resolves.toBeNull();
    await expect(users.authenticate('a@x.test', 'a-brand-new-password')).resolves.not.toBeNull();
  });

  it('reports NotFound for unknown ids', async () => {
    const { users } = setup();
    await expect(users.getById('b'.repeat(24))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('audits create, update and delete but not the startup seed', async () => {
    const { users, recorded } = setup();
    const a = await users.create(admin('a@x.test'));
    expect(recorded).toHaveLength(0);
    const b = await users.create(admin('b@x.test'), actor);
    await users.update(b.id, { name: 'B2', email: 'b@x.test', role: 'ADMIN', isActive: true }, actor);
    await users.remove(a.id, actor);
    expect(recorded.map((e) => (e as { action: string }).action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    expect(JSON.stringify(recorded)).not.toMatch(/\$2[aby]\$/);
  });
});
