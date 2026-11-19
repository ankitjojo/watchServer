import { ROLE } from '../../constants/roles.js';
import type { Config } from '../../config/loadConfig.js';
import type { Logger } from '../../logger/index.js';
import type { UsersService } from '../users/users.service.js';

/** Section 3: create the first admin from .env, only when no users exist yet. */
export async function seedFirstAdmin(deps: {
  users: Pick<UsersService, 'countAll' | 'create'>;
  seed: Config['seed'];
  logger: Logger;
}): Promise<boolean> {
  const { users, seed, logger } = deps;
  if ((await users.countAll()) > 0) return false;
  if (!seed.admin) {
    throw new Error(
      'No users exist yet. Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create the first admin.',
    );
  }
  await users.create({
    name: 'Admin',
    email: seed.admin.email.trim().toLowerCase(),
    role: ROLE.ADMIN,
    password: seed.admin.password,
    isActive: true,
  });
  // Never log the password.
  logger.info({ event: 'seed.admin' }, 'First admin created from environment');
  return true;
}
