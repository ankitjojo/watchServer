import type { Clock } from '../../types/clock.js';
import { toAuditLogDoc } from './audit.mapper.js';
import type { AuditRepository } from './audit.repository.js';
import type { AuditService } from './audit.types.js';

const SECRET_KEYS = new Set(['password', 'spassword', 'spasswordhash', 'passwordhash', '_csrf']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** Deep copy without any password / hash / CSRF fields (security rules: never audit secrets). */
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SECRET_KEYS.has(key.toLowerCase()))
        .map(([key, child]) => [key, stripSecrets(child)]),
    );
  }
  return value;
}

function snapshot(value: unknown): Record<string, unknown> | null {
  const cleaned = stripSecrets(value);
  return isPlainObject(cleaned) ? cleaned : null;
}

export function createAuditService(deps: { repo: AuditRepository; clock: Clock }): AuditService {
  return {
    async record(entry) {
      await deps.repo.insert(
        toAuditLogDoc(entry, {
          now: deps.clock.now(),
          before: snapshot(entry.before),
          after: snapshot(entry.after),
        }),
      );
    },
  };
}
