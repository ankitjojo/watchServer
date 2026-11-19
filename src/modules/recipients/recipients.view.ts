import { RECIPIENT_TYPE } from '../../constants/recipientType.js';
import { formatUtc } from '../../utils/time.js';
import type { Recipient } from './recipients.types.js';

export interface RecipientRowView {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  isMaster: boolean;
  created: string;
}

export function toRecipientRowView(recipient: Recipient, timeZone: string): RecipientRowView {
  return {
    id: recipient.id,
    name: recipient.name,
    email: recipient.email,
    isActive: recipient.isActive,
    isMaster: recipient.type === RECIPIENT_TYPE.MASTER,
    created: formatUtc(recipient.createdAt, timeZone),
  };
}

export function toRecipientFormValues(recipient: Recipient): Record<string, unknown> {
  return { name: recipient.name, email: recipient.email, type: recipient.type, isActive: recipient.isActive };
}

export const RECIPIENT_TYPE_OPTIONS = [RECIPIENT_TYPE.NORMAL, RECIPIENT_TYPE.MASTER] as const;
