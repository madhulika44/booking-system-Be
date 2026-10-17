import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/config/db';
import { bearer, closeDb, createUser, refreshCookieFrom, resetDb, TEST_PASSWORD } from './helpers';

const app = createApp();

beforeEach(resetDb);
afterAll(closeDb);

describe('POST /api/auth/register', () => {
  it('creates an attendee, returns an access token and sets an httpOnly refresh cookie', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Asha', email: '  Asha@Example.COM ', password: 'longenough' });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email: 'asha@example.com', role: 'attendee' });
    expect(res.body.user.passwordHash).toBeUndefined();

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/refresh_token=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/);

    // only the hash is stored
    const raw = refreshCookieFrom(res.headers['set-cookie']);
    const { rows } = await pool.query('SELECT token_hash FROM refresh_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(raw);
  });

  it('rejects short passwords and bad emails with VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'A', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('rejects duplicate emails', async () => {
    await createUser({ email: 'dup@test.com' });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Dup', email: 'DUP@test.com', password: 'longenough' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials', async () => {
    const user = await createUser({ email: 'login@test.com' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@test.com', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(refreshCookieFrom(res.headers['set-cookie'])).toBeDefined();
  });

  it('returns INVALID_CREDENTIALS for a wrong password or unknown email', async () => {
    await createUser({ email: 'login@test.com' });
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@test.com', password: 'wrong-password' });
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@test.com', password: TEST_PASSWORD });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('blocks inactive users', async () => {
    await createUser({ email: 'blocked@test.com', isActive: false });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'blocked@test.com', password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_BLOCKED');
  });
});

describe('GET /api/auth/me', () => {
  it('requires a token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a garbage token', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('returns the current user', async () => {
    const user = await createUser();
    const res = await request(app).get('/api/auth/me').set(bearer(user));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email });
  });
});

describe('POST /api/auth/refresh (rotation)', () => {
  async function loginAndGetCookie(email = 'rot@test.com') {
    await createUser({ email });
    const res = await request(app).post('/api/auth/login').send({ email, password: TEST_PASSWORD });
    return refreshCookieFrom(res.headers['set-cookie'])!;
  }

  it('rotates: returns a new access token and a different refresh cookie', async () => {
    const first = await loginAndGetCookie();
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${first}`);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    const second = refreshCookieFrom(res.headers['set-cookie']);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('detects reuse of a rotated token and revokes every session of that user', async () => {
    const first = await loginAndGetCookie();
    const rotated = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${first}`);
    const second = refreshCookieFrom(rotated.headers['set-cookie'])!;

    // attacker replays the old token
    const replay = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${first}`);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // the legitimate newer token is now revoked too
    const legit = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${second}`);
    expect(legit.status).toBe(401);

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE revoked_at IS NULL',
    );
    expect(rows[0].n).toBe(0);
  });

  it('rejects missing, unknown and expired tokens', async () => {
    const none = await request(app).post('/api/auth/refresh');
    expect(none.status).toBe(401);

    const unknown = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', 'refresh_token=made-up');
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_REFRESH_TOKEN');

    const token = await loginAndGetCookie();
    await pool.query("UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'");
    const expired = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${token}`);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('does not refresh for a user blocked after logging in', async () => {
    const token = await loginAndGetCookie('later-blocked@test.com');
    await pool.query("UPDATE users SET is_active = false WHERE email = 'later-blocked@test.com'");
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_BLOCKED');
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the refresh token and clears the cookie', async () => {
    await createUser({ email: 'out@test.com' });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'out@test.com', password: TEST_PASSWORD });
    const token = refreshCookieFrom(login.headers['set-cookie'])!;

    const res = await request(app).post('/api/auth/logout').set('Cookie', `refresh_token=${token}`);
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/refresh_token=;/);

    const after = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${token}`);
    expect(after.status).toBe(401);
  });
});

describe('rate limiting', () => {
  it('allows 5 login attempts per minute per IP, then 429', async () => {
    const limitedApp = createApp({ rateLimit: true });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(limitedApp)
        .post('/api/auth/login')
        .send({ email: 'x@test.com', password: 'whatever1' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
