import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';

export interface RateLimiters {
  auth: RateLimitRequestHandler;
  booking: RateLimitRequestHandler;
}

const onLimit = (_req: Request, res: Response) => {
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down', details: {} },
  });
};

/**
 * Created per app instance (in-memory store) so tests can enable/disable them.
 * auth:    5/min per IP    (login, register)
 * booking: 20/min per user (holds, bookings) — must run after authenticate
 */
export function createRateLimiters(enabled: boolean): RateLimiters {
  const skip = () => !enabled;
  return {
    auth: rateLimit({
      windowMs: 60_000,
      limit: 5,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip,
      handler: onLimit,
    }),
    booking: rateLimit({
      windowMs: 60_000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip,
      handler: onLimit,
      keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
    }),
  };
}
