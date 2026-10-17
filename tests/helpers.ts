import bcrypt from 'bcrypt';
import { pool } from '../src/config/db';
import type { Role } from '../src/middleware/authenticate';
import { signAccessToken } from '../src/modules/auth/auth.service';

export const TEST_PASSWORD = 'Test@1234';
// Low cost keeps fixtures fast; bcrypt.compare reads the cost from the hash itself
const passwordHash = bcrypt.hashSync(TEST_PASSWORD, 4);

export async function resetDb(): Promise<void> {
  await pool.query(`
    TRUNCATE booking_items, bookings, hold_items, show_seats, holds, show_zones, shows,
             events, layout_seats, layout_zones, layouts, venues, categories, refresh_tokens, users
    RESTART IDENTITY CASCADE`);
}

export interface TestUser {
  id: string;
  email: string;
  role: Role;
  token: string;
}

let userCounter = 0;

export async function createUser(
  overrides: { role?: Role; email?: string; isActive?: boolean } = {},
): Promise<TestUser> {
  userCounter++;
  const role = overrides.role ?? 'attendee';
  const email = overrides.email ?? `user${userCounter}-${Date.now()}@test.com`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`Test User ${userCounter}`, email, passwordHash, role, overrides.isActive ?? true],
  );
  const id = rows[0]!.id;
  return { id, email, role, token: signAccessToken({ id, role }) };
}

export const bearer = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

/** Pulls the raw refresh_token value out of a Set-Cookie header. */
export function refreshCookieFrom(setCookie: string[] | string | undefined): string | undefined {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = cookies.map((c) => /^refresh_token=([^;]*)/.exec(c)).find(Boolean);
  return match?.[1] || undefined;
}

export const closeDb = () => pool.end();
