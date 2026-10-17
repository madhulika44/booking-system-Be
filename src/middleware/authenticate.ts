import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { unauthorized } from '../utils/app-error';

export type Role = 'attendee' | 'organizer' | 'admin';

export interface AuthUser {
  id: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface AccessTokenPayload {
  sub: string;
  role: Role;
}

function readBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

function verifyAccessToken(token: string): AuthUser {
  try {
    const payload = jwt.verify(token, env.jwtAccessSecret, {
      algorithms: ['HS256'],
    }) as unknown as AccessTokenPayload;
    return { id: payload.sub, role: payload.role };
  } catch {
    throw unauthorized('Access token is invalid or expired', 'INVALID_TOKEN');
  }
}

/** Requires a valid access token; sets req.user. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = readBearerToken(req);
  if (!token) return next(unauthorized());
  req.user = verifyAccessToken(token);
  next();
}

/** Sets req.user when a valid token is present, but never rejects (public endpoints). */
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = readBearerToken(req);
  if (token) {
    try {
      req.user = verifyAccessToken(token);
    } catch {
      // ignore bad tokens on public routes
    }
  }
  next();
}
