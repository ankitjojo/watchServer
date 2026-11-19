import 'express-session';
import type { Role } from '../constants/roles.js';

/** The logged-in dashboard user as seen by requests (never contains the password hash). */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface FlashMessage {
  type: 'success' | 'warning' | 'error' | 'info';
  text: string;
}

/** Result of a failed form validation, kept so the page can re-render with the entered values. */
export interface FormFailure {
  errors: Record<string, string>;
  values: Record<string, unknown>;
}

declare global {
  // Declaration merging is the only supported way to type Express request/locals extensions.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      user?: AuthUser;
    }
    interface Locals {
      requestId: string;
      currentUser?: AuthUser;
      csrfToken?: string;
      flash: FlashMessage[];
      validated?: { params: unknown; query: unknown; body: unknown };
      formFailure?: FormFailure;
    }
  }
}

declare module 'express-session' {
  interface SessionData {
    userId: string;
    flash: FlashMessage[];
  }
}
