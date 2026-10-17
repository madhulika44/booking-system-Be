import { pool, type Queryable } from '../../config/db';

export type ZoneType = 'standing' | 'seated';
export type SeatStatus = 'available' | 'held' | 'booked' | 'blocked';

export interface ShowSummary {
  id: string;
  startsAt: Date;
  status: 'scheduled' | 'cancelled' | 'completed';
  bookable: boolean;
  event: {
    id: string;
    title: string;
    slug: string;
    posterUrl: string | null;
    language: string | null;
    durationMin: number | null;
    category: { name: string; slug: string };
  };
  venue: { id: string; name: string; address: string; city: string };
}

export interface ShowZone {
  id: string;
  name: string;
  type: ZoneType;
  pricePaise: number;
  capacity: number;
  available: number;
  sortOrder: number;
}

export interface Seat {
  id: string;
  rowLabel: string;
  seatNumber: number;
  gridRow: number;
  gridCol: number;
  status: SeatStatus;
  mine: boolean;
}

export interface SeatMapZone {
  id: string;
  name: string;
  pricePaise: number;
  rows: number;
  cols: number;
  seats: Seat[];
}

/**
 * Bookable = event published AND show scheduled AND show in the future (SPEC §3).
 * Shows of unpublished events are invisible to the public.
 */
export async function findPublicShow(showId: string): Promise<ShowSummary | undefined> {
  const { rows } = await pool.query<{
    id: string;
    starts_at: Date;
    status: ShowSummary['status'];
    bookable: boolean;
    event_id: string;
    title: string;
    slug: string;
    poster_url: string | null;
    language: string | null;
    duration_min: number | null;
    category_name: string;
    category_slug: string;
    venue_id: string;
    venue_name: string;
    venue_address: string;
    venue_city: string;
  }>(
    `SELECT s.id, s.starts_at, s.status,
            (s.status = 'scheduled' AND s.starts_at > now()) AS bookable,
            e.id AS event_id, e.title, e.slug, e.poster_url, e.language, e.duration_min,
            c.name AS category_name, c.slug AS category_slug,
            v.id AS venue_id, v.name AS venue_name, v.address AS venue_address, v.city AS venue_city
     FROM shows s
     JOIN events e ON e.id = s.event_id
     JOIN categories c ON c.id = e.category_id
     JOIN venues v ON v.id = s.venue_id
     WHERE s.id = $1 AND e.status = 'published'`,
    [showId],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    id: r.id,
    startsAt: r.starts_at,
    status: r.status,
    bookable: r.bookable,
    event: {
      id: r.event_id,
      title: r.title,
      slug: r.slug,
      posterUrl: r.poster_url,
      language: r.language,
      durationMin: r.duration_min,
      category: { name: r.category_name, slug: r.category_slug },
    },
    venue: { id: r.venue_id, name: r.venue_name, address: r.venue_address, city: r.venue_city },
  };
}

/**
 * available = capacity − sold − quantity in holds that are still active and unexpired.
 * Expired-but-not-yet-cleaned holds are ignored here (lazy expiry), so the number is accurate
 * even between cleanup job runs.
 */
export async function listZonesWithAvailability(showId: string): Promise<ShowZone[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    type: ZoneType;
    price_paise: number;
    capacity: number;
    sort_order: number;
    available: number;
  }>(
    `SELECT sz.id, sz.name, sz.type, sz.price_paise, sz.capacity, sz.sort_order,
            GREATEST(sz.capacity - sz.sold_count - COALESCE(active.qty, 0), 0)::int AS available
     FROM show_zones sz
     LEFT JOIN LATERAL (
       SELECT SUM(hi.quantity) AS qty
       FROM hold_items hi
       JOIN holds h ON h.id = hi.hold_id
       WHERE hi.show_zone_id = sz.id AND h.status = 'active' AND h.expires_at > now()
     ) active ON true
     WHERE sz.show_id = $1
     ORDER BY sz.sort_order, sz.name`,
    [showId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    pricePaise: r.price_paise,
    capacity: r.capacity,
    available: r.available,
    sortOrder: r.sort_order,
  }));
}

/**
 * Seat map with *effective* status: a 'held' seat whose held_until has passed is shown as
 * 'available' (lazy expiry). Seats held by the requesting user are flagged mine = true.
 */
export async function listSeatMap(showId: string, userId: string | null): Promise<SeatMapZone[]> {
  const { rows } = await pool.query<{
    zone_id: string;
    zone_name: string;
    price_paise: number;
    id: string;
    row_label: string;
    seat_number: number;
    grid_row: number;
    grid_col: number;
    status: SeatStatus;
    mine: boolean;
  }>(
    `SELECT sz.id AS zone_id, sz.name AS zone_name, sz.price_paise,
            ss.id, ss.row_label, ss.seat_number, ss.grid_row, ss.grid_col,
            CASE WHEN ss.status = 'held' AND (ss.held_until IS NULL OR ss.held_until <= now())
                 THEN 'available' ELSE ss.status END AS status,
            (ss.status = 'held' AND ss.held_until > now() AND h.user_id IS NOT DISTINCT FROM $2::uuid
             AND $2::uuid IS NOT NULL) AS mine
     FROM show_seats ss
     JOIN show_zones sz ON sz.id = ss.show_zone_id
     LEFT JOIN holds h ON h.id = ss.hold_id
     WHERE ss.show_id = $1
     ORDER BY sz.sort_order, ss.grid_row, ss.grid_col`,
    [showId, userId],
  );

  const zones = new Map<string, SeatMapZone>();
  for (const r of rows) {
    let zone = zones.get(r.zone_id);
    if (!zone) {
      zone = {
        id: r.zone_id,
        name: r.zone_name,
        pricePaise: r.price_paise,
        rows: 0,
        cols: 0,
        seats: [],
      };
      zones.set(r.zone_id, zone);
    }
    // grid size = furthest seat; missing cells in between are aisles / disabled
    zone.rows = Math.max(zone.rows, r.grid_row);
    zone.cols = Math.max(zone.cols, r.grid_col);
    zone.seats.push({
      id: r.id,
      rowLabel: r.row_label,
      seatNumber: r.seat_number,
      gridRow: r.grid_row,
      gridCol: r.grid_col,
      status: r.status,
      mine: r.mine,
    });
  }
  return [...zones.values()];
}

// ---------- used by the booking engine ----------

export interface BookableShowRow {
  id: string;
  startsAt: Date;
  bookable: boolean;
}

/**
 * FOR SHARE: many holds can be created on a show at once, but an organizer cancelling the show
 * (FOR UPDATE) waits for them — and vice versa — so no hold slips in after cancellation.
 */
export async function findShowForBooking(
  db: Queryable,
  showId: string,
): Promise<BookableShowRow | undefined> {
  const { rows } = await db.query<{ id: string; starts_at: Date; bookable: boolean }>(
    `SELECT s.id, s.starts_at,
            (e.status = 'published' AND s.status = 'scheduled' AND s.starts_at > now()) AS bookable
     FROM shows s
     JOIN events e ON e.id = s.event_id
     WHERE s.id = $1
     FOR SHARE OF s`,
    [showId],
  );
  const r = rows[0];
  return r && { id: r.id, startsAt: r.starts_at, bookable: r.bookable };
}

export interface ZoneRow {
  id: string;
  name: string;
  type: ZoneType;
  pricePaise: number;
}

export async function listZonesForShow(db: Queryable, showId: string): Promise<ZoneRow[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    type: ZoneType;
    price_paise: number;
  }>('SELECT id, name, type, price_paise FROM show_zones WHERE show_id = $1', [showId]);
  return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, pricePaise: r.price_paise }));
}
