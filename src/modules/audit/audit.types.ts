import type { ObjectId } from 'mongodb';
import type { AuditAction } from '../../constants/auditAction.js';
import type { AuditEntityType } from '../../constants/auditEntityType.js';

export interface AuditActor {
  id: string;
  email: string;
}

export interface AuditEntryInput {
  actor: AuditActor;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/** What other modules depend on. Implemented by audit.service.ts. */
export interface AuditService {
  record(entry: AuditEntryInput): Promise<void>;
}

/**
 * Stored shape (persistence layer only, TD-16). `oBefore` / `oAfter` are opaque snapshots of
 * the domain object (camelCase, secrets stripped): the one documented exception to prefixed names.
 * Audit logs are append-only, so there is `dAt` and no `dUpdatedAt`.
 */
export interface AuditLogDoc {
  _id: ObjectId;
  iActorUserId: ObjectId;
  sActorEmail: string;
  eAction: AuditAction;
  eEntityType: AuditEntityType;
  iEntityId: ObjectId;
  oBefore: Record<string, unknown> | null;
  oAfter: Record<string, unknown> | null;
  dAt: Date;
}

export interface AuditLog {
  id: string;
  actorUserId: string;
  actorEmail: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: Date;
}
