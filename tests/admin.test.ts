import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/config/db';
import { signAccessToken } from '../src/modules/auth/auth.service';
import { createShowFixture } from './fixtures';
import {
  bearer,
  closeDb,
  createUser,
  refreshCookieFrom,
  resetDb,
  TEST_PASSWORD,
  type TestUser,
} from './helpers';

const app = createApp();

beforeEach(resetDb);
afterAll(closeDb);

const as = (user: TestUser) => ({
  get: (url: string) => request(app).get(`/api${url}`).set(bearer(user)),
  post: (url: string, body: object = {}) =>
    request(app).post(`/api${url}`).set(bearer(user)).send(body),
  patch: (url: string, body: object) =>
    request(app).patch(`/api${url}`).set(bearer(user)).send(body),
  delete: (url: string) => request(app).delete(`/api${url}`).set(bearer(user)),
});

it('only admins get in', async () => {
  const organizer = await createUser({ role: 'organizer' });
  expect((await as(organizer).get('/admin/stats')).status).toBe(403);
  expect((await request(app).get('/api/admin/stats')).status).toBe(401);
});

describe('event approval', () => {
  it('lists pending events and approves or rejects them', async () => {
    const admin = await createUser({ role: 'admin' });
    const a = await createShowFixture({ title: 'Pending A', eventStatus: 'pending' });
    const b = await createShowFixture({ title: 'Pending B', eventStatus: 'pending' });
    await createShowFixture({ title: 'Live', eventStatus: 'published' });

    const pending = await as(admin).get('/admin/events?status=pending');
    expect(pending.body.total).toBe(2);
    expect(pending.body.data[0]).toMatchObject({
      status: 'pending',
      organizer: { email: expect.any(String) },
    });

    const approved = await as(admin).post(`/admin/events/${a.eventId}/approve`);
    expect(approved.body.status).toBe('published');
    expect((await request(app).get(`/api/events/${a.slug}`)).status).toBe(200); // now public

    const rejected = await as(admin).post(`/admin/events/${b.eventId}/reject`, {
      reason: 'Poster missing',
    });
    expect(rejected.body).toMatchObject({ status: 'rejected', rejectionReason: 'Poster missing' });

    // only pending events can be reviewed
    const again = await as(admin).post(`/admin/events/${a.eventId}/approve`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('EVENT_NOT_PENDING');

    expect((await as(admin).post(`/admin/events/${b.eventId}/reject`, {})).status).toBe(400); // reason required
  });

  it('a rejected event can be fixed and resubmitted by its organizer', async () => {
    const admin = await createUser({ role: 'admin' });
    const show = await createShowFixture({ eventStatus: 'pending' });
    await as(admin).post(`/admin/events/${show.eventId}/reject`, { reason: 'Fix title' });

    // act as the fixture's organizer (the event's real owner)
    const { rows } = await pool.query<{ organizer_id: string }>(
      'SELECT organizer_id FROM events WHERE id = $1',
      [show.eventId],
    );
    const ownerId = rows[0]!.organizer_id;
    const organizer: TestUser = {
      id: ownerId,
      email: 'owner',
      role: 'organizer',
      token: signAccessToken({ id: ownerId, role: 'organizer' }),
    };

    expect(
      (await as(organizer).patch(`/organizer/events/${show.eventId}`, { title: 'Fixed' })).status,
    ).toBe(200);
    const resubmitted = await as(organizer).post(`/organizer/events/${show.eventId}/submit`);
    expect(resubmitted.body).toMatchObject({ status: 'pending', rejectionReason: null });
  });
});

describe('users', () => {
  it('searches and filters users', async () => {
    const admin = await createUser({ role: 'admin' });
    await createUser({ email: 'priya@test.com' });
    await createUser({ role: 'organizer', email: 'org@test.com' });

    expect(
      (await as(admin).get('/admin/users?q=priya')).body.data.map(
        (u: { email: string }) => u.email,
      ),
    ).toEqual(['priya@test.com']);
    expect((await as(admin).get('/admin/users?role=organizer')).body.total).toBe(1);
    expect((await as(admin).get('/admin/users')).body.total).toBe(3);
  });

  it('promotes a user to organizer', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    const res = await as(admin).patch(`/admin/users/${user.id}`, { role: 'organizer' });
    expect(res.body).toMatchObject({ id: user.id, role: 'organizer', isActive: true });
  });

  it('blocking a user stops login and revokes their sessions', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser({ email: 'victim@test.com' });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'victim@test.com', password: TEST_PASSWORD });
    const cookie = refreshCookieFrom(login.headers['set-cookie']);

    const res = await as(admin).patch(`/admin/users/${user.id}`, { isActive: false });
    expect(res.body.isActive).toBe(false);

    const refresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${cookie}`);
    expect(refresh.status).toBe(401);
    const relogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'victim@test.com', password: TEST_PASSWORD });
    expect(relogin.body.error.code).toBe('ACCOUNT_BLOCKED');
  });

  it("admins can't demote or block themselves", async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await as(admin).patch(`/admin/users/${admin.id}`, { isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_MODIFY_SELF');
  });
});

describe('categories', () => {
  it('CRUD with slug rules', async () => {
    const admin = await createUser({ role: 'admin' });
    const created = await as(admin).post('/admin/categories', { name: 'Stand-up Comedy' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Stand-up Comedy', slug: 'stand-up-comedy' });

    const dup = await as(admin).post('/admin/categories', {
      name: 'Other',
      slug: 'stand-up-comedy',
    });
    expect(dup.body.error.code).toBe('CATEGORY_EXISTS');
    expect(
      (await as(admin).post('/admin/categories', { name: 'X', slug: 'Bad Slug!' })).status,
    ).toBe(400);

    const updated = await as(admin).patch(`/admin/categories/${created.body.id}`, {
      name: 'Comedy',
    });
    expect(updated.body).toMatchObject({ name: 'Comedy', slug: 'stand-up-comedy' });

    const list = await as(admin).get('/admin/categories');
    expect(list.body.data).toEqual([expect.objectContaining({ name: 'Comedy', eventCount: 0 })]);

    expect((await as(admin).delete(`/admin/categories/${created.body.id}`)).status).toBe(204);
  });

  it('refuses to delete a category that events use', async () => {
    const admin = await createUser({ role: 'admin' });
    await createShowFixture({ categorySlug: 'movies' });
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM categories WHERE slug = 'movies'",
    );
    const res = await as(admin).delete(`/admin/categories/${rows[0]!.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_IN_USE');
  });
});

describe('stats', () => {
  it('summarises the platform', async () => {
    const admin = await createUser({ role: 'admin' });
    const show = await createShowFixture();
    await createShowFixture({ eventStatus: 'pending' });
    const buyer = await createUser();
    const hold = await as(buyer).post('/holds', {
      showId: show.showId,
      items: [{ zoneId: show.zones[0]!.id, quantity: 2 }],
    });
    await as(buyer)
      .post('/bookings', {
        holdId: hold.body.holdId,
        payment: { method: 'mock', simulate: 'success' },
      })
      .set('Idempotency-Key', crypto.randomUUID());

    const res = await as(admin).get('/admin/stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      users: { total: 4, attendees: 1, organizers: 2, admins: 1, blocked: 0 },
      events: { published: 1, pending: 1 },
      shows: { upcoming: 2 },
      bookings: { confirmed: 1, cancelled: 0 },
      ticketsSold: 2,
      revenuePaise: 100000,
    });
  });
});
