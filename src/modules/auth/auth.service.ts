import { AUDIT_ACTION } from '../../constants/auditAction.js';
import { AUDIT_ENTITY_TYPE } from '../../constants/auditEntityType.js';
import type { Logger } from '../../logger/index.js';
import type { Clock } from '../../types/clock.js';
import type { AuthUser } from '../../types/express.js';
import type { AuditService } from '../audit/audit.types.js';
import type { User } from '../users/users.types.js';
import type { UsersService } from '../users/users.service.js';

export interface AuthService {
  /** Returns the user on success, otherwise null (same result for every failure reason). */
  login(email: string, password: string): Promise<AuthUser | null>;
  /** For the session middleware: null when the user is gone or inactive. */
  resolveSessionUser(userId: string): Promise<AuthUser | null>;
}

export interface AuthServiceDeps {
  users: Pick<UsersService, 'authenticate' | 'recordLogin' | 'getActiveById'>;
  audit: AuditService;
  clock: Clock;
  logger: Logger;
}

function toAuthUser(user: User): AuthUser {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { users, audit, clock, logger } = deps;
  return {
    async login(email, password) {
      const user = await users.authenticate(email.trim().toLowerCase(), password);
      if (!user) {
        logger.warn({ event: 'auth.loginFailed' }, 'Login failed');
        return null;
      }
      await users.recordLogin(user.id, clock.now());
      await audit.record({
        actor: { id: user.id, email: user.email },
        action: AUDIT_ACTION.LOGIN,
        entityType: AUDIT_ENTITY_TYPE.USER,
        entityId: user.id,
      });
      logger.info({ event: 'auth.login', userId: user.id }, 'User logged in');
      return toAuthUser(user);
    },
    async resolveSessionUser(userId) {
      const user = await users.getActiveById(userId);
      return user ? toAuthUser(user) : null;
    },
  };
}
