import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MailSendError, createMailer, toMailSendError } from '../../../src/notifications/email/transport.js';
import { makeTestConfig } from '../../helpers/testConfig.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'paymonitor-outbox-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const message = {
  to: ['a@x.test', 'b@x.test'],
  subject: '[payMonitor] TEST – Demo',
  text: 'plain body',
  html: '<p>html body</p>',
};

describe('outbox mailer (D11)', () => {
  it('writes the message as an .eml file instead of sending it', async () => {
    const mailer = createMailer(makeTestConfig({ MAIL_OUTBOX_DIR: dir }).mail);
    const result = await mailer.send(message);
    expect(result.messageId).toEqual(expect.any(String));
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.eml$/);
    const eml = await readFile(path.join(dir, files[0] ?? ''), 'utf8');
    // The en dash makes nodemailer encode the header as an RFC 2047 quoted-printable word.
    expect(eml).toContain('Subject: =?UTF-8?Q?=5BpayMonitor=5D_TEST_=E2=80=93_Demo?=');
    expect(eml).toContain('To: a@x.test, b@x.test');
    expect(eml).toContain('plain body');
    expect(eml).toContain('From: payMonitor <alerts@example.test>');
  });

  it('fails like an unreachable SMTP server while a FAIL file exists, and recovers when it is removed', async () => {
    const mailer = createMailer(makeTestConfig({ MAIL_OUTBOX_DIR: dir }).mail);
    await writeFile(path.join(dir, 'FAIL'), '');
    await expect(mailer.send(message)).rejects.toBeInstanceOf(MailSendError);
    await expect(mailer.send(message)).rejects.toMatchObject({ code: 'SMTP_UNREACHABLE' });
    expect((await readdir(dir)).filter((f) => f.endsWith('.eml'))).toHaveLength(0);
    await rm(path.join(dir, 'FAIL'));
    await expect(mailer.send(message)).resolves.toBeDefined();
  });

  it('verify always succeeds (nothing to connect to)', async () => {
    await expect(
      createMailer(makeTestConfig({ MAIL_OUTBOX_DIR: dir }).mail).verify(),
    ).resolves.toBeUndefined();
  });
});

describe('toMailSendError never leaks SMTP details', () => {
  it.each([
    ['ETIMEDOUT', 'SMTP_TIMEOUT'],
    ['ESOCKET', 'SMTP_TIMEOUT'],
    ['ECONNECTION', 'SMTP_UNREACHABLE'],
    ['ECONNREFUSED', 'SMTP_UNREACHABLE'],
    ['ENOTFOUND', 'SMTP_UNREACHABLE'],
    ['EAUTH', 'SMTP_AUTH'],
    ['EENVELOPE', 'SMTP_REJECTED'],
    ['WHATEVER', 'SMTP_ERROR'],
  ])('maps %s to %s', (code, expected) => {
    const error = toMailSendError(
      Object.assign(new Error('connect ECONNREFUSED smtp.secret-host.internal:587 user=bob pass=hunter2'), {
        code,
      }),
    );
    expect(error.code).toBe(expected);
    expect(error.message).not.toMatch(/secret-host|bob|hunter2|587/);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('passes an existing MailSendError through unchanged', () => {
    const original = new MailSendError('SMTP_AUTH', 'x');
    expect(toMailSendError(original)).toBe(original);
  });
});

describe('createMailer', () => {
  it('refuses smtp mode without SMTP settings', () => {
    const config = makeTestConfig();
    expect(() => createMailer({ ...config.mail, transport: 'smtp' })).toThrow(/SMTP/);
  });
});
