import type { Response } from 'express';

/** JSON success envelope for /api/v1 (api-standards 2). Errors go through the error handler. */
export function sendData(
  res: Response,
  data: unknown,
  options: { status?: number; meta?: unknown } = {},
): void {
  res.status(options.status ?? 200).json({
    success: true,
    data,
    ...(options.meta === undefined ? {} : { meta: options.meta }),
  });
}
