import { ROLE } from '../../constants/roles.js';
import { formatUtc } from '../../utils/time.js';
import type { DeletedRowView } from '../../utils/deletedRows.js';
import type { User } from './users.types.js';

export interface UserRowView {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  lastLogin: string;
  created: string;
}

export interface UserFormValues {
  name: string;
  email: string;
  role: string;
  isActive: boolean;
}

export function toUserRowView(user: User, timeZone: string): UserRowView {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    lastLogin: user.lastLoginAt ? formatUtc(user.lastLoginAt, timeZone) : 'Never',
    created: formatUtc(user.createdAt, timeZone),
  };
}

export function toUserFormValues(user: User): UserFormValues {
  return { name: user.name, email: user.email, role: user.role, isActive: user.isActive };
}

export const USER_ROLE_OPTIONS = [ROLE.ADMIN, ROLE.VIEWER] as const;

export const USER_DELETED_COLUMNS = ['Name', 'Email', 'Role', 'Status', 'Last login', 'Deleted on (UTC)'];

export function toUserDeletedRow(user: User, timeZone: string): DeletedRowView {
  return {
    cells: [
      user.name,
      user.email,
      user.role,
      'Deleted',
      user.lastLoginAt ? formatUtc(user.lastLoginAt, timeZone) : 'Never',
      user.deletedAt ? formatUtc(user.deletedAt, timeZone) : '—',
    ],
  };
}
