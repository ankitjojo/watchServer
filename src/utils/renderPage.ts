import type { Application, Response } from 'express';

function renderToString(app: Application, view: string, data: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    app.render(view, data, (err: Error | null, html?: string) => {
      if (err) reject(err);
      else resolve(html ?? '');
    });
  });
}

/**
 * Renders a page template, then wraps it in the shared layout.
 * Common locals (currentUser, csrfToken, flash, requestId) come from res.locals.
 */
export async function renderPage(
  res: Response,
  view: string,
  model: Record<string, unknown> = {},
  status = 200,
): Promise<void> {
  const locals = { ...res.locals, ...model };
  const body = await renderToString(res.app, view, locals);
  const html = await renderToString(res.app, 'layouts/main', { ...locals, body });
  res.status(status).type('html').send(html);
}
