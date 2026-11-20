import type { UserCredentials, UserDoc, User, CreateUserInput, UpdateUserInput } from './users.types.js';

export function toUser(doc: UserDoc): User {
  return {
    id: doc._id.toHexString(),
    name: doc.sName,
    email: doc.sEmail,
    role: doc.eRole,
    isActive: doc.bIsActive,
    lastLoginAt: doc.dLastLoginAt ?? null,
    createdAt: doc.dCreatedAt,
    updatedAt: doc.dUpdatedAt,
    deletedAt: doc.dDeletedAt ?? null,
  };
}

export function toUserCredentials(doc: UserDoc): UserCredentials {
  return { user: toUser(doc), passwordHash: doc.sPasswordHash };
}

export function toUserDoc(
  input: CreateUserInput,
  ctx: { now: Date; passwordHash: string },
): Omit<UserDoc, '_id'> {
  return {
    sName: input.name,
    sEmail: input.email,
    sPasswordHash: ctx.passwordHash,
    eRole: input.role,
    bIsActive: input.isActive,
    dLastLoginAt: null,
    bIsDeleted: false,
    dDeletedAt: null,
    iDeletedBy: null,
    dCreatedAt: ctx.now,
    dUpdatedAt: ctx.now,
  };
}

/** `$set` object: only editable fields. The password hash is included only when it changes. */
export function toUserUpdate(
  input: UpdateUserInput,
  ctx: { now: Date; passwordHash?: string },
): Partial<UserDoc> {
  return {
    sName: input.name,
    sEmail: input.email,
    eRole: input.role,
    bIsActive: input.isActive,
    dUpdatedAt: ctx.now,
    ...(ctx.passwordHash === undefined ? {} : { sPasswordHash: ctx.passwordHash }),
  };
}
