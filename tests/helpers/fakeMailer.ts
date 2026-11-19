import { MailSendError, type MailMessage, type Mailer } from '../../src/notifications/email/transport.js';

export interface FakeMailer extends Mailer {
  sent: (MailMessage & { messageId: string })[];
  /** Number of upcoming sends that fail. */
  failNext: number;
  failAlways: boolean;
  attempts: number;
  /** Runs inside send(), before the outcome. Tests use it to inspect the database at that moment. */
  beforeSend?: (message: MailMessage) => Promise<void>;
}

export function createFakeMailer(): FakeMailer {
  const fake: FakeMailer = {
    sent: [],
    failNext: 0,
    failAlways: false,
    attempts: 0,
    async send(message) {
      fake.attempts++;
      if (fake.beforeSend) await fake.beforeSend(message);
      if (fake.failAlways || fake.failNext > 0) {
        if (fake.failNext > 0) fake.failNext--;
        throw new MailSendError('SMTP_UNREACHABLE', 'The mail server could not be reached');
      }
      const messageId = `<fake-${fake.sent.length + 1}@test>`;
      fake.sent.push({ ...message, messageId });
      return { messageId };
    },
    verify: () => Promise.resolve(),
  };
  return fake;
}
