import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env';
import type { LoginInput, RegisterInput } from './auth.schemas';
import * as authService from './auth.service';

export const REFRESH_COOKIE = 'refresh_token';

const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'lax',
  path: '/api/auth', // the browser only sends it to auth endpoints
};

function sendAuthResult(res: Response, status: number, result: authService.AuthResult): void {
  res.cookie(REFRESH_COOKIE, result.refreshToken, {
    ...cookieOptions,
    expires: result.refreshTokenExpiresAt,
  });
  res.status(status).json({ accessToken: result.accessToken, user: result.user });
}

const readRefreshCookie = (req: Request): string | undefined =>
  (req.cookies as Record<string, string | undefined> | undefined)?.[REFRESH_COOKIE];

export async function register(req: Request, res: Response): Promise<void> {
  sendAuthResult(res, 201, await authService.register(req.body as RegisterInput));
}

export async function login(req: Request, res: Response): Promise<void> {
  sendAuthResult(res, 200, await authService.login(req.body as LoginInput));
}

export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    sendAuthResult(res, 200, await authService.refresh(readRefreshCookie(req)));
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    throw err;
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(readRefreshCookie(req));
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
  res.status(204).end();
}

export async function me(req: Request, res: Response): Promise<void> {
  res.json({ user: await authService.me(req.user!.id) });
}
