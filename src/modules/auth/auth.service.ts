import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { withTransaction } from '../../config/db';
import { env } from '../../config/env';
import { AppError, conflict, notFound, unauthorized } from '../../utils/app-error';
import * as repo from './auth.repository';
import type { User } from './auth.repository';
import type { LoginInput, RegisterInput } from './auth.schemas';

const BCRYPT_COST = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthResult {
  accessToken: string;
  user: User;
  /** Raw refresh token — goes into the httpOnly cookie, never into the JSON body. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

// ---------- token helpers ----------

export function signAccessToken(user: Pick<User, 'id' | 'role'>): string {
  return jwt.sign({ role: user.role }, env.jwtAccessSecret, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: env.accessTokenTtl as SignOptions['expiresIn'],
  });
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function issueTokens(user: User, db: Parameters<typeof repo.insertRefreshToken>[0]) {
  const refreshToken = randomBytes(48).toString('base64url');
  const refreshTokenExpiresAt = new Date(Date.now() + env.refreshTokenTtlDays * DAY_MS);
  await repo.insertRefreshToken(db, user.id, hashToken(refreshToken), refreshTokenExpiresAt);
  return {
    accessToken: signAccessToken(user),
    user,
    refreshToken,
    refreshTokenExpiresAt,
  };
}

const accountBlocked = () =>
  new AppError(403, 'ACCOUNT_BLOCKED', 'This account has been blocked. Contact support.');

// Compared against when the email doesn't exist, so response time doesn't reveal which emails are registered
let dummyHash: string | undefined;
const getDummyHash = async () =>
  (dummyHash ??= await bcrypt.hash('not-a-real-password', BCRYPT_COST));

// ---------- use cases ----------

export async function register(input: RegisterInput): Promise<AuthResult> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  let user: User;
  try {
    user = await repo.createUser({ name: input.name, email: input.email, passwordHash });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    throw err;
  }
  return withTransaction((client) => issueTokens(user, client));
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await repo.findUserByEmail(input.email);
  const passwordOk = await bcrypt.compare(
    input.password,
    user?.passwordHash ?? (await getDummyHash()),
  );
  if (!user || !passwordOk) {
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (!user.isActive) throw accountBlocked();

  const { passwordHash: _omit, ...publicUser } = user;
  return withTransaction((client) => issueTokens(publicUser, client));
}

/**
 * Refresh-token rotation:
 *  - valid token  → revoke it and issue a fresh pair (each token works exactly once)
 *  - revoked token presented again → someone replayed a stolen token, so revoke
 *    every token of that user and force a fresh login everywhere.
 */
export async function refresh(rawToken: string | undefined): Promise<AuthResult> {
  if (!rawToken) throw unauthorized('No refresh token', 'INVALID_REFRESH_TOKEN');
  const tokenHash = hashToken(rawToken);

  // The transaction returns an outcome instead of throwing, so the "revoke all" on reuse is committed.
  const outcome = await withTransaction(async (client) => {
    const record = await repo.findRefreshTokenForUpdate(client, tokenHash);
    if (!record) return { kind: 'invalid' as const };

    if (record.revokedAt) {
      await repo.revokeAllRefreshTokensForUser(client, record.userId);
      return { kind: 'reused' as const };
    }
    if (record.expiresAt <= new Date()) return { kind: 'invalid' as const };

    const user = await repo.findUserById(record.userId, client);
    await repo.revokeRefreshToken(client, record.id);
    if (!user || !user.isActive) return { kind: 'blocked' as const };

    return { kind: 'ok' as const, result: await issueTokens(user, client) };
  });

  switch (outcome.kind) {
    case 'ok':
      return outcome.result;
    case 'reused':
      throw unauthorized(
        'Refresh token was already used. Please log in again.',
        'REFRESH_TOKEN_REUSED',
      );
    case 'blocked':
      throw accountBlocked();
    default:
      throw unauthorized('Refresh token is invalid or expired', 'INVALID_REFRESH_TOKEN');
  }
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (rawToken) await repo.revokeRefreshTokenByHash(hashToken(rawToken));
}

export async function me(userId: string): Promise<User> {
  const user = await repo.findUserById(userId);
  if (!user) throw notFound('User');
  return user;
}
