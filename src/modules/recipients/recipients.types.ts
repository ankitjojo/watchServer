import type { ObjectId } from 'mongodb';
import type { RecipientType } from '../../constants/recipientType.js';

/** Stored shape (persistence layer only, TD-16). */
export interface RecipientDoc {
  _id: ObjectId;
  sName: string;
  sEmail: string;
  bIsActive: boolean;
  eType: RecipientType;
  /** Soft delete (TD-36). A missing field on old documents means not deleted. */
  bIsDeleted: boolean;
  dDeletedAt: Date | null;
  iDeletedBy: ObjectId | null;
  dCreatedAt: Date;
  dUpdatedAt: Date;
}

export interface Recipient {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  type: RecipientType;
  createdAt: Date;
  updatedAt: Date;
  /** Set once deleted: the recipient is inactive and only listed under Deleted records. */
  deletedAt: Date | null;
}

export interface RecipientInput {
  name: string;
  email: string;
  type: RecipientType;
  isActive: boolean;
}

/** Who receives one alert email, resolved when the alert is created (FR-A5). */
export interface AlertRecipient {
  name: string;
  email: string;
  type: RecipientType;
}

export type RecipientAudience = 'ALL' | 'MASTERS_ONLY';
