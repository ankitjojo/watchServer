import { toObjectId } from '../../utils/objectId.js';
import type { AuditEntryInput, AuditLog, AuditLogDoc } from './audit.types.js';

export function toAuditLog(doc: AuditLogDoc): AuditLog {
  return {
    id: doc._id.toHexString(),
    actorUserId: doc.iActorUserId.toHexString(),
    actorEmail: doc.sActorEmail,
    action: doc.eAction,
    entityType: doc.eEntityType,
    entityId: doc.iEntityId.toHexString(),
    before: doc.oBefore ?? null,
    after: doc.oAfter ?? null,
    at: doc.dAt,
  };
}

export function toAuditLogDoc(
  entry: AuditEntryInput,
  ctx: { now: Date; before: Record<string, unknown> | null; after: Record<string, unknown> | null },
): Omit<AuditLogDoc, '_id'> {
  return {
    iActorUserId: toObjectId(entry.actor.id),
    sActorEmail: entry.actor.email,
    eAction: entry.action,
    eEntityType: entry.entityType,
    iEntityId: toObjectId(entry.entityId),
    oBefore: ctx.before,
    oAfter: ctx.after,
    dAt: ctx.now,
  };
}
