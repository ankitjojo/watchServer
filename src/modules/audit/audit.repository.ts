import type { Db } from 'mongodb';
import { COLLECTIONS } from '../../constants/collections.js';
import type { AuditLogDoc } from './audit.types.js';

/** Append-only by design: there is no update or delete method (FR-H2). */
export interface AuditRepository {
  insert(doc: Omit<AuditLogDoc, '_id'>): Promise<void>;
}

export function createAuditRepository(db: Db): AuditRepository {
  const logs = db.collection<AuditLogDoc>(COLLECTIONS.AUDIT_LOGS);
  return {
    async insert(doc) {
      await logs.insertOne(doc as AuditLogDoc);
    },
  };
}
