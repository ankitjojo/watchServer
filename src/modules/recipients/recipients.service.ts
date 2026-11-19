import { AUDIT_ACTION } from '../../constants/auditAction.js';
import { AUDIT_ENTITY_TYPE } from '../../constants/auditEntityType.js';
import { RECIPIENT_TYPE } from '../../constants/recipientType.js';
import { ConflictError, NotFoundError } from '../../errors/appError.js';
import { ERROR_CODE } from '../../errors/errorCodes.js';
import { isDuplicateKeyError } from '../../errors/mongoErrors.js';
import type { Clock } from '../../types/clock.js';
import type { AuditActor, AuditService } from '../audit/audit.types.js';
import { toAlertRecipient, toRecipientDoc, toRecipientUpdate } from './recipients.mapper.js';
import type { RecipientsRepository } from './recipients.repository.js';
import type { AlertRecipient, Recipient, RecipientAudience, RecipientInput } from './recipients.types.js';

export interface RecipientsService {
  list(): Promise<Recipient[]>;
  getById(id: string): Promise<Recipient>;
  create(input: RecipientInput, actor?: AuditActor): Promise<Recipient>;
  update(id: string, input: RecipientInput, actor: AuditActor): Promise<Recipient>;
  remove(id: string, actor: AuditActor): Promise<void>;
  countMasters(): Promise<number>;
  /** Promotes an existing recipient to an active MASTER (used by the startup seed). */
  ensureMaster(email: string, name: string): Promise<Recipient>;
  /**
   * The only way an alert gets its recipients (FR-A5, FR-A4a).
   * ALL = active normal recipients + every master. MASTERS_ONLY = masters (MONITOR_ERROR).
   */
  resolveAlertRecipients(audience: RecipientAudience): Promise<AlertRecipient[]>;
}

const duplicateEmail = (): ConflictError =>
  new ConflictError('A recipient with this email already exists', ERROR_CODE.CONFLICT, {
    details: { field: 'email' },
  });

export function createRecipientsService(deps: {
  repo: RecipientsRepository;
  audit: AuditService;
  clock: Clock;
}): RecipientsService {
  const { repo, audit, clock } = deps;

  async function load(id: string): Promise<Recipient> {
    const recipient = await repo.findById(id);
    if (!recipient) throw new NotFoundError('Recipient not found');
    return recipient;
  }

  /** FR-R3: masters are always active, so their flag is forced rather than trusted from the form. */
  function normalise(input: RecipientInput): RecipientInput {
    return input.type === RECIPIENT_TYPE.MASTER ? { ...input, isActive: true } : input;
  }

  async function createRecord(input: RecipientInput): Promise<Recipient> {
    try {
      return await repo.insert(toRecipientDoc(normalise(input), { now: clock.now() }));
    } catch (err) {
      if (isDuplicateKeyError(err)) throw duplicateEmail();
      throw err;
    }
  }

  return {
    list: () => repo.list(),
    getById: load,
    countMasters: () => repo.countMasters(),

    async create(input, actor) {
      const recipient = await createRecord(input);
      if (actor) {
        await audit.record({
          actor,
          action: AUDIT_ACTION.CREATE,
          entityType: AUDIT_ENTITY_TYPE.RECIPIENT,
          entityId: recipient.id,
          after: recipient,
        });
      }
      return recipient;
    },

    async update(id, input, actor) {
      const before = await load(id);
      // FR-R3: a master cannot be demoted. (NORMAL to MASTER is allowed, D17.)
      if (before.type === RECIPIENT_TYPE.MASTER && input.type !== RECIPIENT_TYPE.MASTER) {
        throw new ConflictError(
          'A master recipient cannot be changed to a normal recipient',
          ERROR_CODE.MASTER_PROTECTED,
        );
      }
      let after: Recipient | null;
      try {
        after = await repo.update(id, toRecipientUpdate(normalise(input), { now: clock.now() }));
      } catch (err) {
        if (isDuplicateKeyError(err)) throw duplicateEmail();
        throw err;
      }
      if (!after) throw new NotFoundError('Recipient not found');
      await audit.record({
        actor,
        action: AUDIT_ACTION.UPDATE,
        entityType: AUDIT_ENTITY_TYPE.RECIPIENT,
        entityId: id,
        before,
        after,
      });
      return after;
    },

    async remove(id, actor) {
      const before = await load(id);
      if (before.type === RECIPIENT_TYPE.MASTER) {
        throw new ConflictError('A master recipient cannot be deleted', ERROR_CODE.MASTER_PROTECTED);
      }
      if (!(await repo.delete(id))) throw new NotFoundError('Recipient not found');
      await audit.record({
        actor,
        action: AUDIT_ACTION.DELETE,
        entityType: AUDIT_ENTITY_TYPE.RECIPIENT,
        entityId: id,
        before,
      });
    },

    async ensureMaster(email, name) {
      const existing = await repo.findByEmail(email);
      if (!existing) return createRecord({ name, email, type: RECIPIENT_TYPE.MASTER, isActive: true });
      if (existing.type === RECIPIENT_TYPE.MASTER) return existing;
      const promoted = await repo.update(
        existing.id,
        toRecipientUpdate(
          { name: existing.name, email: existing.email, type: RECIPIENT_TYPE.MASTER, isActive: true },
          { now: clock.now() },
        ),
      );
      if (!promoted) throw new NotFoundError('Recipient not found');
      return promoted;
    },

    async resolveAlertRecipients(audience) {
      return (await repo.findAudience(audience)).map(toAlertRecipient);
    },
  };
}
