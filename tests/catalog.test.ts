import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/config/db';
import { createShowFixture } from './fixtures';
import { bearer, closeDb, createUser, resetDb } from './helpers';

const app = createApp();
const DAY = 24 * 60 * 60 * 1000;

beforeEach(resetDb);
afterAll(closeDb);

describe('GET /api/categories', () => {
  it('lists categories by name', async () => {
    await pool.query(
      "INSERT INTO categories (name, slug) VALUES ('Movies', 'movies'), ('Comedy', 'comedy')",
    );
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { slug: string }) => c.slug)).toEqual(['comedy', 'movies']);
  });
});

describe('GET /api/events', () => {
  it('returns only published events with upcoming shows, sorted by next show', async () => {
    const later = await createShowFixture({
      title: 'Later Show',
      startsAt: new Date(Date.now() + 5 * DAY),
    });
    const sooner = await createShowFixture({
      title: 'Sooner Show',
      startsAt: new Date(Date.now() + 1 * DAY),
    });
    await createShowFixture({ title: 'Pending One', eventStatus: 'pending' });
    await createShowFixture({ title: 'Past One', startsAt: new Date(Date.now() - DAY) });

    const res = await request(app).get('/api/events');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data.map((e: { slug: string }) => e.slug)).toEqual([sooner.slug, later.slug]);
    expect(res.body.data[0]).toMatchObject({
      title: 'Sooner Show',
      minPricePaise: 50000,
      cities: ['Bengaluru'],
      category: { slug: 'movies' },
    });
  });

  it('filters by search, category, city and date range', async () => {
    await createShowFixture({
      title: 'Jazz Night',
      categorySlug: 'concerts',
      city: 'Mumbai',
      startsAt: new Date(Date.now() + 2 * DAY),
    });
    await createShowFixture({
      title: 'Movie Marathon',
      categorySlug: 'movies',
      city: 'Pune',
      startsAt: new Date(Date.now() + 10 * DAY),
    });

    const slugs = async (qs: string) =>
      (await request(app).get(`/api/events?${qs}`)).body.data.map(
        (e: { title: string }) => e.title,
      );

    expect(await slugs('q=jazz')).toEqual(['Jazz Night']);
    expect(await slugs('q=%25')).toEqual([]); // LIKE wildcards are escaped
    expect(await slugs('category=movies')).toEqual(['Movie Marathon']);
    expect(await slugs('city=mumbai')).toEqual(['Jazz Night']);
    const to = new Date(Date.now() + 5 * DAY).toISOString();
    expect(await slugs(`to=${encodeURIComponent(to)}`)).toEqual(['Jazz Night']);
  });

  it('paginates', async () => {
    for (let i = 0; i < 3; i++)
      await createShowFixture({ startsAt: new Date(Date.now() + (i + 1) * DAY) });
    const res = await request(app).get('/api/events?page=2&limit=2');
    expect(res.body).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(res.body.data).toHaveLength(1);
  });

  it('validates query params', async () => {
    const res = await request(app).get('/api/events?page=0&limit=500');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/events/featured and /api/events/:slug', () => {
  it('returns featured events', async () => {
    await createShowFixture();
    const res = await request(app).get('/api/events/featured');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('returns event detail with upcoming shows and venues', async () => {
    const show = await createShowFixture({ title: 'Detail Event' });
    const res = await request(app).get(`/api/events/${show.slug}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Detail Event', description: 'About Detail Event' });
    expect(res.body.shows).toHaveLength(1);
    expect(res.body.shows[0]).toMatchObject({ id: show.showId, venue: { city: 'Bengaluru' } });
    expect(res.body.venues).toHaveLength(1);
  });

  it('404s for unknown or unpublished events', async () => {
    const draft = await createShowFixture({ eventStatus: 'draft' });
    expect((await request(app).get('/api/events/nope')).status).toBe(404);
    expect((await request(app).get(`/api/events/${draft.slug}`)).status).toBe(404);
  });
});

describe('GET /api/shows/:id', () => {
  it('returns zones with availability = capacity − sold − active holds', async () => {
    const show = await createShowFixture({
      zones: [{ name: 'Pit', type: 'standing', capacity: 10, pricePaise: 100000 }],
    });
    const zoneId = show.zones[0]!.id;
    await pool.query('UPDATE show_zones SET sold_count = 3, held_count = 4 WHERE id = $1', [
      zoneId,
    ]);

    // one active hold of 2 and one expired hold of 2 (not yet cleaned up)
    for (const interval of ['10 minutes', '-1 minute']) {
      const holder = await createUser();
      const hold = await pool.query<{ id: string }>(
        `INSERT INTO holds (user_id, show_id, expires_at) VALUES ($1, $2, now() + $3::interval) RETURNING id`,
        [holder.id, show.showId, interval],
      );
      await pool.query(
        'INSERT INTO hold_items (hold_id, show_zone_id, quantity) VALUES ($1, $2, 2)',
        [hold.rows[0]!.id, zoneId],
      );
    }

    const res = await request(app).get(`/api/shows/${show.showId}`);
    expect(res.status).toBe(200);
    expect(res.body.bookable).toBe(true);
    // 10 − 3 sold − 2 active (the expired hold is ignored)
    expect(res.body.zones[0]).toMatchObject({
      name: 'Pit',
      type: 'standing',
      pricePaise: 100000,
      available: 5,
    });
  });

  it('marks past shows not bookable and 404s for bad ids', async () => {
    const past = await createShowFixture({ startsAt: new Date(Date.now() - DAY) });
    expect((await request(app).get(`/api/shows/${past.showId}`)).body.bookable).toBe(false);
    expect((await request(app).get('/api/shows/not-a-uuid')).status).toBe(400);
    expect((await request(app).get('/api/shows/00000000-0000-4000-8000-000000000000')).status).toBe(
      404,
    );
  });
});

describe('GET /api/shows/:id/seats', () => {
  it('shows effective seat status, treating expired holds as available and flagging mine', async () => {
    const show = await createShowFixture({
      zones: [{ name: 'Gold', type: 'seated', rows: 2, cols: 3, pricePaise: 30000 }],
    });
    const [s1, s2, s3] = show.zones[0]!.seatIds;
    const me = await createUser();
    const other = await createUser();

    const holdFor = async (userId: string, interval: string) =>
      (
        await pool.query<{ id: string; expires_at: Date }>(
          `INSERT INTO holds (user_id, show_id, expires_at) VALUES ($1, $2, now() + $3::interval)
           RETURNING id, expires_at`,
          [userId, show.showId, interval],
        )
      ).rows[0]!;
    const mine = await holdFor(me.id, '10 minutes');
    const expired = await holdFor(other.id, '-1 minute');

    await pool.query(
      "UPDATE show_seats SET status = 'held', hold_id = $2, held_until = $3 WHERE id = $1",
      [s1, mine.id, mine.expires_at],
    );
    await pool.query(
      "UPDATE show_seats SET status = 'held', hold_id = $2, held_until = $3 WHERE id = $1",
      [s2, expired.id, expired.expires_at],
    );
    await pool.query("UPDATE show_seats SET status = 'booked' WHERE id = $1", [s3]);

    const anon = await request(app).get(`/api/shows/${show.showId}/seats`);
    expect(anon.status).toBe(200);
    const zone = anon.body.zones[0];
    expect(zone).toMatchObject({ name: 'Gold', rows: 2, cols: 3 });
    const byId = (body: typeof anon.body) =>
      Object.fromEntries(body.zones[0].seats.map((s: { id: string }) => [s.id, s]));

    const seats = byId(anon.body);
    expect(seats[s1!]).toMatchObject({ status: 'held', mine: false, rowLabel: 'A', seatNumber: 1 });
    expect(seats[s2!]).toMatchObject({ status: 'available' }); // expired hold
    expect(seats[s3!]).toMatchObject({ status: 'booked' });

    const authed = byId(
      (await request(app).get(`/api/shows/${show.showId}/seats`).set(bearer(me))).body,
    );
    expect(authed[s1!]).toMatchObject({ status: 'held', mine: true });
  });
});

describe('GET /api/cities', () => {
  it('lists distinct cities that have upcoming published shows', async () => {
    await createShowFixture({ city: 'Mumbai' });
    await createShowFixture({ city: 'Mumbai' });
    await createShowFixture({ city: 'Pune' });
    await createShowFixture({ city: 'Goa', eventStatus: 'pending' });
    await createShowFixture({ city: 'Delhi', startsAt: new Date(Date.now() - DAY) });

    const res = await request(app).get('/api/cities');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(['Mumbai', 'Pune']);
  });
});

describe('GET /api/events price filter', () => {
  it('matches events with at least one zone inside [minPrice, maxPrice] (paise)', async () => {
    await createShowFixture({
      title: 'Cheap and Pricey',
      zones: [
        { name: 'Back', type: 'standing', capacity: 5, pricePaise: 20000 },
        { name: 'VIP', type: 'standing', capacity: 5, pricePaise: 500000 },
      ],
    });
    await createShowFixture({
      title: 'Mid Only',
      zones: [{ name: 'All', type: 'standing', capacity: 5, pricePaise: 100000 }],
    });

    const titles = async (qs: string) =>
      (await request(app).get(`/api/events?${qs}`)).body.data
        .map((e: { title: string }) => e.title)
        .sort();

    expect(await titles('minPrice=50000&maxPrice=150000')).toEqual(['Mid Only']);
    expect(await titles('maxPrice=30000')).toEqual(['Cheap and Pricey']);
    expect(await titles('minPrice=400000')).toEqual(['Cheap and Pricey']);
    expect(await titles('minPrice=600000')).toEqual([]);
    expect(await titles('')).toEqual(['Cheap and Pricey', 'Mid Only']);

    const bad = await request(app).get('/api/events?minPrice=500&maxPrice=100');
    expect(bad.status).toBe(400);
  });
});
