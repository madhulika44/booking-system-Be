import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/config/db';
import { rowLabelFor } from '../src/modules/venues/layout-grid';
import { bearer, closeDb, createUser, resetDb, type TestUser } from './helpers';

const app = createApp();
const DAY = 24 * 60 * 60 * 1000;

beforeEach(resetDb);
afterAll(closeDb);

let categoryId: string;
beforeEach(async () => {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO categories (name, slug) VALUES ('Concerts', 'concerts') RETURNING id",
  );
  categoryId = rows[0]!.id;
});

const api = (user: TestUser) => ({
  get: (url: string) => request(app).get(`/api${url}`).set(bearer(user)),
  post: (url: string, body: object = {}) =>
    request(app).post(`/api${url}`).set(bearer(user)).send(body),
  patch: (url: string, body: object) =>
    request(app).patch(`/api${url}`).set(bearer(user)).send(body),
  put: (url: string, body: object) => request(app).put(`/api${url}`).set(bearer(user)).send(body),
  delete: (url: string) => request(app).delete(`/api${url}`).set(bearer(user)),
});

const arenaLayout = {
  name: 'Main Arena',
  zones: [
    { name: 'Fan Pit', type: 'standing', capacity: 5 },
    // 2 rows × 4 cols, an aisle at column 3 of every row and one disabled seat
    {
      name: 'Gold',
      type: 'seated',
      rows: 2,
      cols: 4,
      cells: [
        { row: 1, col: 3, kind: 'aisle' },
        { row: 2, col: 3, kind: 'aisle' },
        { row: 2, col: 4, kind: 'disabled' },
      ],
    },
    { name: 'Silver', type: 'seated', rows: 2, cols: 2 },
  ],
};

/** organizer → venue → layout → event (+ optional publish) → show */
async function setupShow(organizer: TestUser, opts: { publish?: boolean; startsAt?: Date } = {}) {
  const o = api(organizer);
  const venue = (
    await o.post('/organizer/venues', { name: 'Arena', address: '1 Road', city: 'Mumbai' })
  ).body;
  const layout = (await o.post(`/organizer/venues/${venue.id}/layouts`, arenaLayout)).body;
  const event = (await o.post('/organizer/events', { title: 'Big Gig', categoryId })).body;
  const zonePrices = layout.zones.map((z: { id: string }, i: number) => ({
    layoutZoneId: z.id,
    pricePaise: (i + 1) * 10000,
  }));
  const show = await o.post(`/organizer/events/${event.id}/shows`, {
    venueId: venue.id,
    layoutId: layout.id,
    startsAt: (opts.startsAt ?? new Date(Date.now() + 3 * DAY)).toISOString(),
    zonePrices,
  });
  if (opts.publish) {
    await pool.query("UPDATE events SET status = 'published' WHERE id = $1", [event.id]);
  }
  return { venue, layout, event, show: show.body, showRes: show };
}

describe('access control', () => {
  it('attendees get 403, anonymous gets 401', async () => {
    const attendee = await createUser();
    expect((await api(attendee).get('/organizer/venues')).status).toBe(403);
    expect((await request(app).get('/api/organizer/venues')).status).toBe(401);
  });

  it("organizers can't see or touch each other's venues, layouts, events or shows (404)", async () => {
    const [owner, other] = [
      await createUser({ role: 'organizer' }),
      await createUser({ role: 'organizer' }),
    ];
    const { venue, layout, event, show } = await setupShow(owner);
    const x = api(other);

    expect((await x.get('/organizer/venues')).body.data).toHaveLength(0);
    expect((await x.get(`/organizer/venues/${venue.id}`)).status).toBe(404);
    expect((await x.patch(`/organizer/venues/${venue.id}`, { name: 'Mine now' })).status).toBe(404);
    expect((await x.delete(`/organizer/venues/${venue.id}`)).status).toBe(404);
    expect((await x.get(`/organizer/layouts/${layout.id}`)).status).toBe(404);
    expect((await x.put(`/organizer/layouts/${layout.id}`, arenaLayout)).status).toBe(404);
    expect((await x.get(`/organizer/events/${event.id}`)).status).toBe(404);
    expect((await x.post(`/organizer/events/${event.id}/submit`)).status).toBe(404);
    expect((await x.post(`/organizer/shows/${show.id}/cancel`)).status).toBe(404);
    expect((await x.get(`/organizer/shows/${show.id}/bookings`)).status).toBe(404);
    expect((await x.get('/organizer/events')).body.total).toBe(0);

    // nor create a show on someone else's venue
    const myEvent = (await x.post('/organizer/events', { title: 'Mine', categoryId })).body;
    const res = await x.post(`/organizer/events/${myEvent.id}/shows`, {
      venueId: venue.id,
      layoutId: layout.id,
      startsAt: new Date(Date.now() + DAY).toISOString(),
      zonePrices: layout.zones.map((z: { id: string }) => ({
        layoutZoneId: z.id,
        pricePaise: 100,
      })),
    });
    expect(res.status).toBe(404);
  });

  it('admins can see every organizer’s data', async () => {
    const owner = await createUser({ role: 'organizer' });
    const admin = await createUser({ role: 'admin' });
    const { venue, event } = await setupShow(owner);
    expect((await api(admin).get(`/organizer/venues/${venue.id}`)).status).toBe(200);
    expect((await api(admin).get(`/organizer/events/${event.id}`)).status).toBe(200);
  });
});

describe('venues', () => {
  it('CRUD', async () => {
    const o = api(await createUser({ role: 'organizer' }));
    const created = await o.post('/organizer/venues', {
      name: 'Hall',
      address: '2 Lane',
      city: 'Pune',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Hall', city: 'Pune', layoutCount: 0 });

    const updated = await o.patch(`/organizer/venues/${created.body.id}`, { city: 'Goa' });
    expect(updated.body).toMatchObject({ name: 'Hall', city: 'Goa' });
    expect((await o.get('/organizer/venues')).body.data).toHaveLength(1);

    expect((await o.delete(`/organizer/venues/${created.body.id}`)).status).toBe(204);
    expect((await o.get(`/organizer/venues/${created.body.id}`)).status).toBe(404);
  });

  it('cannot delete a venue (or its layout) that has shows', async () => {
    const organizer = await createUser({ role: 'organizer' });
    const { venue, layout } = await setupShow(organizer);
    const res = await api(organizer).delete(`/organizer/venues/${venue.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VENUE_IN_USE');
    const lay = await api(organizer).delete(`/organizer/layouts/${layout.id}`);
    expect(lay.body.error.code).toBe('LAYOUT_IN_USE');
  });

  it('validates input', async () => {
    const o = api(await createUser({ role: 'organizer' }));
    const res = await o.post('/organizer/venues', { name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('layouts', () => {
  it('builds the seat grid with row letters continuing across zones', async () => {
    const o = api(await createUser({ role: 'organizer' }));
    const venue = (await o.post('/organizer/venues', { name: 'V', address: 'A', city: 'C' })).body;
    const res = await o.post(`/organizer/venues/${venue.id}/layouts`, arenaLayout);
    expect(res.status).toBe(201);

    const [pit, gold, silver] = res.body.zones;
    expect(pit).toMatchObject({ name: 'Fan Pit', type: 'standing', capacity: 5, cells: [] });

    // Gold: rows A, B; aisle at col 3 gets no number; disabled seat keeps its number but isn't sellable
    expect(gold).toMatchObject({ type: 'seated', rows: 2, cols: 4, capacity: 5 });
    const label = (c: { rowLabel: string; seatNumber: number; kind: string }) =>
      c.kind === 'aisle'
        ? `${c.rowLabel}-aisle`
        : `${c.rowLabel}${c.seatNumber}${c.kind === 'disabled' ? 'x' : ''}`;
    expect(gold.cells.map(label)).toEqual([
      'A1',
      'A2',
      'A-aisle',
      'A3',
      'B1',
      'B2',
      'B-aisle',
      'B3x',
    ]);

    // Silver continues at C, not A again
    expect(silver.cells.map(label)).toEqual(['C1', 'C2', 'D1', 'D2']);
    expect(silver.capacity).toBe(4);

    const list = await o.get(`/organizer/venues/${venue.id}/layouts`);
    expect(list.body.data[0].zones.map((z: { capacity: number }) => z.capacity)).toEqual([5, 5, 4]);
  });

  it('row labels go A…Z, AA, AB…', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(rowLabelFor)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
    ]);
  });

  it('rejects bad layouts', async () => {
    const o = api(await createUser({ role: 'organizer' }));
    const venue = (await o.post('/organizer/venues', { name: 'V', address: 'A', city: 'C' })).body;
    const bad = async (zones: object[]) =>
      (await o.post(`/organizer/venues/${venue.id}/layouts`, { name: 'L', zones })).status;

    expect(await bad([])).toBe(400);
    expect(await bad([{ name: 'A', type: 'standing', capacity: 0 }])).toBe(400);
    expect(
      await bad([
        { name: 'A', type: 'seated', rows: 1, cols: 2, cells: [{ row: 1, col: 5, kind: 'aisle' }] },
      ]),
    ).toBe(400);
    expect(
      await bad([
        { name: 'A', type: 'seated', rows: 1, cols: 1, cells: [{ row: 1, col: 1, kind: 'aisle' }] },
      ]),
    ).toBe(400);
    expect(
      await bad([
        { name: 'Same', type: 'standing', capacity: 1 },
        { name: 'same', type: 'standing', capacity: 1 },
      ]),
    ).toBe(400);
  });

  it('editing a layout never changes shows already created from it', async () => {
    const organizer = await createUser({ role: 'organizer' });
    const { layout, show } = await setupShow(organizer);
    const before = await pool.query(
      'SELECT COUNT(*)::int AS n FROM show_seats WHERE show_id = $1',
      [show.id],
    );

    const res = await api(organizer).put(`/organizer/layouts/${layout.id}`, {
      name: 'Renamed',
      zones: [{ name: 'Only Pit', type: 'standing', capacity: 999 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.zones).toHaveLength(1);

    const after = await pool.query('SELECT COUNT(*)::int AS n FROM show_seats WHERE show_id = $1', [
      show.id,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const zones = await pool.query(
      'SELECT name FROM show_zones WHERE show_id = $1 ORDER BY sort_order',
      [show.id],
    );
    expect(zones.rows.map((z) => z.name)).toEqual(['Fan Pit', 'Gold', 'Silver']);
  });
});

describe('events', () => {
  it('create → edit → submit lifecycle', async () => {
    const o = api(await createUser({ role: 'organizer' }));
    const created = await o.post('/organizer/events', {
      title: 'Synth Night!',
      categoryId,
      description: 'Loud',
      posterUrl: 'https://example.com/p.jpg',
      durationMin: 120,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'draft',
      slug: 'synth-night',
      durationMin: 120,
      shows: [],
    });

    // same title → still a unique slug
    const twin = await o.post('/organizer/events', { title: 'Synth Night!', categoryId });
    expect(twin.body.slug).toMatch(/^synth-night-[a-f0-9]{6}$/);

    const edited = await o.patch(`/organizer/events/${created.body.id}`, {
      title: 'Synth Night',
      posterUrl: null,
    });
    expect(edited.body).toMatchObject({
      title: 'Synth Night',
      posterUrl: null,
      description: 'Loud',
    });

    const submitted = await o.post(`/organizer/events/${created.body.id}/submit`);
    expect(submitted.body.status).toBe('pending');

    // pending events can't be edited, deleted or re-submitted
    expect(
      (await o.patch(`/organizer/events/${created.body.id}`, { title: 'x' })).body.error.code,
    ).toBe('EVENT_NOT_EDITABLE');
    expect((await o.delete(`/organizer/events/${created.body.id}`)).body.error.code).toBe(
      'EVENT_NOT_DRAFT',
    );
    expect((await o.post(`/organizer/events/${created.body.id}/submit`)).body.error.code).toBe(
      'EVENT_NOT_SUBMITTABLE',
    );

    const list = await o.get('/organizer/events?status=pending');
    expect(list.body).toMatchObject({ total: 1, page: 1 });
  });

  it('validates the category and only deletes drafts', async () => {
    const o = api(await createUser({ role: 'organizer' }));
    const bad = await o.post('/organizer/events', { title: 'X', categoryId: randomUUID() });
    expect(bad.body.error.code).toBe('INVALID_CATEGORY');

    const draft = (await o.post('/organizer/events', { title: 'Drafty', categoryId })).body;
    expect((await o.delete(`/organizer/events/${draft.id}`)).status).toBe(204);
  });

  it('status "cancelled" must be sent alone', async () => {
    const o = api(await createUser({ role: 'organizer' }));
    const draft = (await o.post('/organizer/events', { title: 'Drafty', categoryId })).body;
    const res = await o.patch(`/organizer/events/${draft.id}`, { status: 'cancelled', title: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('shows', () => {
  it('creates a show with an inventory snapshot of the layout', async () => {
    const organizer = await createUser({ role: 'organizer' });
    const { showRes, event } = await setupShow(organizer);
    expect(showRes.status).toBe(201);
    expect(showRes.body).toMatchObject({
      status: 'scheduled',
      capacity: 5 + 5 + 4,
      ticketsSold: 0,
      revenuePaise: 0,
    });
    expect(
      showRes.body.zones.map((z: { name: string; capacity: number; pricePaise: number }) => [
        z.name,
        z.capacity,
        z.pricePaise,
      ]),
    ).toEqual([
      ['Fan Pit', 5, 10000],
      ['Gold', 5, 20000],
      ['Silver', 4, 30000],
    ]);

    // only real seats are copied (no aisles, no disabled seat)
    const seats = await pool.query(
      'SELECT row_label || seat_number AS s FROM show_seats WHERE show_id = $1 ORDER BY row_label, seat_number',
      [showRes.body.id],
    );
    expect(seats.rows.map((r) => r.s)).toEqual([
      'A1',
      'A2',
      'A3',
      'B1',
      'B2',
      'C1',
      'C2',
      'D1',
      'D2',
    ]);

    const list = await api(organizer).get(`/organizer/events/${event.id}/shows`);
    expect(list.body.data).toHaveLength(1);
  });

  it('requires a price for exactly every layout zone, a future date and a matching layout', async () => {
    const organizer = await createUser({ role: 'organizer' });
    const o = api(organizer);
    const { venue, layout, event } = await setupShow(organizer);
    const base = {
      venueId: venue.id,
      layoutId: layout.id,
      startsAt: new Date(Date.now() + DAY).toISOString(),
      zonePrices: layout.zones.map((z: { id: string }) => ({
        layoutZoneId: z.id,
        pricePaise: 100,
      })),
    };

    const missing = await o.post(`/organizer/events/${event.id}/shows`, {
      ...base,
      zonePrices: base.zonePrices.slice(1),
    });
    expect(missing.body.error.code).toBe('ZONE_PRICES_MISMATCH');
    expect(missing.body.error.details.missing).toEqual([layout.zones[0].id]);

    const past = await o.post(`/organizer/events/${event.id}/shows`, {
      ...base,
      startsAt: new Date(Date.now() - DAY).toISOString(),
    });
    expect(past.body.error.code).toBe('SHOW_IN_PAST');

    const otherVenue = (await o.post('/organizer/venues', { name: 'V2', address: 'A', city: 'C' }))
      .body;
    const mismatch = await o.post(`/organizer/events/${event.id}/shows`, {
      ...base,
      venueId: otherVenue.id,
    });
    expect(mismatch.body.error.code).toBe('LAYOUT_VENUE_MISMATCH');
  });

  it('cancelling a show cancels its bookings, releases holds and returns inventory', async () => {
    const organizer = await createUser({ role: 'organizer' });
    const { show } = await setupShow(organizer, { publish: true });
    const [pit, gold] = show.zones;
    const [buyer, browser] = [await createUser(), await createUser()];

    // one confirmed booking and one open hold
    const hold = await api(buyer).post('/holds', {
      showId: show.id,
      items: [{ zoneId: pit.id, quantity: 2 }],
    });
    const booking = await api(buyer)
      .post('/bookings', {
        holdId: hold.body.holdId,
        payment: { method: 'mock', simulate: 'success' },
      })
      .set('Idempotency-Key', randomUUID());
    expect(booking.status).toBe(201);
    const seatMap = await request(app).get(`/api/shows/${show.id}/seats`);
    const seatId = seatMap.body.zones.find((z: { id: string }) => z.id === gold.id).seats[0].id;
    const open = await api(browser).post('/holds', {
      showId: show.id,
      items: [{ zoneId: gold.id, seatIds: [seatId] }],
    });
    expect(open.status).toBe(201);

    const res = await api(organizer).post(`/organizer/shows/${show.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      cancelledBookings: 1,
      releasedHolds: 1,
      show: { status: 'cancelled', ticketsSold: 0 },
    });

    const b = await api(buyer).get(`/bookings/${booking.body.id}`);
    expect(b.body).toMatchObject({
      status: 'cancelled',
      canCancel: false,
      show: { status: 'cancelled' },
    });
    const counts = await pool.query(
      'SELECT SUM(sold_count)::int AS sold, SUM(held_count)::int AS held FROM show_zones WHERE show_id = $1',
      [show.id],
    );
    expect(counts.rows[0]).toEqual({ sold: 0, held: 0 });

    // no more holds on a cancelled show
    const late = await api(buyer).post('/holds', {
      showId: show.id,
      items: [{ zoneId: pit.id, quantity: 1 }],
    });
    expect(late.body.error.code).toBe('SHOW_NOT_BOOKABLE');
    expect((await api(organizer).post(`/organizer/shows/${show.id}/cancel`)).body.error.code).toBe(
      'SHOW_NOT_SCHEDULED',
    );
  });

  it('cancelling an event cancels its scheduled shows', async () => {
    const organizer = await createUser({ role: 'organizer' });
    const { show, event } = await setupShow(organizer, { publish: true });
    const res = await api(organizer).patch(`/organizer/events/${event.id}`, {
      status: 'cancelled',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.shows[0]).toMatchObject({ id: show.id, status: 'cancelled' });
    expect((await request(app).get(`/api/events/${event.slug}`)).status).toBe(404);
  });
});

describe('show bookings and dashboard', () => {
  it('lists who booked a show and summarises sales', async () => {
    const organizer = await createUser({ role: 'organizer' });
    const { show } = await setupShow(organizer, { publish: true });
    const buyer = await createUser({ email: 'buyer@test.com' });

    const hold = await api(buyer).post('/holds', {
      showId: show.id,
      items: [{ zoneId: show.zones[0].id, quantity: 3 }],
    });
    await api(buyer)
      .post('/bookings', {
        holdId: hold.body.holdId,
        payment: { method: 'mock', simulate: 'success' },
      })
      .set('Idempotency-Key', randomUUID());

    const bookings = await api(organizer).get(`/organizer/shows/${show.id}/bookings`);
    expect(bookings.status).toBe(200);
    expect(bookings.body).toMatchObject({ total: 1, show: { id: show.id, eventTitle: 'Big Gig' } });
    expect(bookings.body.data[0]).toMatchObject({
      status: 'confirmed',
      totalPaise: 30000,
      user: { email: 'buyer@test.com' },
      items: [{ zoneName: 'Fan Pit', quantity: 3, rowLabel: null, seatNumber: null }],
    });

    const dash = await api(organizer).get('/organizer/dashboard');
    expect(dash.body).toMatchObject({
      ticketsSold: 3,
      revenuePaise: 30000,
      confirmedBookings: 1,
      upcomingShowCount: 1,
      eventsByStatus: { published: 1, draft: 0 },
    });
    expect(dash.body.upcomingShows[0]).toMatchObject({
      showId: show.id,
      capacity: 14,
      sold: 3,
      occupancyPercent: 21.4,
    });

    // another organizer's dashboard is empty
    const other = await api(await createUser({ role: 'organizer' })).get('/organizer/dashboard');
    expect(other.body).toMatchObject({ ticketsSold: 0, revenuePaise: 0, upcomingShows: [] });
  });
});
