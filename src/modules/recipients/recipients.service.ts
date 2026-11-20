import { AUDIT_ACTION } from '../../constants/auditAction.js';
import { AUDIT_ENTITY_TYPE } from '../../constants/auditEntityType.js';
import { RECIPIENT_TYPE } from '../../constants/recipientType.js';
import { ConflictError, NotFoundError } from '../../errors/appError.js';
import { ERROR_CODE } from '../../errors/errorCodes.js';
import { isDuplicateKeyError } from '../../errors/mongoErrors.js';
import { toObjectId } from '../../utils/objectId.js';
import type { Clock } from '../../types/clock.js';
import type { AuditActor, AuditService } from '../audit/audit.types.js';
import { toAlertRecipient, toRecipientDoc, toRecipientUpdate } from './recipients.mapper.js';
import type { RecipientsRepository } from './recipients.repository.js';
import type { AlertRecipient, Recipient, RecipientAudience, RecipientInput } from './recipients.types.js';

export interface RecipientsService {
  list(): Promise<Recipient[]>;
  /** Newest deletion first (the Deleted records dropdown). */
  listDeleted(): Promise<Recipient[]>;
  getById(id: string): Promise<Recipient>;
  create(input: RecipientInput, actor?: AuditActor): Promise<Recipient>;
  update(id: string, input: RecipientInput, actor: AuditActor): Promise<Recipient>;
  /** Soft delete (TD-36): inactive, kept, no longer in any new alert audience. Returns the deleted recipient. */
  remove(id: string, actor: AuditActor): Promise<Recipient>;
  /**
   * Not routed yet. Clears the deleted markers; the recipient comes back inactive. Fails with
   * EMAIL_IN_USE when an active recipient has taken the email since.
   */
  restore(id: string, actor: AuditActor): Promise<Recipient>;
  countMasters(): Promise<number>;
  /** Promotes an existing recipient to an active MASTER (used by the startup seed). */
  ensureMaster(email: string, name: string): Promise<Recipient>;
  /**
   * The only way an alert gets its recipients (FR-A5, FR-A4a).
   * ALL = active normal recipients + every master. MASTERS_ONLY = masters (MONITOR_ERROR).
   */
  resolveAlertRecipients(audience: RecipientAudience): Promise<AlertRecipient[]>;
}

const emailInUse = (): ConflictError =>
  new ConflictError(
    'An active recipient already uses this email, so the deleted one cannot be restored',
    ERROR_CODE.EMAIL_IN_USE,
    { details: { field: 'email' } },
  );

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
    listDeleted: () => repo.listDeleted(),
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
      const deleted = await repo.softDelete(id, clock.now(), toObjectId(actor.id));
      if (!deleted) throw new NotFoundError('Recipient not found');
      await audit.record({
        actor,
        action: AUDIT_ACTION.DELETE,
        entityType: AUDIT_ENTITY_TYPE.RECIPIENT,
        entityId: id,
        before,
        after: deleted,
      });
      return deleted;
    },

    async restore(id, actor) {
      const before = await repo.findByIdIncludingDeleted(id);
      if (!before?.deletedAt) throw new NotFoundError('Deleted recipient not found');
      const holder = await repo.findByEmail(before.email);
      if (holder && holder.id !== id && holder.deletedAt === null) throw emailInUse();
      let restored: Recipient | null;
      try {
        restored = await repo.restore(id, clock.now());
      } catch (err) {
        if (isDuplicateKeyError(err)) throw emailInUse();
        throw err;
      }
      if (!restored) throw new NotFoundError('Deleted recipient not found');
      await audit.record({
        actor,
        action: AUDIT_ACTION.RESTORE,
        entityType: AUDIT_ENTITY_TYPE.RECIPIENT,
        entityId: id,
        before,
        after: restored,
      });
      return restored;
    },

    async ensureMaster(email, name) {
      const existing = await repo.findByEmail(email);
      if (!existing) return createRecord({ name, email, type: RECIPIENT_TYPE.MASTER, isActive: true });
      if (existing.deletedAt) {
        // The env master email belongs to a deleted recipient: bring it back as the master (FR-R3).
        let restored: Recipient | null;
        try {
          restored = await repo.restore(existing.id, clock.now(), {
            eType: RECIPIENT_TYPE.MASTER,
            bIsActive: true,
          });
        } catch (err) {
          if (isDuplicateKeyError(err)) throw emailInUse();
          throw err;
        }
        if (!restored) throw new NotFoundError('Recipient not found');
        return restored;
      }
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
