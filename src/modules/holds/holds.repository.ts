import type { PoolClient } from 'pg';
import { pool, type Queryable } from '../../config/db';
import type { ReservedItem } from '../bookings/strategies/booking-strategy';
import type { ZoneType } from '../shows/shows.repository';

export type HoldStatus = 'active' | 'converted' | 'expired' | 'released';

export interface HoldRecord {
  id: string;
  userId: string;
  showId: string;
  status: HoldStatus;
  expiresAt: Date;
  /** Computed with the database clock so app/DB clock drift can't matter. */
  isExpired: boolean;
}

export interface HoldItemRecord {
  holdId: string;
  zoneId: string;
  zoneName: string;
  zoneType: ZoneType;
  pricePaise: number;
  seatId: string | null;
  rowLabel: string | null;
  seatNumber: number | null;
  quantity: number;
}

interface HoldRow {
  id: string;
  user_id: string;
  show_id: string;
  status: HoldStatus;
  expires_at: Date;
  is_expired: boolean;
}

const toHold = (r: HoldRow): HoldRecord => ({
  id: r.id,
  userId: r.user_id,
  showId: r.show_id,
  status: r.status,
  expiresAt: r.expires_at,
  isExpired: r.is_expired,
});

const HOLD_COLUMNS =
  'id, user_id, show_id, status, expires_at, (expires_at <= now()) AS is_expired';

export async function insertHold(
  client: PoolClient,
  userId: string,
  showId: string,
  ttlMinutes: number,
): Promise<{ id: string; expiresAt: Date }> {
  const { rows } = await client.query<{ id: string; expires_at: Date }>(
    `INSERT INTO holds (user_id, show_id, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))
     RETURNING id, expires_at`,
    [userId, showId, ttlMinutes],
  );
  return { id: rows[0]!.id, expiresAt: rows[0]!.expires_at };
}

export async function insertHoldItems(
  client: PoolClient,
  holdId: string,
  items: ReservedItem[],
): Promise<void> {
  await client.query(
    `INSERT INTO hold_items (hold_id, show_zone_id, show_seat_id, quantity)
     SELECT $1, zone_id, seat_id, quantity
     FROM unnest($2::uuid[], $3::uuid[], $4::int[]) AS t(zone_id, seat_id, quantity)`,
    [holdId, items.map((i) => i.zoneId), items.map((i) => i.seatId), items.map((i) => i.quantity)],
  );
}

/** Row-locks the caller's hold so confirm / release can't run twice at once. */
export async function lockHoldForUser(
  client: PoolClient,
  holdId: string,
  userId: string,
): Promise<HoldRecord | undefined> {
  const { rows } = await client.query<HoldRow>(
    `SELECT ${HOLD_COLUMNS} FROM holds WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [holdId, userId],
  );
  return rows[0] && toHold(rows[0]);
}

export async function findHoldForUser(
  holdId: string,
  userId: string,
  db: Queryable = pool,
): Promise<HoldRecord | undefined> {
  const { rows } = await db.query<HoldRow>(
    `SELECT ${HOLD_COLUMNS} FROM holds WHERE id = $1 AND user_id = $2`,
    [holdId, userId],
  );
  return rows[0] && toHold(rows[0]);
}

/** The user's current active hold(s) on a show (normally 0 or 1), locked. */
export async function lockActiveHoldIdsForUserShow(
  client: PoolClient,
  userId: string,
  showId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM holds
     WHERE user_id = $1 AND show_id = $2 AND status = 'active'
     ORDER BY id
     FOR UPDATE`,
    [userId, showId],
  );
  return rows.map((r) => r.id);
}

/**
 * Active holds past their expiry, optionally for one show.
 * SKIP LOCKED: holds another transaction is working on (e.g. being confirmed right now)
 * are skipped instead of waited on, so the cleanup job never blocks checkouts.
 */
export async function lockExpiredHoldIds(
  client: PoolClient,
  showId: string | null,
  limit: number,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM holds
     WHERE status = 'active' AND expires_at <= now()
       AND ($1::uuid IS NULL OR show_id = $1)
     ORDER BY id
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [showId, limit],
  );
  return rows.map((r) => r.id);
}

export async function listHoldItems(db: Queryable, holdIds: string[]): Promise<HoldItemRecord[]> {
  const { rows } = await db.query<{
    hold_id: string;
    zone_id: string;
    zone_name: string;
    zone_type: ZoneType;
    price_paise: number;
    seat_id: string | null;
    row_label: string | null;
    seat_number: number | null;
    quantity: number;
    sort_order: number;
  }>(
    `SELECT hi.hold_id, sz.id AS zone_id, sz.name AS zone_name, sz.type AS zone_type,
            sz.price_paise, sz.sort_order, hi.show_seat_id AS seat_id,
            ss.row_label, ss.seat_number, hi.quantity
     FROM hold_items hi
     JOIN show_zones sz ON sz.id = hi.show_zone_id
     LEFT JOIN show_seats ss ON ss.id = hi.show_seat_id
     WHERE hi.hold_id = ANY($1::uuid[])
     ORDER BY sz.sort_order, ss.row_label, ss.seat_number`,
    [holdIds],
  );
  return rows.map((r) => ({
    holdId: r.hold_id,
    zoneId: r.zone_id,
    zoneName: r.zone_name,
    zoneType: r.zone_type,
    pricePaise: r.price_paise,
    seatId: r.seat_id,
    rowLabel: r.row_label,
    seatNumber: r.seat_number,
    quantity: r.quantity,
  }));
}

export async function setHoldStatus(
  client: PoolClient,
  holdIds: string[],
  status: HoldStatus,
): Promise<void> {
  await client.query('UPDATE holds SET status = $2 WHERE id = ANY($1::uuid[])', [holdIds, status]);
}

/** Every active hold on a show (expired or not), locked — used when the show is cancelled. */
export async function lockActiveHoldIdsForShow(
  client: PoolClient,
  showId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM holds WHERE show_id = $1 AND status = 'active' ORDER BY id FOR UPDATE`,
    [showId],
  );
  return rows.map((r) => r.id);
}
