import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { startControlServer } from './controlServer.js';
import { startFakeEndpoints } from './fakeEndpoints.js';
import { SEEDED_COLLECTIONS, seedSource } from './seed.js';

// ---- guards -------------------------------------------------------------------------------------------
if (process.env['NODE_ENV'] === 'production') {
  process.stderr.write('Refusing to start the sandbox with NODE_ENV=production.\n');
  process.exit(1);
}
// Lets .env override tuning values (for example EMAIL_RETRY_BACKOFF_MIN, to try runbook step 8).
// Connection settings are NEVER taken from it: the sandbox always uses its own throwaway servers.
if (existsSync('.env')) process.loadEnvFile('.env');

const ROOT = path.resolve('.sandbox');
const OUTBOX = path.join(ROOT, 'outbox');
const MONITOR_PORT = 27101;
const SOURCE_PORT = 27102;
const APP_PORT = 3000;
const ENDPOINT_PORT = 4010;
const CONTROL_PORT = 4011;
const MONITOR_DB = 'paymonitor_sandbox';
const SOURCE_DB = 'jojo_source_sandbox';
const ADMIN = { email: 'admin@sandbox.local', password: 'sandbox-admin-pass' };
const MASTER = 'master@sandbox.local';

const FORCED_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: String(APP_PORT),
  MONGO_URI: `mongodb://127.0.0.1:${MONITOR_PORT}`,
  MONGO_DB_NAME: MONITOR_DB,
  SOURCE_MONGO_URI: `mongodb://127.0.0.1:${SOURCE_PORT}`,
  SOURCE_DB_NAME: SOURCE_DB,
  MAIL_TRANSPORT: 'outbox',
  MAIL_OUTBOX_DIR: OUTBOX,
  MAIL_FROM: 'payMonitor sandbox <alerts@sandbox.local>',
  SESSION_SECRET: 'sandbox-only-session-secret-not-a-real-secret',
  SEED_ADMIN_EMAIL: ADMIN.email,
  SEED_ADMIN_PASSWORD: ADMIN.password,
  MASTER_ALERT_EMAIL: MASTER,
  MASTER_ALERT_NAME: 'Sandbox Master',
  DASHBOARD_BASE_URL: `http://localhost:${APP_PORT}`,
};
// Faster than production defaults so the runbook does not take long; .env or the shell can still override.
const DEFAULT_ENV: Record<string, string> = {
  ENDPOINT_RETRY_DELAY_MS: '1000',
  SOURCE_ERROR_GROUP_WINDOW_MS: '20000',
  EMAIL_RETRY_BACKOFF_MIN: '1,1',
  LOG_LEVEL: 'info',
};

// ---- helpers ------------------------------------------------------------------------------------------
function decodeMimeWords(value: string): string {
  // RFC 2047: whitespace between two adjacent encoded words is not part of the text.
  return value
    .replace(/\?=\s+=\?UTF-8\?Q\?/gi, '')
    .replace(/=\?UTF-8\?Q\?(.*?)\?=/gi, (_m, encoded: string) => {
      const bytes: number[] = [];
      const text = encoded.replace(/_/g, ' ');
      for (let i = 0; i < text.length; i++) {
        const hex = /^=([0-9A-F]{2})/i.exec(text.slice(i));
        if (text[i] === '=' && hex?.[1]) {
          bytes.push(parseInt(hex[1], 16));
          i += 2;
        } else {
          bytes.push(text.charCodeAt(i));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    });
}

function header(eml: string, name: string): string {
  const match = new RegExp(`^${name}: ((?:.*)(?:\\r?\\n[ \\t].*)*)`, 'im').exec(eml);
  return decodeMimeWords((match?.[1] ?? '').replace(/\r?\n[ \t]+/g, ' ').trim());
}

async function listOutbox(): Promise<string> {
  const files = existsSync(OUTBOX) ? (await readdir(OUTBOX)).filter((f) => f.endsWith('.eml')).sort() : [];
  const failing = existsSync(path.join(OUTBOX, 'FAIL'));
  if (files.length === 0) return `Outbox is empty.${failing ? ' (mail is currently set to FAIL)' : ''}`;
  const lines: string[] = [];
  for (const file of files) {
    const eml = await readFile(path.join(OUTBOX, file), 'utf8');
    lines.push(
      `${header(eml, 'Date')}  to: ${header(eml, 'To')}\n    ${header(eml, 'Subject')}\n    ${file}`,
    );
  }
  return `${files.length} email(s) in ${OUTBOX}${failing ? ' (mail is currently set to FAIL)' : ''}:\n${lines.join('\n')}`;
}

async function startMongo(port: number, name: string): Promise<MongoMemoryServer> {
  const dbPath = path.join(ROOT, name);
  await mkdir(dbPath, { recursive: true });
  return MongoMemoryServer.create({ instance: { port, dbPath, storageEngine: 'wiredTiger' } });
}

// ---- startup ------------------------------------------------------------------------------------------
await mkdir(OUTBOX, { recursive: true });
process.stdout.write(
  'Starting sandbox databases (the first run downloads a MongoDB binary and can take a minute)...\n',
);
const monitorServer = await startMongo(MONITOR_PORT, 'monitor-db');
const sourceServer = await startMongo(SOURCE_PORT, 'source-db');

async function sourceIsEmpty(): Promise<boolean> {
  const client = await MongoClient.connect(FORCED_ENV['SOURCE_MONGO_URI'] ?? '');
  try {
    return (await client.db(SOURCE_DB).listCollections({}, { nameOnly: true }).toArray()).length === 0;
  } finally {
    await client.close();
  }
}
if (await sourceIsEmpty()) await seedSource(FORCED_ENV['SOURCE_MONGO_URI'] ?? '', SOURCE_DB);

const endpoints = await startFakeEndpoints(ENDPOINT_PORT);

// ---- the app (restartable for `reset`) ------------------------------------------------------------------
let app: ChildProcess | undefined;
function startApp(): void {
  const pretty = spawn('node_modules/.bin/pino-pretty', ['--colorize', '--translateTime', 'SYS:HH:MM:ss'], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  app = spawn('node_modules/.bin/tsx', ['watch', '--clear-screen=false', 'src/server.ts'], {
    env: { ...DEFAULT_ENV, ...process.env, ...FORCED_ENV },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  app.stdout?.pipe(pretty.stdin);
  app.on('exit', () => {
    pretty.stdin.end();
  });
}
async function stopApp(): Promise<void> {
  const child = app;
  app = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.kill('SIGTERM');
    setTimeout(() => {
      child.kill('SIGKILL');
    }, 8000).unref();
  });
}

// ---- control commands -----------------------------------------------------------------------------------
const control = await startControlServer(CONTROL_PORT, {
  async 'insert-webhook'([collection]) {
    if (!collection) throw new Error(`Give a collection name. Seeded: ${SEEDED_COLLECTIONS.join(', ')}`);
    const client = await MongoClient.connect(FORCED_ENV['SOURCE_MONGO_URI'] ?? '');
    try {
      const db = client.db(SOURCE_DB);
      const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
      if (!names.includes(collection)) throw new Error(`No such collection. Existing: ${names.join(', ')}`);
      await db.collection(collection).insertOne({ dCreatedAt: new Date(), sSandbox: true });
      return `Inserted a document dated now into ${collection}.`;
    } finally {
      await client.close();
    }
  },
  async 'source-down'() {
    await sourceServer.stop({ doCleanup: false, force: false });
    return 'Source database stopped. Webhook checks will now report ERROR.';
  },
  async 'source-up'() {
    await sourceServer.start(true);
    return 'Source database started again.';
  },
  'endpoint-status'([code]) {
    const status = Number(code);
    if (!Number.isInteger(status) || status < 100 || status > 599)
      throw new Error('Give an HTTP status, for example 500 or 200.');
    endpoints.setSwitchStatus(status);
    return Promise.resolve(`http://127.0.0.1:${ENDPOINT_PORT}/switch now answers ${status}.`);
  },
  async 'mail-down'() {
    await writeFile(path.join(OUTBOX, 'FAIL'), '');
    return 'Sending email now fails (simulated SMTP outage).';
  },
  async 'mail-up'() {
    await rm(path.join(OUTBOX, 'FAIL'), { force: true });
    return 'Sending email works again.';
  },
  outbox: listOutbox,
  async reset() {
    await stopApp();
    for (const [uri, name] of [
      [FORCED_ENV['MONGO_URI'] ?? '', MONITOR_DB],
      [FORCED_ENV['SOURCE_MONGO_URI'] ?? '', SOURCE_DB],
    ] as const) {
      const client = await MongoClient.connect(uri);
      await client.db(name).dropDatabase();
      await client.close();
    }
    for (const file of existsSync(OUTBOX) ? await readdir(OUTBOX) : [])
      await rm(path.join(OUTBOX, file), { force: true });
    await seedSource(FORCED_ENV['SOURCE_MONGO_URI'] ?? '', SOURCE_DB);
    endpoints.setSwitchStatus(200);
    startApp();
    return 'Sandbox data wiped and re-seeded. The app is restarting.';
  },
});

startApp();

process.stdout.write(`
================ payMonitor sandbox ================
Dashboard : http://localhost:${APP_PORT}   (starts in a few seconds)
Admin     : ${ADMIN.email} / ${ADMIN.password}
Master    : ${MASTER} (receives every alert)
Emails    : ${OUTBOX}  (open the .eml files, or: npm run sandbox:ctl -- outbox)
Endpoints : http://127.0.0.1:${ENDPOINT_PORT}/ok /fail /slow /flaky /redirect-loop /switch
Source    : ${SEEDED_COLLECTIONS.join(', ')}
Control   : npm run sandbox:ctl -- help
Runbook   : docs/implementation_plans/paymonitor-v1-implementation.md section 6
Ctrl+C stops everything (data in .sandbox/ is kept; "reset" wipes it)
====================================================
`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  process.stdout.write('\nStopping the sandbox...\n');
  await stopApp();
  await endpoints.close();
  await new Promise<void>((resolve) => {
    control.close(() => {
      resolve();
    });
  });
  await Promise.allSettled([
    monitorServer.stop({ doCleanup: false }),
    sourceServer.stop({ doCleanup: false }),
  ]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
