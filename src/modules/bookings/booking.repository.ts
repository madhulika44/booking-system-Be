import type { PoolClient } from 'pg';
import { pool, type Queryable } from '../../config/db';
import type { ZoneType } from '../shows/shows.repository';
import type { ReservedItem } from './strategies/booking-strategy';

export type BookingStatus = 'confirmed' | 'cancelled';

export interface BookingItemView {
  zoneId: string;
  zoneName: string;
  zoneType: ZoneType;
  quantity: number;
  unitPricePaise: number;
  /** Flat seat fields for easy display; null for standing zones. */
  seatId: string | null;
  rowLabel: string | null;
  seatNumber: number | null;
  seat: { id: string; rowLabel: string; seatNumber: number } | null;
}

export interface BookingView {
  id: string;
  bookingRef: string;
  status: BookingStatus;
  totalPaise: number;
  paymentRef: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
  /** Confirmed and at least 2 h before the show (SPEC §3). */
  canCancel: boolean;
  show: {
    id: string;
    startsAt: Date;
    status: 'scheduled' | 'cancelled' | 'completed';
    event: { id: string; title: string; slug: string; posterUrl: string | null };
    venue: { id: string; name: string; address: string; city: string };
  };
  items: BookingItemView[];
}

// ---------- writes ----------

export async function findBookingIdByIdempotencyKey(
  db: Queryable,
  key: string,
): Promise<{ id: string; userId: string } | undefined> {
  const { rows } = await db.query<{ id: string; user_id: string }>(
    'SELECT id, user_id FROM bookings WHERE idempotency_key = $1',
    [key],
  );
  return rows[0] && { id: rows[0].id, userId: rows[0].user_id };
}

export async function insertBooking(
  client: PoolClient,
  input: {
    bookingRef: string;
    userId: string;
    showId: string;
    holdId: string;
    idempotencyKey: string;
    totalPaise: number;
    paymentRef: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO bookings (booking_ref, user_id, show_id, hold_id, idempotency_key, total_paise, payment_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.bookingRef,
      input.userId,
      input.showId,
      input.holdId,
      input.idempotencyKey,
      input.totalPaise,
      input.paymentRef,
    ],
  );
  return rows[0]!.id;
}

export async function insertBookingItems(
  client: PoolClient,
  bookingId: string,
  items: (ReservedItem & { unitPricePaise: number })[],
): Promise<void> {
  await client.query(
    `INSERT INTO booking_items (booking_id, show_zone_id, show_seat_id, quantity, unit_price_paise)
     SELECT $1, zone_id, seat_id, quantity, price
     FROM unnest($2::uuid[], $3::uuid[], $4::int[], $5::int[]) AS t(zone_id, seat_id, quantity, price)`,
    [
      bookingId,
      items.map((i) => i.zoneId),
      items.map((i) => i.seatId),
      items.map((i) => i.quantity),
      items.map((i) => i.unitPricePaise),
    ],
  );
}

/** Row-locks the caller's booking for cancellation. */
export async function lockBookingForUser(
  client: PoolClient,
  bookingId: string,
  userId: string,
): Promise<{ id: string; status: BookingStatus; withinCutoff: boolean } | undefined> {
  const { rows } = await client.query<{
    id: string;
    status: BookingStatus;
    within_cutoff: boolean;
  }>(
    `SELECT b.id, b.status, (s.starts_at - now() < interval '2 hours') AS within_cutoff
     FROM bookings b
     JOIN shows s ON s.id = b.show_id
     WHERE b.id = $1 AND b.user_id = $2
     FOR UPDATE OF b`,
    [bookingId, userId],
  );
  const r = rows[0];
  return r && { id: r.id, status: r.status, withinCutoff: r.within_cutoff };
}

export async function listBookingInventory(
  client: PoolClient,
  bookingId: string,
): Promise<{ zoneId: string; zoneType: ZoneType; seatId: string | null; quantity: number }[]> {
  const { rows } = await client.query<{
    zone_id: string;
    zone_type: ZoneType;
    seat_id: string | null;
    quantity: number;
  }>(
    `SELECT bi.show_zone_id AS zone_id, sz.type AS zone_type, bi.show_seat_id AS seat_id, bi.quantity
     FROM booking_items bi
     JOIN show_zones sz ON sz.id = bi.show_zone_id
     WHERE bi.booking_id = $1`,
    [bookingId],
  );
  return rows.map((r) => ({
    zoneId: r.zone_id,
    zoneType: r.zone_type,
    seatId: r.seat_id,
    quantity: r.quantity,
  }));
}

export async function markCancelled(client: PoolClient, bookingId: string): Promise<void> {
  await client.query(
    "UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1",
    [bookingId],
  );
}

// ---------- reads ----------

interface BookingRow {
  id: string;
  booking_ref: string;
  status: BookingStatus;
  total_paise: number;
  payment_ref: string | null;
  created_at: Date;
  cancelled_at: Date | null;
  can_cancel: boolean;
  show_id: string;
  starts_at: Date;
  show_status: 'scheduled' | 'cancelled' | 'completed';
  event_id: string;
  title: string;
  slug: string;
  poster_url: string | null;
  venue_id: string;
  venue_name: string;
  venue_address: string;
  venue_city: string;
}

const BOOKING_SELECT = `
  SELECT b.id, b.booking_ref, b.status, b.total_paise, b.payment_ref, b.created_at, b.cancelled_at,
         (b.status = 'confirmed' AND s.starts_at - now() >= interval '2 hours') AS can_cancel,
         s.id AS show_id, s.starts_at, s.status AS show_status,
         e.id AS event_id, e.title, e.slug, e.poster_url,
         v.id AS venue_id, v.name AS venue_name, v.address AS venue_address, v.city AS venue_city
  FROM bookings b
  JOIN shows s ON s.id = b.show_id
  JOIN events e ON e.id = s.event_id
  JOIN venues v ON v.id = s.venue_id`;

async function attachItems(db: Queryable, rows: BookingRow[]): Promise<BookingView[]> {
  if (!rows.length) return [];
  const { rows: items } = await db.query<{
    booking_id: string;
    zone_id: string;
    zone_name: string;
    zone_type: ZoneType;
    quantity: number;
    unit_price_paise: number;
    seat_id: string | null;
    row_label: string | null;
    seat_number: number | null;
  }>(
    `SELECT bi.booking_id, sz.id AS zone_id, sz.name AS zone_name, sz.type AS zone_type,
            bi.quantity, bi.unit_price_paise, ss.id AS seat_id, ss.row_label, ss.seat_number
     FROM booking_items bi
     JOIN show_zones sz ON sz.id = bi.show_zone_id
     LEFT JOIN show_seats ss ON ss.id = bi.show_seat_id
     WHERE bi.booking_id = ANY($1::uuid[])
     ORDER BY sz.sort_order, ss.row_label, ss.seat_number`,
    [rows.map((r) => r.id)],
  );

  const byBooking = new Map<string, BookingItemView[]>();
  for (const i of items) {
    const list = byBooking.get(i.booking_id) ?? [];
    list.push({
      zoneId: i.zone_id,
      zoneName: i.zone_name,
      zoneType: i.zone_type,
      quantity: i.quantity,
      unitPricePaise: i.unit_price_paise,
      seatId: i.seat_id,
      rowLabel: i.row_label,
      seatNumber: i.seat_number,
      seat: i.seat_id
        ? { id: i.seat_id, rowLabel: i.row_label!, seatNumber: i.seat_number! }
        : null,
    });
    byBooking.set(i.booking_id, list);
  }

  return rows.map((r) => ({
    id: r.id,
    bookingRef: r.booking_ref,
    status: r.status,
    totalPaise: r.total_paise,
    paymentRef: r.payment_ref,
    createdAt: r.created_at,
    cancelledAt: r.cancelled_at,
    canCancel: r.can_cancel,
    show: {
      id: r.show_id,
      startsAt: r.starts_at,
      status: r.show_status,
      event: { id: r.event_id, title: r.title, slug: r.slug, posterUrl: r.poster_url },
      venue: { id: r.venue_id, name: r.venue_name, address: r.venue_address, city: r.venue_city },
    },
    items: byBooking.get(r.id) ?? [],
  }));
}

export async function findBookingForUser(
  bookingId: string,
  userId: string,
  db: Queryable = pool,
): Promise<BookingView | undefined> {
  const { rows } = await db.query<BookingRow>(
    `${BOOKING_SELECT} WHERE b.id = $1 AND b.user_id = $2`,
    [bookingId, userId],
  );
  return (await attachItems(db, rows))[0];
}

/** status: upcoming = show not started yet (soonest first), past = already started (latest first). */
export async function listBookingsForUser(
  userId: string,
  status: 'upcoming' | 'past' | undefined,
  limit: number,
  offset: number,
): Promise<{ rows: BookingView[]; total: number }> {
  const params = [userId, status ?? null];
  const where = `
    WHERE b.user_id = $1
      AND ($2::text IS NULL
           OR ($2 = 'upcoming' AND s.starts_at >= now())
           OR ($2 = 'past' AND s.starts_at < now()))`;
  const [data, count] = await Promise.all([
    pool.query<BookingRow>(
      `${BOOKING_SELECT} ${where}
       ORDER BY CASE WHEN $2 = 'upcoming' THEN s.starts_at END ASC,
                CASE WHEN $2 = 'past' THEN s.starts_at END DESC,
                b.created_at DESC
       LIMIT $3 OFFSET $4`,
      [...params, limit, offset],
    ),
    pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM bookings b JOIN shows s ON s.id = b.show_id ${where}`,
      params,
    ),
  ]);
  return { rows: await attachItems(pool, data.rows), total: count.rows[0]!.total };
}

export interface ShowBookingView extends BookingView {
  user: { id: string; name: string; email: string };
}

/** All bookings of one show, newest first (organizer view). */
export async function listBookingsForShow(
  showId: string,
  limit: number,
  offset: number,
): Promise<{ rows: ShowBookingView[]; total: number }> {
  const [data, count] = await Promise.all([
    pool.query<BookingRow & { user_id: string; user_name: string; user_email: string }>(
      `SELECT q.*, u.id AS user_id, u.name AS user_name, u.email AS user_email
       FROM (${BOOKING_SELECT} WHERE b.show_id = $1) q
       JOIN bookings b2 ON b2.id = q.id
       JOIN users u ON u.id = b2.user_id
       ORDER BY q.created_at DESC
       LIMIT $2 OFFSET $3`,
      [showId, limit, offset],
    ),
    pool.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM bookings WHERE show_id = $1',
      [showId],
    ),
  ]);
  const views = await attachItems(pool, data.rows);
  const rows = views.map((v, i) => {
    const r = data.rows[i]!;
    return { ...v, user: { id: r.user_id, name: r.user_name, email: r.user_email } };
  });
  return { rows, total: count.rows[0]!.total };
}

/** Confirmed bookings of a show, locked — used when the show is cancelled. */
export async function lockConfirmedBookingIdsForShow(
  client: PoolClient,
  showId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM bookings WHERE show_id = $1 AND status = 'confirmed' ORDER BY id FOR UPDATE`,
    [showId],
  );
  return rows.map((r) => r.id);
}
