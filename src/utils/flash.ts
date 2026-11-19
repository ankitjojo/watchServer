import type { Request } from 'express';
import type { FlashMessage } from '../types/express.js';

/** Queues a one-shot message shown on the next page (stored in the session, no extra dependency). */
export function setFlash(req: Request, type: FlashMessage['type'], text: string): void {
  req.session.flash = [...(req.session.flash ?? []), { type, text }];
}

/** Returns queued messages and clears them. */
export function consumeFlash(req: Request): FlashMessage[] {
  const messages = req.session.flash ?? [];
  if (messages.length > 0) delete req.session.flash;
  return messages;
}
