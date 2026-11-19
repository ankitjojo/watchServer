import type { ObjectId } from 'mongodb';
import type { Role } from '../../constants/roles.js';

/** Stored shape (persistence layer only, TD-16). */
export interface UserDoc {
  _id: ObjectId;
  sName: string;
  sEmail: string;
  sPasswordHash: string;
  eRole: Role;
  bIsActive: boolean;
  dLastLoginAt: Date | null;
  dCreatedAt: Date;
  dUpdatedAt: Date;
}

/** Domain shape. Deliberately has no password hash. */
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserCredentials {
  user: User;
  passwordHash: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
  role: Role;
  password: string;
  isActive: boolean;
}

export interface UpdateUserInput {
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  /** Blank/undefined keeps the current password (D16). */
  password?: string | undefined;
}
