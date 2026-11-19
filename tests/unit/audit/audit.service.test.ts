import { createAuditService, stripSecrets } from '../../../src/modules/audit/audit.service.js';
import type { AuditLogDoc } from '../../../src/modules/audit/audit.types.js';
import { FakeClock } from '../../helpers/fakeClock.js';

describe('stripSecrets', () => {
  it('removes password, hash and csrf fields at every depth without mutating the input', () => {
    const input = {
      name: 'A',
      password: 'p',
      nested: { sPasswordHash: 'h', ok: 1, list: [{ passwordHash: 'x', keep: true }] },
      _csrf: 't',
    };
    const out = stripSecrets(input);
    expect(out).toEqual({ name: 'A', nested: { ok: 1, list: [{ keep: true }] } });
    expect(input.password).toBe('p');
  });

  it('keeps dates and primitives', () => {
    const date = new Date();
    expect(stripSecrets({ d: date, n: 1 })).toEqual({ d: date, n: 1 });
  });
});

describe('audit.service', () => {
  it('stores who, what, when and before/after with secrets stripped', async () => {
    const inserted: Omit<AuditLogDoc, '_id'>[] = [];
    const audit = createAuditService({
      repo: {
        insert: (d) => {
          inserted.push(d);
          return Promise.resolve();
        },
      },
      clock: new FakeClock('2026-11-18T09:00:00Z'),
    });
    await audit.record({
      actor: { id: 'a'.repeat(24), email: 'admin@x.test' },
      action: 'UPDATE',
      entityType: 'USER',
      entityId: 'b'.repeat(24),
      before: { name: 'Old', sPasswordHash: 'SECRET' },
      after: { name: 'New', password: 'SECRET' },
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      sActorEmail: 'admin@x.test',
      eAction: 'UPDATE',
      eEntityType: 'USER',
      oBefore: { name: 'Old' },
      oAfter: { name: 'New' },
      dAt: new Date('2026-11-18T09:00:00Z'),
    });
    expect(JSON.stringify(inserted)).not.toContain('SECRET');
  });

  it('stores null snapshots for create and delete', async () => {
    const inserted: Omit<AuditLogDoc, '_id'>[] = [];
    const audit = createAuditService({
      repo: {
        insert: (d) => {
          inserted.push(d);
          return Promise.resolve();
        },
      },
      clock: new FakeClock(),
    });
    await audit.record({
      actor: { id: 'a'.repeat(24), email: 'x@x.test' },
      action: 'CREATE',
      entityType: 'RECIPIENT',
      entityId: 'b'.repeat(24),
      after: { name: 'N' },
    });
    expect(inserted[0]).toMatchObject({ oBefore: null, oAfter: { name: 'N' } });
  });
});
