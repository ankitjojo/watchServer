import { createInterface } from 'node:readline/promises';

const CONTROL_PORT = 4011;
const [command, ...args] = process.argv.slice(2);

const HELP = `Usage: npm run sandbox:ctl -- <command> [args]

  insert-webhook <collection>   add a document dated now to a source collection (a gateway "recovers")
  source-down                   stop the source database (webhook checks report ERROR)
  source-up                     start it again
  endpoint-status <code>        make http://127.0.0.1:4010/switch answer with this status (200, 500, ...)
  mail-down                     make sending email fail (simulates SMTP being down)
  mail-up                       make sending work again
  outbox                        list the emails "sent" so far (subject, recipients, time)
  reset                         wipe all sandbox data and start fresh (asks first)`;

if (!command || command === 'help' || command === '--help') {
  process.stdout.write(`${HELP}\n`);
  process.exit(command ? 0 : 1);
}

if (command === 'reset') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    'This deletes ALL sandbox data (monitors, alerts, emails). Continue? [y/N] ',
  );
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    process.stdout.write('Cancelled.\n');
    process.exit(0);
  }
}

try {
  const response = await fetch(`http://127.0.0.1:${CONTROL_PORT}/ctl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });
  process.stdout.write(await response.text());
  process.exit(response.ok ? 0 : 1);
} catch {
  process.stderr.write('Cannot reach the sandbox. Is `npm run sandbox` running in another terminal?\n');
  process.exit(1);
}
