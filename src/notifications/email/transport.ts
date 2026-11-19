import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import type { Config } from '../../config/loadConfig.js';

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** Resolves only after the server ACCEPTED the message (status SENT means exactly this). */
  send(message: MailMessage): Promise<{ messageId: string }>;
  verify(): Promise<void>;
}

/** A send failed. The message is safe to store and show; the SMTP error stays in `cause`. */
export class MailSendError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailSendError';
    this.code = code;
  }
}

function textProperty(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || !(key in value)) return '';
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : '';
}

/** SMTP errors can contain host names and addresses, so they are mapped to fixed safe texts. */
export function toMailSendError(err: unknown): MailSendError {
  if (err instanceof MailSendError) return err;
  const code = textProperty(err, 'code');
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ETIMEOUT') {
    return new MailSendError('SMTP_TIMEOUT', 'The mail server did not answer in time', { cause: err });
  }
  if (code === 'ECONNECTION' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EDNS') {
    return new MailSendError('SMTP_UNREACHABLE', 'The mail server could not be reached', { cause: err });
  }
  if (code === 'EAUTH') {
    return new MailSendError('SMTP_AUTH', 'The mail server rejected the login', { cause: err });
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    return new MailSendError('SMTP_REJECTED', 'The mail server rejected the message', { cause: err });
  }
  return new MailSendError('SMTP_ERROR', 'The mail server could not accept the message', { cause: err });
}

function createSmtpMailer(mail: Config['mail']): Mailer {
  const smtp = mail.smtp;
  if (!smtp) throw new Error('SMTP settings are required when MAIL_TRANSPORT=smtp');
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: smtp.timeoutMs,
    greetingTimeout: smtp.timeoutMs,
    socketTimeout: smtp.timeoutMs,
  });
  return {
    async send(message) {
      try {
        const info = await transporter.sendMail({ from: mail.from, ...message });
        if (info.accepted.length === 0) {
          throw new MailSendError('SMTP_REJECTED', 'The mail server rejected every recipient');
        }
        return { messageId: info.messageId };
      } catch (err) {
        throw toMailSendError(err);
      }
    },
    async verify() {
      try {
        await transporter.verify();
      } catch (err) {
        throw toMailSendError(err);
      }
    },
  };
}

/**
 * Dev/sandbox transport (D11): writes each message as an .eml file and never touches the network.
 * Creating a file named FAIL in the outbox directory makes sends fail (simulates SMTP being down).
 */
function createOutboxMailer(mail: Config['mail']): Mailer {
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const dir = path.resolve(mail.outboxDir);
  return {
    async send(message) {
      try {
        await access(path.join(dir, 'FAIL'));
        throw new MailSendError('SMTP_UNREACHABLE', 'The mail server could not be reached (simulated)');
      } catch (err) {
        if (err instanceof MailSendError) throw err;
        // No FAIL file: carry on.
      }
      const info = await transporter.sendMail({ from: mail.from, ...message });
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(path.join(dir, `${stamp}-${randomUUID().slice(0, 8)}.eml`), info.message as Buffer);
      return { messageId: info.messageId };
    },
    verify: () => Promise.resolve(),
  };
}

export function createMailer(mail: Config['mail']): Mailer {
  return mail.transport === 'outbox' ? createOutboxMailer(mail) : createSmtpMailer(mail);
}
