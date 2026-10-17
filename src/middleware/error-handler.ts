import type { NextFunction, Request, Response } from 'express';
import { logger } from '../config/logger';
import { AppError } from '../utils/app-error';

interface PgError {
  code: string;
  constraint?: string;
}

function isPgError(err: unknown): err is PgError {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;

  // Malformed JSON body (from express.json)
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: string }).type === 'entity.parse.failed'
  ) {
    return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }

  if (isPgError(err)) {
    switch (err.code) {
      case '23505': // unique_violation
        return new AppError(409, 'CONFLICT', 'Resource already exists or is being modified', {
          constraint: err.constraint,
        });
      case '23514': // check_violation, e.g. show_zones_inventory_check (never oversell)
        return new AppError(409, 'INVENTORY_CONFLICT', 'Not enough inventory available', {
          constraint: err.constraint,
        });
      case '40P01': // deadlock_detected
      case '40001': // serialization_failure
        return new AppError(409, 'CONCURRENT_UPDATE', 'Busy right now, please try again');
    }
  }
  return undefined;
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found`, details: {} },
  });
}

// Express recognises error handlers by their 4 arguments
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appError = toAppError(err);
  if (appError) {
    if (appError.status >= 500) logger.error({ err }, appError.message);
    res.status(appError.status).json({
      error: { code: appError.code, message: appError.message, details: appError.details ?? {} },
    });
    return;
  }

  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', details: {} },
  });
}
