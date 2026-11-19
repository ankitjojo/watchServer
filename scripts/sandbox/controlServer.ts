import { createServer, type Server } from 'node:http';

export type CommandHandler = (args: string[]) => Promise<string>;

/**
 * A tiny control API for `npm run sandbox:ctl`. It binds to 127.0.0.1 only and exists only inside the
 * sandbox process. Each command is a POST /ctl with { command, args }.
 */
export async function startControlServer(
  port: number,
  commands: Record<string, CommandHandler>,
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/ctl') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      void (async () => {
        try {
          const parsed: unknown = JSON.parse(body);
          const command =
            typeof parsed === 'object' &&
            parsed !== null &&
            'command' in parsed &&
            typeof parsed.command === 'string'
              ? parsed.command
              : '';
          const args =
            typeof parsed === 'object' && parsed !== null && 'args' in parsed && Array.isArray(parsed.args)
              ? parsed.args.filter((a): a is string => typeof a === 'string')
              : [];
          const handler = commands[command];
          if (!handler) {
            res
              .writeHead(400, { 'content-type': 'text/plain' })
              .end(`Unknown command "${command}". Known: ${Object.keys(commands).join(', ')}\n`);
            return;
          }
          res.writeHead(200, { 'content-type': 'text/plain' }).end(`${await handler(args)}\n`);
        } catch (err) {
          res
            .writeHead(500, { 'content-type': 'text/plain' })
            .end(`Error: ${err instanceof Error ? err.message : 'failed'}\n`);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
