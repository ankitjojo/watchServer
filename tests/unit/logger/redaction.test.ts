import { Writable } from 'node:stream';
import { createLogger } from '../../../src/logger/index.js';

function capture(): { stream: Writable; lines: () => string } {
  let out = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      out += chunk.toString();
      cb();
    },
  });
  return { stream, lines: () => out };
}

describe('logger redaction', () => {
  it('never prints secrets', () => {
    const { stream, lines } = capture();
    const logger = createLogger({ level: 'info', destination: stream });
    logger.info({
      req: { headers: { cookie: 'pm.sid=SECRET-COOKIE', authorization: 'Bearer SECRET-TOKEN' } },
      user: { sPasswordHash: 'SECRET-HASH', password: 'SECRET-PASSWORD' },
      form: { _csrf: 'SECRET-CSRF' },
      db: { uri: 'mongodb://u:SECRET-URI@host' },
      safe: 'visible',
    });
    const text = lines();
    expect(text).not.toContain('SECRET');
    expect(text).toContain('visible');
  });
});
