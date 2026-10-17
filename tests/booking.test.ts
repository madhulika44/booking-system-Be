import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/config/db';
import { runExpireHolds } from '../src/jobs/expire-holds.job';
import { createShowFixture, zoneCounts, type ShowFixture } from './fixtures';
import { bearer, closeDb, createUser, resetDb, type TestUser } from './helpers';

// One real HTTP server so parallel requests really run concurrently
let server: Server;
beforeAll(() => {
  server = createApp().listen(0);
});
afterAll(async () => {
  server.close();
  await closeDb();
});
beforeEach(resetDb);

const HOUR = 60 * 60 * 1000;

const mixedShow = () =>
  createShowFixture({
    zones: [
      { name: 'Pit', type: 'standing', capacity: 10, pricePaise: 100000 },
      { name: 'Gold', type: 'seated', rows: 2, cols: 5, pricePaise: 50000 },
    ],
  });

const standing = (show: ShowFixture) => show.zones.find((z) => z.type === 'standing')!;
const seated = (show: ShowFixture) => show.zones.find((z) => z.type === 'seated')!;

const hold = (user: TestUser, body: object) =>
  request(server).post('/api/holds').set(bearer(user)).send(body);

const confirm = (
  user: TestUser,
  holdId: string,
  key: string = randomUUID(),
  simulate: 'success' | 'failure' = 'success',
) =>
  request(server)
    .post('/api/bookings')
    .set(bearer(user))
    .set('Idempotency-Key', key)
    .send({ holdId, payment: { method: 'mock', simulate } });

/** Pretend time passed: push a hold (and its seats) into the past. */
async function expireHold(holdId: string) {
  await pool.query("UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1", [
    holdId,
  ]);
  await pool.query(
    "UPDATE show_seats SET held_until = now() - interval '1 second' WHERE hold_id = $1",
    [holdId],
  );
}

const seatStatus = async (seatId: string) =>
  (await pool.query('SELECT status, hold_id FROM show_seats WHERE id = $1', [seatId])).rows[0];

// ---------------------------------------------------------------------------
// SPEC §5.4 required tests
// ---------------------------------------------------------------------------

describe('concurrency', () => {
  it('20 parallel hold requests for the same seat → exactly 1 succeeds', async () => {
    const show = await mixedShow();
    const seatId = seated(show).seatIds[0]!;
    const users = await Promise.all(Array.from({ length: 20 }, () => createUser()));

    const results = await Promise.all(
      users.map((u) =>
        hold(u, { showId: show.showId, items: [{ zoneId: seated(show).id, seatIds: [seatId] }] }),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body.error.code).toBe('SEATS_UNAVAILABLE');
      expect(r.body.error.details.seatIds).toEqual([seatId]);
    }

    const winner = results.find((r) => r.status === 201)!;
    expect(await seatStatus(seatId)).toEqual({ status: 'held', hold_id: winner.body.holdId });
    expect((await zoneCounts(seated(show).id)).held_count).toBe(1);
  });

  it('standing zone capacity 10, 15 parallel requests of qty 1 → exactly 10 succeed, never oversold', async () => {
    const show = await mixedShow();
    const users = await Promise.all(Array.from({ length: 15 }, () => createUser()));

    const results = await Promise.all(
      users.map((u) =>
        hold(u, { showId: show.showId, items: [{ zoneId: standing(show).id, quantity: 1 }] }),
      ),
    );

    const ok = results.filter((r) => r.status === 201);
    const soldOut = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(10);
    expect(soldOut).toHaveLength(5);
    soldOut.forEach((r) => expect(r.body.error.code).toBe('ZONE_SOLD_OUT'));

    const counts = await zoneCounts(standing(show).id);
    expect(counts.held_count).toBe(10);
    expect(counts.sold_count + counts.held_count).toBeLessThanOrEqual(counts.capacity);

    // and all 10 can check out in parallel without overselling
    const confirmed = await Promise.all(
      ok.map((r) => confirm(users[results.indexOf(r)]!, r.body.holdId)),
    );
    expect(confirmed.every((r) => r.status === 201)).toBe(true);
    expect(await zoneCounts(standing(show).id)).toMatchObject({ sold_count: 10, held_count: 0 });
  });

  it('parallel holds on overlapping seat sets never double-book any seat', async () => {
    const show = await mixedShow();
    const [a, b, c, d] = seated(show).seatIds;
    const users = await Promise.all(Array.from({ length: 6 }, () => createUser()));
    const sets = [
      [a, b],
      [b, c],
      [c, d],
      [d, a],
      [a, c],
      [b, d],
    ];

    const results = await Promise.all(
      users.map((u, i) =>
        hold(u, { showId: show.showId, items: [{ zoneId: seated(show).id, seatIds: sets[i] }] }),
      ),
    );

    const won = results
      .filter((r) => r.status === 201)
      .flatMap((r) => r.body.items[0].seats.map((s: { id: string }) => s.id));
    expect(new Set(won).size).toBe(won.length); // no seat in two winning holds
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM show_seats WHERE show_zone_id = $1 AND status = 'held'",
      [seated(show).id],
    );
    expect(rows[0].n).toBe(won.length);
    expect((await zoneCounts(seated(show).id)).held_count).toBe(won.length);
  });
});

describe('idempotency', () => {
  it('same Idempotency-Key twice → one booking', async () => {
    const show = await mixedShow();
    const user = await createUser();
    const h = await hold(user, {
      showId: show.showId,
      items: [{ zoneId: standing(show).id, quantity: 2 }],
    });
    const key = randomUUID();

    const first = await confirm(user, h.body.holdId, key);
    const second = await confirm(user, h.body.holdId, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM bookings');
    expect(rows[0].n).toBe(1);
    expect((await zoneCounts(standing(show).id)).sold_count).toBe(2);
  });

  it('same Idempotency-Key sent in parallel → still one booking', async () => {
    const show = await mixedShow();
    const user = await createUser();
    const h = await hold(user, {
      showId: show.showId,
      items: [{ zoneId: seated(show).id, seatIds: seated(show).seatIds.slice(0, 2) }],
    });
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => confirm(user, h.body.holdId, key)),
    );
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM bookings');
    expect(rows[0].n).toBe(1);
  });

  it('requires an Idempotency-Key header', async () => {
    const user = await createUser();
    const res = await request(server)
      .post('/api/bookings')
      .set(bearer(user))
      .send({ holdId: randomUUID(), payment: { method: 'mock', simulate: 'success' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('rejects a key already used by someone else', async () => {
    const show = await mixedShow();
    const [u1, u2] = [await createUser(), await createUser()];
    const key = randomUUID();
    const h1 = await hold(u1, {
      showId: show.showId,
      items: [{ zoneId: standing(show).id, quantity: 1 }],
    });
    const h2 = await hold(u2, {
      showId: show.showId,
      items: [{ zoneId: standing(show).id, quantity: 1 }],
    });
    expect((await confirm(u1, h1.body.holdId, key)).status).toBe(201);
    const res = await confirm(u2, h2.body.holdId, key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('expiry', () => {
  it('an expired hold cannot be confirmed', async () => {
    const show = await mixedShow();
    const user = await createUser();
    const h = await hold(user, {
      showId: show.showId,
      items: [{ zoneId: standing(show).id, quantity: 1 }],
    });
    await expireHold(h.body.holdId);

    const res = await confirm(user, h.body.holdId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM bookings');
    expect(rows[0].n).toBe(0);

    const view = await request(server).get(`/api/holds/${h.body.holdId}`).set(bearer(user));
    expect(view.body.status).toBe('expired');
  });

  it('expired seats become holdable by someone else, and the counters stay correct', async () => {
    const show = await mixedShow();
    const seatId = seated(show).seatIds[0]!;
    const [first, second] = [await createUser(), await createUser()];

    const h1 = await hold(first, {
      showId: show.showId,
      items: [{ zoneId: seated(show).id, seatIds: [seatId] }],
    });
    expect(h1.status).toBe(201);

    // while active, nobody else can take it
    const blocked = await hold(second, {
      showId: show.showId,
      items: [{ zoneId: seated(show).id, seatIds: [seatId] }],
    });
    expect(blocked.status).toBe(409);

    await expireHold(h1.body.holdId);
    const h2 = await hold(second, {
      showId: show.showId,
      items: [{ zoneId: seated(show).id, seatIds: [seatId] }],
    });
    expect(h2.status).toBe(201);

    expect(await seatStatus(seatId)).toEqual({ status: 'held', hold_id: h2.body.holdId });
    const old = await pool.query('SELECT status FROM holds WHERE id = $1', [h1.body.holdId]);
    expect(old.rows[0].status).toBe('expired');
    expect((await zoneCounts(seated(show).id)).held_count).toBe(1); // not 2

    // and the first user's late confirm fails
    expect((await confirm(first, h1.body.holdId)).body.error.code).toBe('HOLD_EXPIRED');
  });

  it('the cleanup job expires lapsed holds and returns their inventory', async () => {
    const show = await mixedShow();
    const user = await createUser();
    const h = await hold(user, {
      showId: show.showId,
      items: [
        { zoneId: standing(show).id, quantity: 2 },
        { zoneId: seated(show).id, seatIds: seated(show).seatIds.slice(0, 2) },
      ],
    });
    await expireHold(h.body.holdId);

    expect(await runExpireHolds()).toBe(1);
    expect(await zoneCounts(standing(show).id)).toMatchObject({ held_count: 0, sold_count: 0 });
    expect((await zoneCounts(seated(show).id)).held_count).toBe(0);
    expect((await seatStatus(seated(show).seatIds[0]!)).status).toBe('available');
    const { rows } = await pool.query('SELECT status FROM holds WHERE id = $1', [h.body.holdId]);
    expect(rows[0].status).toBe('expired');

    expect(await runExpireHolds()).toBe(0); // idempotent
  });
});

describe('cancellation', () => {
  it('restores inventory', async () => {
    const show = await mixedShow();
    const user = await createUser();
    const seatIds = seated(show).seatIds.slice(0, 2);
    const h = await hold(user, {
      showId: show.showId,
      items: [
        { zoneId: standing(show).id, quantity: 3 },
        { zoneId: seated(show).id, seatIds },
      ],
    });
    const booking = await confirm(user, h.body.holdId);
    expect(booking.status).toBe(201);
    expect(booking.body.totalPaise).toBe(3 * 100000 + 2 * 50000);
    expect(booking.body.bookingRef).toMatch(/^EVT-[A-Z0-9]{6}$/);
    expect(booking.body.canCancel).toBe(true);
    expect((await seatStatus(seatIds[0]!)).status).toBe('booked');

    const res = await request(server)
      .post(`/api/bookings/${booking.body.id}/cancel`)
      .set(bearer(user));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancelledAt).toEqual(expect.any(String));

    expect(await zoneCounts(standing(show).id)).toMatchObject({ sold_count: 0, held_count: 0 });
    expect(await zoneCounts(seated(show).id)).toMatchObject({ sold_count: 0, held_count: 0 });
    expect(await seatStatus(seatIds[0]!)).toEqual({ status: 'available', hold_id: null });

    // seats can be booked again
    const other = await createUser();
    expect(
      (await hold(other, { showId: show.showId, items: [{ zoneId: seated(show).id, seatIds }] }))
        .status,
    ).toBe(201);

    const again = await request(server)
      .post(`/api/bookings/${booking.body.id}/cancel`)
      .set(bearer(user));
    expect(again.body.error.code).toBe('BOOKING_ALREADY_CANCELLED');
  });

  it('is rejected inside 2 hours of the show', async () => {
    const show = await createShowFixture({ startsAt: new Date(Date.now() + 1 * HOUR) });
    const user = await createUser();
    const h = await hold(user, {
      showId: show.showId,
      items: [{ zoneId: show.zones[0]!.id, quantity: 1 }],
    });
    const booking = await confirm(user, h.body.holdId);
    expect(booking.body.canCancel).toBe(false);

    const res = await request(server)
      .post(`/api/bookings/${booking.body.id}/cancel`)
      .set(bearer(user));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCELLATION_WINDOW_CLOSED');
    expect((await zoneCounts(show.zones[0]!.id)).sold_count).toBe(1);
  });

  it('only the owner can cancel or view a booking', async () => {
    const show = await mixedShow();
    const [owner, stranger] = [await createUser(), await createUser()];
    const h = await hold(owner, {
      showId: show.showId,
      items: [{ zoneId: standing(show).id, quantity: 1 }],
    });
    const booking = await confirm(owner, h.body.holdId);

    expect(
      (await request(server).get(`/api/bookings/${booking.body.id}`).set(bearer(stranger))).status,
    ).toBe(404);
    expect(
      (await request(server).post(`/api/bookings/${booking.body.id}/cancel`).set(bearer(stranger)))
        .status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Other business rules
// ---------------------------------------------------------------------------

describe('hold rules', () => {
  it('returns hold details with totals and expiry ~10 minutes out', async () => {
    const show = await mixedShow();
    const user = await createUser();
    const res = await hold(user, {
      showId: show.showId,
      items: [
        { zoneId: seated(show).id, seatIds: seated(show).seatIds.slice(0, 2) },
        { zoneId: standing(show).id, quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'active', totalQuantity: 3, totalPaise: 200000 });
    const minutes = (new Date(res.body.expiresAt).getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    const gold = res.body.items.find((i: { zoneName: string }) => i.zoneName === 'Gold');
    expect(
      gold.seats.map(
        (s: { rowLabel: string; seatNumber: number }) => `${s.rowLabel}${s.seatNumber}`,
      ),
    ).toEqual(['A1', 'A2']);
  });

  it('allows at most 6 tickets across zones', async () => {
    const show = await mixedShow();
    const user = await createUser();
    const res = await hold(user, {
      showId: show.showId,
      items: [
        { zoneId: standing(show).id, quantity: 4 },
        { zoneId: seated(show).id, seatIds: seated(show).seatIds.slice(0, 3) },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MAX_TICKETS_EXCEEDED');
  });

  it('a new hold replaces the user’s previous hold on the same show', async () => {
    const show = await mixedShow();
    const user = await createUser();
    const [s1, s2] = seated(show).seatIds;

    const first = await hold(user, {
      showId: show.showId,
      items: [{ zoneId: seated(show).id, seatIds: [s1] }],
    });
    const second = await hold(user, {
      showId: show.showId,
      items: [{ zoneId: seated(show).id, seatIds: [s2] }],
    });
    expect(second.status).toBe(201);

    const old = await pool.query('SELECT status FROM holds WHERE id = $1', [first.body.holdId]);
    expect(old.rows[0].status).toBe('released');
    expect((await seatStatus(s1!)).status).toBe('available');
    expect((await zoneCounts(seated(show).id)).held_count).toBe(1);
  });

  it('rejects wrong zone types, foreign zones and unbookable shows', async () => {
    const show = await mixedShow();
    const other = await mixedShow();
    const past = await createShowFixture({ startsAt: new Date(Date.now() - HOUR) });
    const user = await createUser();

    const mismatch = await hold(user, {
      showId: show.showId,
      items: [{ zoneId: seated(show).id, quantity: 1 }],
    });
    expect(mismatch.body.error.code).toBe('ZONE_TYPE_MISMATCH');

    const foreign = await hold(user, {
      showId: show.showId,
      items: [{ zoneId: standing(other).id, quantity: 1 }],
    });
    expect(foreign.body.error.code).toBe('INVALID_ZONE');

    const closed = await hold(user, {
      showId: past.showId,
      items: [{ zoneId: past.zones[0]!.id, quantity: 1 }],
    });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('SHOW_NOT_BOOKABLE');

    const anon = await request(server).post('/api/holds').send({ showId: show.showId, items: [] });
    expect(anon.status).toBe(401);
  });

  it('releasing a hold early returns the inventory', async () => {
    const show = await mixedShow();
    const user = await createUser();
    const seatId = seated(show).seatIds[0]!;
    const h = await hold(user, {
      showId: show.showId,
      items: [{ zoneId: seated(show).id, seatIds: [seatId] }],
    });

    const res = await request(server).delete(`/api/holds/${h.body.holdId}`).set(bearer(user));
    expect(res.status).toBe(204);
    expect(await seatStatus(seatId)).toEqual({ status: 'available', hold_id: null });
    expect((await zoneCounts(seated(show).id)).held_count).toBe(0);

    const again = await request(server).delete(`/api/holds/${h.body.holdId}`).set(bearer(user));
    expect(again.body.error.code).toBe('HOLD_NOT_ACTIVE');
  });

  it("can't see or release someone else's hold", async () => {
    const show = await mixedShow();
    const [owner, stranger] = [await createUser(), await createUser()];
    const h = await hold(owner, {
      showId: show.showId,
      items: [{ zoneId: standing(show).id, quantity: 1 }],
    });
    expect(
      (await request(server).get(`/api/holds/${h.body.holdId}`).set(bearer(stranger))).status,
    ).toBe(404);
    expect(
      (await request(server).delete(`/api/holds/${h.body.holdId}`).set(bearer(stranger))).status,
    ).toBe(404);
    expect((await confirm(stranger, h.body.holdId)).status).toBe(404);
  });
});

describe('checkout', () => {
  it('payment failure → 402, hold stays active, retry succeeds', async () => {
    const show = await mixedShow();
    const user = await createUser();
    const seatIds = seated(show).seatIds.slice(0, 2);
    const h = await hold(user, {
      showId: show.showId,
      items: [{ zoneId: seated(show).id, seatIds }],
    });

    const failed = await confirm(user, h.body.holdId, randomUUID(), 'failure');
    expect(failed.status).toBe(402);
    expect(failed.body.error.code).toBe('PAYMENT_FAILED');
    expect((await seatStatus(seatIds[0]!)).status).toBe('held');
    expect(
      (await request(server).get(`/api/holds/${h.body.holdId}`).set(bearer(user))).body.status,
    ).toBe('active');

    const ok = await confirm(user, h.body.holdId);
    expect(ok.status).toBe(201);
    expect(ok.body.paymentRef).toMatch(/^MOCK-/);
    expect(ok.body.items).toHaveLength(2);
    expect(await zoneCounts(seated(show).id)).toMatchObject({ sold_count: 2, held_count: 0 });

    const converted = await confirm(user, h.body.holdId);
    expect(converted.body.error.code).toBe('HOLD_ALREADY_CONVERTED');
  });

  it('lists my bookings as upcoming and past', async () => {
    const user = await createUser();
    const upcoming = await mixedShow();
    const h = await hold(user, {
      showId: upcoming.showId,
      items: [{ zoneId: standing(upcoming).id, quantity: 1 }],
    });
    await confirm(user, h.body.holdId);

    // a booking whose show has since happened
    const past = await mixedShow();
    const h2 = await hold(user, {
      showId: past.showId,
      items: [{ zoneId: standing(past).id, quantity: 1 }],
    });
    await confirm(user, h2.body.holdId);
    await pool.query("UPDATE shows SET starts_at = now() - interval '1 day' WHERE id = $1", [
      past.showId,
    ]);

    const list = async (status?: string) =>
      (
        await request(server)
          .get(`/api/me/bookings${status ? `?status=${status}` : ''}`)
          .set(bearer(user))
      ).body;

    expect((await list()).total).toBe(2);
    const up = await list('upcoming');
    expect(up.data.map((b: { show: { id: string } }) => b.show.id)).toEqual([upcoming.showId]);
    const pastList = await list('past');
    expect(pastList.data.map((b: { show: { id: string } }) => b.show.id)).toEqual([past.showId]);
    expect(pastList.data[0].canCancel).toBe(false);
  });
});
