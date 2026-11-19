import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createPasswordHasher } from '../../../src/utils/password.js';

const SRC = path.resolve(import.meta.dirname, '../../../src');

describe('password hashing (security 2.3)', () => {
  it('bcrypt hashes carry the cost they were made with, and verify only the right password', async () => {
    const hasher = createPasswordHasher(12);
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await hasher.compare('correct horse battery staple', hash)).toBe(true);
    expect(await hasher.compare('wrong', hash)).toBe(false);
    expect(hash).not.toContain('correct horse');
  }, 30_000);

  it('production wiring uses cost 12 (tests inject a cheaper hasher)', () => {
    expect(readFileSync(path.join(SRC, 'compositionRoot.ts'), 'utf8')).toMatch(/createPasswordHasher\(12\)/);
  });
});

describe('session cookie settings (security 2.5)', () => {
  const app = readFileSync(path.join(SRC, 'app.ts'), 'utf8');
  it('is httpOnly, sameSite lax, secure in production, named pm.sid, and never saved for anonymous users', () => {
    expect(app).toMatch(/name:\s*'pm\.sid'/);
    expect(app).toMatch(/httpOnly:\s*true/);
    expect(app).toMatch(/sameSite:\s*'lax'/);
    expect(app).toMatch(/secure:\s*config\.env === 'production'/);
    expect(app).toMatch(/saveUninitialized:\s*false/);
  });
  it('never enables CORS (security 2.2)', () => {
    expect(app).not.toMatch(/cors/i);
  });
});
