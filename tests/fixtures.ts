import { pool, withTransaction } from '../src/config/db';
import { createShowWithInventory } from '../src/modules/shows/show-inventory.repository';
import { createUser } from './helpers';

type ZoneSpec =
  | { name: string; type: 'standing'; capacity: number; pricePaise: number }
  | { name: string; type: 'seated'; rows: number; cols: number; pricePaise: number };

export interface ShowFixture {
  showId: string;
  eventId: string;
  slug: string;
  zones: { id: string; name: string; type: 'standing' | 'seated'; seatIds: string[] }[];
}

let counter = 0;

/** Builds organizer → category → venue → layout → event → show with inventory, in one go. */
export async function createShowFixture(
  options: {
    title?: string;
    categorySlug?: string;
    city?: string;
    startsAt?: Date;
    eventStatus?: 'draft' | 'pending' | 'published' | 'rejected' | 'cancelled';
    zones?: ZoneSpec[];
  } = {},
): Promise<ShowFixture> {
  counter++;
  const title = options.title ?? `Test Event ${counter}`;
  const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${counter}`;
  const categorySlug = options.categorySlug ?? 'movies';
  const zones = options.zones ?? [
    { name: 'General', type: 'standing', capacity: 10, pricePaise: 50000 },
  ];
  const organizer = await createUser({ role: 'organizer' });

  return withTransaction(async (client) => {
    const category = await client.query<{ id: string }>(
      `INSERT INTO categories (name, slug) VALUES ($1, $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [categorySlug],
    );
    const venue = await client.query<{ id: string }>(
      `INSERT INTO venues (organizer_id, name, address, city) VALUES ($1, 'Test Venue', '1 Test St', $2)
       RETURNING id`,
      [organizer.id, options.city ?? 'Bengaluru'],
    );
    const layout = await client.query<{ id: string }>(
      "INSERT INTO layouts (venue_id, name) VALUES ($1, 'Main') RETURNING id",
      [venue.rows[0]!.id],
    );
    const layoutId = layout.rows[0]!.id;

    let nextRow = 0; // row labels continue across zones (unique per show)
    const zonePrices: { layoutZoneId: string; pricePaise: number }[] = [];
    for (const [i, z] of zones.entries()) {
      const lz = await client.query<{ id: string }>(
        `INSERT INTO layout_zones (layout_id, name, type, capacity, grid_rows, grid_cols, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        z.type === 'standing'
          ? [layoutId, z.name, 'standing', z.capacity, null, null, i]
          : [layoutId, z.name, 'seated', null, z.rows, z.cols, i],
      );
      const layoutZoneId = lz.rows[0]!.id;
      zonePrices.push({ layoutZoneId, pricePaise: z.pricePaise });

      if (z.type === 'seated') {
        for (let r = 1; r <= z.rows; r++) {
          const rowLabel = String.fromCharCode(65 + nextRow++);
          for (let c = 1; c <= z.cols; c++) {
            await client.query(
              `INSERT INTO layout_seats (layout_zone_id, row_label, seat_number, grid_row, grid_col)
               VALUES ($1, $2, $3, $4, $5)`,
              [layoutZoneId, rowLabel, c, r, c],
            );
          }
        }
      }
    }

    const event = await client.query<{ id: string }>(
      `INSERT INTO events (organizer_id, category_id, title, slug, description, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        organizer.id,
        category.rows[0]!.id,
        title,
        slug,
        `About ${title}`,
        options.eventStatus ?? 'published',
      ],
    );
    const eventId = event.rows[0]!.id;

    const showId = await createShowWithInventory(client, {
      eventId,
      venueId: venue.rows[0]!.id,
      layoutId,
      startsAt: options.startsAt ?? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      zonePrices,
    });

    const showZones = await client.query<{ id: string; name: string; type: 'standing' | 'seated' }>(
      'SELECT id, name, type FROM show_zones WHERE show_id = $1 ORDER BY sort_order',
      [showId],
    );
    const result: ShowFixture = { showId, eventId, slug, zones: [] };
    for (const z of showZones.rows) {
      const seats = await client.query<{ id: string }>(
        'SELECT id FROM show_seats WHERE show_zone_id = $1 ORDER BY grid_row, grid_col',
        [z.id],
      );
      result.zones.push({ ...z, seatIds: seats.rows.map((s) => s.id) });
    }
    return result;
  });
}

export async function zoneCounts(zoneId: string) {
  const { rows } = await pool.query<{ sold_count: number; held_count: number; capacity: number }>(
    'SELECT sold_count, held_count, capacity FROM show_zones WHERE id = $1',
    [zoneId],
  );
  return rows[0]!;
}
