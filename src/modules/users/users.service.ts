import { ERROR_CODE } from '../../errors/errorCodes.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors/appError.js';
import { isDuplicateKeyError } from '../../errors/mongoErrors.js';
import type { Clock } from '../../types/clock.js';
import type { PasswordHasher } from '../../utils/password.js';
import { AUDIT_ACTION } from '../../constants/auditAction.js';
import { AUDIT_ENTITY_TYPE } from '../../constants/auditEntityType.js';
import type { AuditActor, AuditService } from '../audit/audit.types.js';
import { toUserDoc, toUserUpdate } from './users.mapper.js';
import type { UsersRepository } from './users.repository.js';
import { passwordSchema } from './users.schemas.js';
import type { CreateUserInput, UpdateUserInput, User } from './users.types.js';

export interface UsersService {
  list(): Promise<User[]>;
  getById(id: string): Promise<User>;
  /** Null when the user does not exist or is inactive. Used on every request. */
  getActiveById(id: string): Promise<User | null>;
  countAll(): Promise<number>;
  /** `actor` is absent only for the startup seed, which is logged instead of audited. */
  create(input: CreateUserInput, actor?: AuditActor): Promise<User>;
  update(id: string, input: UpdateUserInput, actor: AuditActor): Promise<User>;
  remove(id: string, actor: AuditActor): Promise<void>;
  /** Returns the user for valid credentials of an active user, otherwise null. Constant-time-ish. */
  authenticate(email: string, password: string): Promise<User | null>;
  recordLogin(id: string, at: Date): Promise<void>;
}

export interface UsersServiceDeps {
  repo: UsersRepository;
  audit: AuditService;
  hasher: PasswordHasher;
  clock: Clock;
}

function checkPassword(password: string): void {
  const result = passwordSchema.safeParse(password);
  if (!result.success) {
    throw new ValidationError('Invalid input', {
      details: result.error.issues.map((i) => ({ path: ['password'], message: i.message })),
    });
  }
}

export function createUsersService(deps: UsersServiceDeps): UsersService {
  const { repo, audit, hasher, clock } = deps;
  let dummyHash: Promise<string> | undefined;

  /** Business rule (section 3): the last active admin cannot be demoted, deactivated or deleted. */
  async function assertNotLastAdmin(existing: User, willStayActiveAdmin: boolean): Promise<void> {
    if (existing.role !== 'ADMIN' || !existing.isActive || willStayActiveAdmin) return;
    if ((await repo.countActiveAdmins()) <= 1) {
      throw new ConflictError('There must be at least one active admin', ERROR_CODE.LAST_ADMIN);
    }
  }

  async function load(id: string): Promise<User> {
    const user = await repo.findById(id);
    if (!user) throw new NotFoundError('User not found');
    return user;
  }

  return {
    list: () => repo.list(),
    getById: load,
    async getActiveById(id) {
      const user = await repo.findById(id);
      return user?.isActive === true ? user : null;
    },
    countAll: () => repo.countAll(),

    async create(input, actor) {
      checkPassword(input.password);
      const passwordHash = await hasher.hash(input.password);
      let user: User;
      try {
        user = await repo.insert(toUserDoc(input, { now: clock.now(), passwordHash }));
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw new ConflictError('A user with this email already exists', ERROR_CODE.CONFLICT, {
            details: { field: 'email' },
          });
        }
        throw err;
      }
      if (actor) {
        await audit.record({
          actor,
          action: AUDIT_ACTION.CREATE,
          entityType: AUDIT_ENTITY_TYPE.USER,
          entityId: user.id,
          after: user,
        });
      }
      return user;
    },

    async update(id, input, actor) {
      const before = await load(id);
      await assertNotLastAdmin(before, input.role === 'ADMIN' && input.isActive);
      let passwordHash: string | undefined;
      if (input.password !== undefined) {
        checkPassword(input.password);
        passwordHash = await hasher.hash(input.password);
      }
      let after: User | null;
      try {
        after = await repo.update(
          id,
          toUserUpdate(input, { now: clock.now(), ...(passwordHash === undefined ? {} : { passwordHash }) }),
        );
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw new ConflictError('A user with this email already exists', ERROR_CODE.CONFLICT, {
            details: { field: 'email' },
          });
        }
        throw err;
      }
      if (!after) throw new NotFoundError('User not found');
      await audit.record({
        actor,
        action: AUDIT_ACTION.UPDATE,
        entityType: AUDIT_ENTITY_TYPE.USER,
        entityId: id,
        before,
        after,
      });
      return after;
    },

    async remove(id, actor) {
      const before = await load(id);
      await assertNotLastAdmin(before, false);
      if (!(await repo.delete(id))) throw new NotFoundError('User not found');
      await audit.record({
        actor,
        action: AUDIT_ACTION.DELETE,
        entityType: AUDIT_ENTITY_TYPE.USER,
        entityId: id,
        before,
      });
    },

    async authenticate(email, password) {
      const credentials = await repo.findCredentialsByEmail(email);
      // Always run one bcrypt comparison so unknown emails take as long as wrong passwords.
      dummyHash ??= hasher.hash('payMonitor-timing-equaliser');
      const hash = credentials?.passwordHash ?? (await dummyHash);
      const matches = await hasher.compare(password, hash);
      if (!credentials || !matches || !credentials.user.isActive) return null;
      return credentials.user;
    },

    recordLogin: (id, at) => repo.touchLastLogin(id, at),
  };
}
