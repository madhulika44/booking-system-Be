import { pool, type Queryable } from '../../config/db';
import type { Role } from '../../middleware/authenticate';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  is_active: boolean;
  created_at: Date;
  password_hash: string;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  isActive: row.is_active,
  createdAt: row.created_at,
});

// ---------- users ----------

export async function findUserByEmail(email: string): Promise<UserWithPassword | undefined> {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
  const row = rows[0];
  return row && { ...toUser(row), passwordHash: row.password_hash };
}

export async function findUserById(id: string, db: Queryable = pool): Promise<User | undefined> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] && toUser(rows[0]);
}

export async function createUser(input: {
  name: string;
  email: string;
  passwordHash: string;
}): Promise<User> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (name, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.name, input.email, input.passwordHash],
  );
  return toUser(rows[0]!);
}

// ---------- refresh tokens (only SHA-256 hashes are stored) ----------

export async function insertRefreshToken(
  db: Queryable,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await db.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt],
  );
}

/** Locks the row so two concurrent refreshes with the same token can't both rotate it. */
export async function findRefreshTokenForUpdate(
  db: Queryable,
  tokenHash: string,
): Promise<RefreshTokenRecord | undefined> {
  const { rows } = await db.query<{
    id: string;
    user_id: string;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, user_id, expires_at, revoked_at
     FROM refresh_tokens
     WHERE token_hash = $1
     FOR UPDATE`,
    [tokenHash],
  );
  const row = rows[0];
  return (
    row && { id: row.id, userId: row.user_id, expiresAt: row.expires_at, revokedAt: row.revoked_at }
  );
}

export async function revokeRefreshToken(db: Queryable, id: string): Promise<void> {
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [id],
  );
}

export async function revokeRefreshTokenByHash(tokenHash: string): Promise<void> {
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
}

export async function revokeAllRefreshTokensForUser(db: Queryable, userId: string): Promise<void> {
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}
