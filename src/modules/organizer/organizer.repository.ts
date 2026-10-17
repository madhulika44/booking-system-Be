import type { PoolClient } from 'pg';
import { pool, type Queryable } from '../../config/db';
import type { ZoneType } from '../shows/shows.repository';
import type { OwnerId } from '../venues/venues.repository';
import type { EventStatus } from './organizer.schemas';

export type ShowStatus = 'scheduled' | 'cancelled' | 'completed';

export interface ManagedEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  posterUrl: string | null;
  language: string | null;
  durationMin: number | null;
  status: EventStatus;
  rejectionReason: string | null;
  createdAt: Date;
  category: { id: string; name: string; slug: string };
  organizer: { id: string; name: string; email: string };
  showCount: number;
  nextShowAt: Date | null;
}

export interface ManagedShow {
  id: string;
  eventId: string;
  startsAt: Date;
  status: ShowStatus;
  venue: { id: string; name: string; city: string };
  layout: { id: string; name: string };
  zones: {
    id: string;
    name: string;
    type: ZoneType;
    pricePaise: number;
    capacity: number;
    soldCount: number;
    heldCount: number;
  }[];
  capacity: number;
  ticketsSold: number;
  revenuePaise: number;
}

// ---------- events ----------

interface EventRow {
  id: string;
  title: string;
  slug: string;
  description: string;
  poster_url: string | null;
  language: string | null;
  duration_min: number | null;
  status: EventStatus;
  rejection_reason: string | null;
  created_at: Date;
  category_id: string;
  category_name: string;
  category_slug: string;
  organizer_id: string;
  organizer_name: string;
  organizer_email: string;
  show_count: number;
  next_show_at: Date | null;
}

const toEvent = (r: EventRow): ManagedEvent => ({
  id: r.id,
  title: r.title,
  slug: r.slug,
  description: r.description,
  posterUrl: r.poster_url,
  language: r.language,
  durationMin: r.duration_min,
  status: r.status,
  rejectionReason: r.rejection_reason,
  createdAt: r.created_at,
  category: { id: r.category_id, name: r.category_name, slug: r.category_slug },
  organizer: { id: r.organizer_id, name: r.organizer_name, email: r.organizer_email },
  showCount: r.show_count,
  nextShowAt: r.next_show_at,
});

const EVENT_SELECT = `
  SELECT e.id, e.title, e.slug, e.description, e.poster_url, e.language, e.duration_min,
         e.status, e.rejection_reason, e.created_at,
         c.id AS category_id, c.name AS category_name, c.slug AS category_slug,
         u.id AS organizer_id, u.name AS organizer_name, u.email AS organizer_email,
         (SELECT COUNT(*)::int FROM shows s WHERE s.event_id = e.id) AS show_count,
         (SELECT MIN(s.starts_at) FROM shows s
          WHERE s.event_id = e.id AND s.status = 'scheduled' AND s.starts_at > now()) AS next_show_at
  FROM events e
  JOIN categories c ON c.id = e.category_id
  JOIN users u ON u.id = e.organizer_id`;

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** Used by organizers (own events) and admins (ownerId null, e.g. ?status=pending). */
export async function listEvents(
  ownerId: OwnerId,
  filters: { status?: EventStatus; q?: string },
  limit: number,
  offset: number,
): Promise<{ rows: ManagedEvent[]; total: number }> {
  const params = [ownerId, filters.status ?? null, filters.q ? `%${escapeLike(filters.q)}%` : null];
  const where = `
    WHERE ($1::uuid IS NULL OR e.organizer_id = $1)
      AND ($2::text IS NULL OR e.status = $2)
      AND ($3::text IS NULL OR e.title ILIKE $3)`;
  const [data, count] = await Promise.all([
    pool.query<EventRow>(`${EVENT_SELECT} ${where} ORDER BY e.created_at DESC LIMIT $4 OFFSET $5`, [
      ...params,
      limit,
      offset,
    ]),
    pool.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM events e ${where}`, params),
  ]);
  return { rows: data.rows.map(toEvent), total: count.rows[0]!.total };
}

export async function findEvent(
  id: string,
  ownerId: OwnerId,
  db: Queryable = pool,
): Promise<ManagedEvent | undefined> {
  const { rows } = await db.query<EventRow>(
    `${EVENT_SELECT} WHERE e.id = $1 AND ($2::uuid IS NULL OR e.organizer_id = $2)`,
    [id, ownerId],
  );
  return rows[0] && toEvent(rows[0]);
}

/** Row-locks the event for a status change. */
export async function lockEvent(
  client: PoolClient,
  id: string,
  ownerId: OwnerId,
): Promise<{ id: string; status: EventStatus; organizerId: string } | undefined> {
  const { rows } = await client.query<{ id: string; status: EventStatus; organizer_id: string }>(
    `SELECT id, status, organizer_id FROM events
     WHERE id = $1 AND ($2::uuid IS NULL OR organizer_id = $2)
     FOR UPDATE`,
    [id, ownerId],
  );
  const r = rows[0];
  return r && { id: r.id, status: r.status, organizerId: r.organizer_id };
}

export async function slugExists(slug: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM events WHERE slug = $1', [slug]);
  return Boolean(rowCount);
}

export async function categoryExists(id: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM categories WHERE id = $1', [id]);
  return Boolean(rowCount);
}

export interface EventContent {
  title: string;
  categoryId: string;
  description: string;
  posterUrl: string | null;
  language: string | null;
  durationMin: number | null;
}

export async function insertEvent(
  organizerId: string,
  slug: string,
  input: EventContent,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO events (organizer_id, category_id, title, slug, description, poster_url, language, duration_min)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      organizerId,
      input.categoryId,
      input.title,
      slug,
      input.description,
      input.posterUrl,
      input.language,
      input.durationMin,
    ],
  );
  return rows[0]!.id;
}

/** Writes all content fields (the service merges the patch onto the current values first). */
export async function updateEventContent(id: string, input: EventContent): Promise<void> {
  await pool.query(
    `UPDATE events
     SET category_id = $2, title = $3, description = $4, poster_url = $5, language = $6, duration_min = $7
     WHERE id = $1`,
    [
      id,
      input.categoryId,
      input.title,
      input.description,
      input.posterUrl,
      input.language,
      input.durationMin,
    ],
  );
}

export async function setEventStatus(
  db: Queryable,
  id: string,
  status: EventStatus,
  rejectionReason: string | null = null,
): Promise<void> {
  await db.query('UPDATE events SET status = $2, rejection_reason = $3 WHERE id = $1', [
    id,
    status,
    rejectionReason,
  ]);
}

export async function deleteEvent(id: string): Promise<void> {
  await pool.query('DELETE FROM events WHERE id = $1', [id]);
}

// ---------- shows ----------

export async function listShowsForEvent(
  eventId: string,
  db: Queryable = pool,
): Promise<ManagedShow[]> {
  const { rows } = await db.query<{
    id: string;
    event_id: string;
    starts_at: Date;
    status: ShowStatus;
    venue_id: string;
    venue_name: string;
    venue_city: string;
    layout_id: string;
    layout_name: string;
    zones: ManagedShow['zones'];
    revenue_paise: string;
  }>(
    `SELECT s.id, s.event_id, s.starts_at, s.status,
            v.id AS venue_id, v.name AS venue_name, v.city AS venue_city,
            l.id AS layout_id, l.name AS layout_name,
            COALESCE((SELECT json_agg(json_build_object(
                        'id', sz.id, 'name', sz.name, 'type', sz.type, 'pricePaise', sz.price_paise,
                        'capacity', sz.capacity, 'soldCount', sz.sold_count, 'heldCount', sz.held_count
                      ) ORDER BY sz.sort_order)
                      FROM show_zones sz WHERE sz.show_id = s.id), '[]') AS zones,
            (SELECT COALESCE(SUM(b.total_paise), 0)::bigint FROM bookings b
             WHERE b.show_id = s.id AND b.status = 'confirmed') AS revenue_paise
     FROM shows s
     JOIN venues v ON v.id = s.venue_id
     JOIN layouts l ON l.id = s.layout_id
     WHERE s.event_id = $1
     ORDER BY s.starts_at`,
    [eventId],
  );
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    startsAt: r.starts_at,
    status: r.status,
    venue: { id: r.venue_id, name: r.venue_name, city: r.venue_city },
    layout: { id: r.layout_id, name: r.layout_name },
    zones: r.zones,
    capacity: r.zones.reduce((sum, z) => sum + z.capacity, 0),
    ticketsSold: r.zones.reduce((sum, z) => sum + z.soldCount, 0),
    revenuePaise: Number(r.revenue_paise),
  }));
}

/** Show with ownership checked through its event. */
export async function findShow(
  showId: string,
  ownerId: OwnerId,
  db: Queryable = pool,
): Promise<
  | { id: string; eventId: string; eventTitle: string; status: ShowStatus; startsAt: Date }
  | undefined
> {
  const { rows } = await db.query<{
    id: string;
    event_id: string;
    title: string;
    status: ShowStatus;
    starts_at: Date;
  }>(
    `SELECT s.id, s.event_id, e.title, s.status, s.starts_at
     FROM shows s JOIN events e ON e.id = s.event_id
     WHERE s.id = $1 AND ($2::uuid IS NULL OR e.organizer_id = $2)`,
    [showId, ownerId],
  );
  const r = rows[0];
  return (
    r && {
      id: r.id,
      eventId: r.event_id,
      eventTitle: r.title,
      status: r.status,
      startsAt: r.starts_at,
    }
  );
}

/** Locks show rows (ascending id) so hold creation — which takes FOR SHARE — waits for us. */
export async function lockShows(
  client: PoolClient,
  filter: { showId?: string; eventId?: string; ownerId: OwnerId },
): Promise<{ id: string; status: ShowStatus }[]> {
  const { rows } = await client.query<{ id: string; status: ShowStatus }>(
    `SELECT s.id, s.status
     FROM shows s JOIN events e ON e.id = s.event_id
     WHERE ($1::uuid IS NULL OR s.id = $1)
       AND ($2::uuid IS NULL OR s.event_id = $2)
       AND ($3::uuid IS NULL OR e.organizer_id = $3)
     ORDER BY s.id
     FOR UPDATE OF s`,
    [filter.showId ?? null, filter.eventId ?? null, filter.ownerId],
  );
  return rows;
}

export async function setShowStatus(
  client: PoolClient,
  id: string,
  status: ShowStatus,
): Promise<void> {
  await client.query('UPDATE shows SET status = $2 WHERE id = $1', [id, status]);
}

export async function listLayoutZoneIds(layoutId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM layout_zones WHERE layout_id = $1',
    [layoutId],
  );
  return rows.map((r) => r.id);
}

// ---------- dashboard ----------

export interface Dashboard {
  ticketsSold: number;
  revenuePaise: number;
  confirmedBookings: number;
  upcomingShowCount: number;
  eventsByStatus: Record<EventStatus, number>;
  upcomingShows: {
    showId: string;
    eventId: string;
    eventTitle: string;
    startsAt: Date;
    venueName: string;
    capacity: number;
    sold: number;
    occupancyPercent: number;
  }[];
}

export async function getDashboard(ownerId: OwnerId): Promise<Dashboard> {
  const [totals, byStatus, shows] = await Promise.all([
    pool.query<{ tickets_sold: number; revenue_paise: string; bookings: number; upcoming: number }>(
      `SELECT
         (SELECT COALESCE(SUM(bi.quantity), 0)::int
          FROM booking_items bi
          JOIN bookings b ON b.id = bi.booking_id
          JOIN shows s ON s.id = b.show_id
          JOIN events e ON e.id = s.event_id
          WHERE b.status = 'confirmed' AND ($1::uuid IS NULL OR e.organizer_id = $1)) AS tickets_sold,
         (SELECT COALESCE(SUM(b.total_paise), 0)::bigint
          FROM bookings b
          JOIN shows s ON s.id = b.show_id
          JOIN events e ON e.id = s.event_id
          WHERE b.status = 'confirmed' AND ($1::uuid IS NULL OR e.organizer_id = $1)) AS revenue_paise,
         (SELECT COUNT(*)::int
          FROM bookings b
          JOIN shows s ON s.id = b.show_id
          JOIN events e ON e.id = s.event_id
          WHERE b.status = 'confirmed' AND ($1::uuid IS NULL OR e.organizer_id = $1)) AS bookings,
         (SELECT COUNT(*)::int
          FROM shows s JOIN events e ON e.id = s.event_id
          WHERE s.status = 'scheduled' AND s.starts_at > now()
            AND ($1::uuid IS NULL OR e.organizer_id = $1)) AS upcoming`,
      [ownerId],
    ),
    pool.query<{ status: EventStatus; count: number }>(
      `SELECT status, COUNT(*)::int AS count FROM events
       WHERE ($1::uuid IS NULL OR organizer_id = $1)
       GROUP BY status`,
      [ownerId],
    ),
    pool.query<{
      show_id: string;
      event_id: string;
      title: string;
      starts_at: Date;
      venue_name: string;
      capacity: number;
      sold: number;
    }>(
      `SELECT s.id AS show_id, e.id AS event_id, e.title, s.starts_at, v.name AS venue_name,
              COALESCE(SUM(sz.capacity), 0)::int AS capacity,
              COALESCE(SUM(sz.sold_count), 0)::int AS sold
       FROM shows s
       JOIN events e ON e.id = s.event_id
       JOIN venues v ON v.id = s.venue_id
       LEFT JOIN show_zones sz ON sz.show_id = s.id
       WHERE s.status = 'scheduled' AND s.starts_at > now()
         AND ($1::uuid IS NULL OR e.organizer_id = $1)
       GROUP BY s.id, e.id, v.id
       ORDER BY s.starts_at
       LIMIT 20`,
      [ownerId],
    ),
  ]);

  const eventsByStatus = { draft: 0, pending: 0, published: 0, rejected: 0, cancelled: 0 };
  for (const r of byStatus.rows) eventsByStatus[r.status] = r.count;
  const t = totals.rows[0]!;

  return {
    ticketsSold: t.tickets_sold,
    revenuePaise: Number(t.revenue_paise),
    confirmedBookings: t.bookings,
    upcomingShowCount: t.upcoming,
    eventsByStatus,
    upcomingShows: shows.rows.map((r) => ({
      showId: r.show_id,
      eventId: r.event_id,
      eventTitle: r.title,
      startsAt: r.starts_at,
      venueName: r.venue_name,
      capacity: r.capacity,
      sold: r.sold,
      // display-only percentage, one decimal
      occupancyPercent: r.capacity ? Math.round((r.sold * 1000) / r.capacity) / 10 : 0,
    })),
  };
}
