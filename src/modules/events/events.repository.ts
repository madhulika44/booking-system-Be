import { pool } from '../../config/db';

export interface EventCard {
  id: string;
  title: string;
  slug: string;
  posterUrl: string | null;
  language: string | null;
  durationMin: number | null;
  category: { name: string; slug: string };
  nextShowAt: Date;
  minPricePaise: number | null;
  cities: string[];
}

export interface EventDetail extends Omit<EventCard, 'nextShowAt' | 'minPricePaise' | 'cities'> {
  description: string;
  organizer: { name: string };
  venues: Venue[];
  shows: EventShow[];
}

export interface Venue {
  id: string;
  name: string;
  address: string;
  city: string;
}

export interface EventShow {
  id: string;
  startsAt: Date;
  venue: Venue;
  minPricePaise: number | null;
}

export interface EventFilters {
  q?: string;
  category?: string;
  city?: string;
  from?: Date;
  to?: Date;
  minPrice?: number; // paise
  maxPrice?: number; // paise
}

interface EventCardRow {
  id: string;
  title: string;
  slug: string;
  poster_url: string | null;
  language: string | null;
  duration_min: number | null;
  category_name: string;
  category_slug: string;
  next_show_at: Date;
  min_price_paise: number | null;
  cities: string[];
}

const toEventCard = (r: EventCardRow): EventCard => ({
  id: r.id,
  title: r.title,
  slug: r.slug,
  posterUrl: r.poster_url,
  language: r.language,
  durationMin: r.duration_min,
  category: { name: r.category_name, slug: r.category_slug },
  nextShowAt: r.next_show_at,
  minPricePaise: r.min_price_paise,
  cities: r.cities,
});

/**
 * Published events that have at least one upcoming scheduled show matching the city/date filters.
 * Filters are optional parameters ($n IS NULL OR ...) so the SQL text is static — no string building.
 *   $1 city  $2 from  $3 to  $4 category slug  $5 search pattern  $6 min price  $7 max price
 */
const FILTERED_EVENTS_SQL = `
  WITH upcoming AS (
    SELECT s.event_id,
           MIN(s.starts_at)                            AS next_show_at,
           MIN(sz.price_paise)                         AS min_price_paise,
           COALESCE(SUM(sz.sold_count), 0)::int        AS tickets_sold,
           array_agg(DISTINCT v.city ORDER BY v.city)  AS cities
    FROM shows s
    JOIN venues v ON v.id = s.venue_id
    LEFT JOIN show_zones sz ON sz.show_id = s.id
    WHERE s.status = 'scheduled'
      AND s.starts_at > now()
      AND ($1::text IS NULL OR lower(v.city) = lower($1))
      AND ($2::timestamptz IS NULL OR s.starts_at >= $2)
      AND ($3::timestamptz IS NULL OR s.starts_at <= $3)
    GROUP BY s.event_id
    -- price filter: at least one zone of a matching upcoming show is inside the range
    HAVING ($6::int IS NULL AND $7::int IS NULL)
        OR bool_or(sz.price_paise BETWEEN COALESCE($6::int, 0) AND COALESCE($7::int, 2147483647))
  )
  SELECT e.id, e.title, e.slug, e.poster_url, e.language, e.duration_min,
         c.name AS category_name, c.slug AS category_slug,
         u.next_show_at, u.min_price_paise, u.cities, u.tickets_sold
  FROM events e
  JOIN upcoming u ON u.event_id = e.id
  JOIN categories c ON c.id = e.category_id
  WHERE e.status = 'published'
    AND ($4::text IS NULL OR c.slug = $4)
    AND ($5::text IS NULL OR e.title ILIKE $5 OR e.description ILIKE $5)`;

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

function filterParams(f: EventFilters): unknown[] {
  return [
    f.city ?? null,
    f.from ?? null,
    f.to ?? null,
    f.category ?? null,
    f.q ? `%${escapeLike(f.q)}%` : null,
    f.minPrice ?? null,
    f.maxPrice ?? null,
  ];
}

export async function listEvents(
  filters: EventFilters,
  limit: number,
  offset: number,
): Promise<{ rows: EventCard[]; total: number }> {
  const params = filterParams(filters);
  const [data, count] = await Promise.all([
    pool.query<EventCardRow>(
      `${FILTERED_EVENTS_SQL}
       ORDER BY u.next_show_at, e.title
       LIMIT $8 OFFSET $9`,
      [...params, limit, offset],
    ),
    pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM (${FILTERED_EVENTS_SQL}) filtered`,
      params,
    ),
  ]);
  return { rows: data.rows.map(toEventCard), total: count.rows[0]!.total };
}

/** Home carousel: best-selling upcoming events, soonest first on ties. */
export async function listFeaturedEvents(limit: number): Promise<EventCard[]> {
  const { rows } = await pool.query<EventCardRow>(
    `${FILTERED_EVENTS_SQL}
     ORDER BY u.tickets_sold DESC, u.next_show_at
     LIMIT $8`,
    [...filterParams({}), limit],
  );
  return rows.map(toEventCard);
}

export async function findPublishedEventBySlug(slug: string): Promise<EventDetail | undefined> {
  const { rows } = await pool.query<{
    id: string;
    title: string;
    slug: string;
    description: string;
    poster_url: string | null;
    language: string | null;
    duration_min: number | null;
    category_name: string;
    category_slug: string;
    organizer_name: string;
  }>(
    `SELECT e.id, e.title, e.slug, e.description, e.poster_url, e.language, e.duration_min,
            c.name AS category_name, c.slug AS category_slug, u.name AS organizer_name
     FROM events e
     JOIN categories c ON c.id = e.category_id
     JOIN users u ON u.id = e.organizer_id
     WHERE e.slug = $1 AND e.status = 'published'`,
    [slug],
  );
  const e = rows[0];
  if (!e) return undefined;

  const shows = await pool.query<{
    id: string;
    starts_at: Date;
    min_price_paise: number | null;
    venue_id: string;
    venue_name: string;
    venue_address: string;
    venue_city: string;
  }>(
    `SELECT s.id, s.starts_at,
            (SELECT MIN(sz.price_paise) FROM show_zones sz WHERE sz.show_id = s.id) AS min_price_paise,
            v.id AS venue_id, v.name AS venue_name, v.address AS venue_address, v.city AS venue_city
     FROM shows s
     JOIN venues v ON v.id = s.venue_id
     WHERE s.event_id = $1 AND s.status = 'scheduled' AND s.starts_at > now()
     ORDER BY s.starts_at`,
    [e.id],
  );

  const eventShows: EventShow[] = shows.rows.map((s) => ({
    id: s.id,
    startsAt: s.starts_at,
    minPricePaise: s.min_price_paise,
    venue: { id: s.venue_id, name: s.venue_name, address: s.venue_address, city: s.venue_city },
  }));
  const venues = [...new Map(eventShows.map((s) => [s.venue.id, s.venue])).values()];

  return {
    id: e.id,
    title: e.title,
    slug: e.slug,
    description: e.description,
    posterUrl: e.poster_url,
    language: e.language,
    durationMin: e.duration_min,
    category: { name: e.category_name, slug: e.category_slug },
    organizer: { name: e.organizer_name },
    venues,
    shows: eventShows,
  };
}

/** Distinct venue cities that currently have at least one bookable (upcoming, published) show. */
export async function listCitiesWithUpcomingShows(): Promise<string[]> {
  const { rows } = await pool.query<{ city: string }>(
    `SELECT DISTINCT v.city
     FROM venues v
     JOIN shows s ON s.venue_id = v.id
     JOIN events e ON e.id = s.event_id
     WHERE e.status = 'published' AND s.status = 'scheduled' AND s.starts_at > now()
     ORDER BY v.city`,
  );
  return rows.map((r) => r.city);
}
