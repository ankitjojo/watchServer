import type { AlertRecipient, Recipient, RecipientDoc, RecipientInput } from './recipients.types.js';

export function toRecipient(doc: RecipientDoc): Recipient {
  return {
    id: doc._id.toHexString(),
    name: doc.sName,
    email: doc.sEmail,
    isActive: doc.bIsActive,
    type: doc.eType,
    createdAt: doc.dCreatedAt,
    updatedAt: doc.dUpdatedAt,
    deletedAt: doc.dDeletedAt ?? null,
  };
}

export function toRecipientDoc(input: RecipientInput, ctx: { now: Date }): Omit<RecipientDoc, '_id'> {
  return {
    sName: input.name,
    sEmail: input.email,
    bIsActive: input.isActive,
    eType: input.type,
    bIsDeleted: false,
    dDeletedAt: null,
    iDeletedBy: null,
    dCreatedAt: ctx.now,
    dUpdatedAt: ctx.now,
  };
}

/** `$set` object for edits. Never touches dCreatedAt. */
export function toRecipientUpdate(input: RecipientInput, ctx: { now: Date }): Partial<RecipientDoc> {
  return {
    sName: input.name,
    sEmail: input.email,
    bIsActive: input.isActive,
    eType: input.type,
    dUpdatedAt: ctx.now,
  };
}

export function toAlertRecipient(recipient: Recipient): AlertRecipient {
  return { name: recipient.name, email: recipient.email, type: recipient.type };
}
