/**
 * Demo data (SPEC §10). Wipes all tables, then inserts users, categories, venues/layouts,
 * events, shows and some bookings. All names are invented.
 *
 *   npm run seed
 */
import bcrypt from 'bcrypt';
import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../src/config/db';
import { env } from '../src/config/env';
import { createShowWithInventory } from '../src/modules/shows/show-inventory.repository';
import { generateBookingRef, generatePaymentRef } from '../src/utils/booking-ref';
import { slugify } from '../src/utils/slug';

const DEMO_PASSWORD = 'Demo@1234';
const DAY = 24 * 60 * 60 * 1000;

// ---------- small helpers ----------

async function insertId(client: PoolClient, sql: string, params: unknown[]): Promise<string> {
  const { rows } = await client.query<{ id: string }>(sql, params);
  return rows[0]!.id;
}

/** A date `daysFromNow` days ahead at the given IST wall-clock time (IST = UTC+5:30). */
function istDate(daysFromNow: number, hour: number, minute = 0): Date {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysFromNow),
  );
  d.setUTCMinutes(hour * 60 + minute - 330);
  return d;
}

const poster = (slug: string) => `https://picsum.photos/seed/${slug}/600/900`;

// Deterministic pseudo-random so every seed run looks the same
let seedState = 42;
function rand(): number {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}

// ---------- layouts ----------

interface SeatedZoneDef {
  name: string;
  type: 'seated';
  rows: number;
  cols: number;
  firstRow: string; // row labels must be unique across a show, so zones continue the alphabet
  aisleCols?: number[];
}
interface StandingZoneDef {
  name: string;
  type: 'standing';
  capacity: number;
}
type ZoneDef = SeatedZoneDef | StandingZoneDef;

async function createLayout(
  client: PoolClient,
  venueId: string,
  name: string,
  zones: ZoneDef[],
): Promise<{ layoutId: string; zoneIds: string[] }> {
  const layoutId = await insertId(
    client,
    'INSERT INTO layouts (venue_id, name) VALUES ($1, $2) RETURNING id',
    [venueId, name],
  );
  const zoneIds: string[] = [];

  for (const [index, zone] of zones.entries()) {
    if (zone.type === 'standing') {
      zoneIds.push(
        await insertId(
          client,
          `INSERT INTO layout_zones (layout_id, name, type, capacity, sort_order)
           VALUES ($1, $2, 'standing', $3, $4) RETURNING id`,
          [layoutId, zone.name, zone.capacity, index],
        ),
      );
      continue;
    }

    const zoneId = await insertId(
      client,
      `INSERT INTO layout_zones (layout_id, name, type, grid_rows, grid_cols, sort_order)
       VALUES ($1, $2, 'seated', $3, $4, $5) RETURNING id`,
      [layoutId, zone.name, zone.rows, zone.cols, index],
    );
    zoneIds.push(zoneId);

    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let r = 0; r < zone.rows; r++) {
      const rowLabel = String.fromCharCode(zone.firstRow.charCodeAt(0) + r);
      let seatNumber = 0;
      for (let c = 0; c < zone.cols; c++) {
        const isAisle = zone.aisleCols?.includes(c + 1) ?? false;
        if (!isAisle) seatNumber++;
        const p = values.length;
        tuples.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6})`);
        values.push(
          zoneId,
          rowLabel,
          isAisle ? 0 : seatNumber,
          r + 1,
          c + 1,
          isAisle ? 'aisle' : 'seat',
        );
      }
    }
    await client.query(
      `INSERT INTO layout_seats (layout_zone_id, row_label, seat_number, grid_row, grid_col, kind)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }

  return { layoutId, zoneIds };
}

// ---------- bookings (direct SQL, keeps counters consistent with the booking engine) ----------

interface ShowZoneRow {
  id: string;
  type: 'standing' | 'seated';
  price_paise: number;
  capacity: number;
}

async function seedBooking(
  client: PoolClient,
  userId: string,
  showId: string,
  picks: { zoneId: string; seatIds?: string[]; quantity?: number }[],
  createdAt?: Date,
): Promise<void> {
  let totalPaise = 0;
  const items: { zoneId: string; seatId: string | null; quantity: number; price: number }[] = [];

  for (const pick of picks) {
    const { rows } = await client.query<{ price_paise: number }>(
      'SELECT price_paise FROM show_zones WHERE id = $1',
      [pick.zoneId],
    );
    const price = rows[0]!.price_paise;
    if (pick.seatIds?.length) {
      await client.query("UPDATE show_seats SET status = 'booked' WHERE id = ANY($1::uuid[])", [
        pick.seatIds,
      ]);
      await client.query('UPDATE show_zones SET sold_count = sold_count + $2 WHERE id = $1', [
        pick.zoneId,
        pick.seatIds.length,
      ]);
      for (const seatId of pick.seatIds)
        items.push({ zoneId: pick.zoneId, seatId, quantity: 1, price });
      totalPaise += price * pick.seatIds.length;
    } else {
      const qty = pick.quantity ?? 1;
      await client.query('UPDATE show_zones SET sold_count = sold_count + $2 WHERE id = $1', [
        pick.zoneId,
        qty,
      ]);
      items.push({ zoneId: pick.zoneId, seatId: null, quantity: qty, price });
      totalPaise += price * qty;
    }
  }

  const bookingId = await insertId(
    client,
    `INSERT INTO bookings (booking_ref, user_id, show_id, idempotency_key, total_paise, payment_ref, created_at)
     VALUES ($1, $2, $3, gen_random_uuid()::text, $4, $5, $6) RETURNING id`,
    [
      generateBookingRef(),
      userId,
      showId,
      totalPaise,
      generatePaymentRef(),
      createdAt ?? new Date(),
    ],
  );
  for (const item of items) {
    await client.query(
      `INSERT INTO booking_items (booking_id, show_zone_id, show_seat_id, quantity, unit_price_paise)
       VALUES ($1, $2, $3, $4, $5)`,
      [bookingId, item.zoneId, item.seatId, item.quantity, item.price],
    );
  }
}

async function zonesOf(client: PoolClient, showId: string): Promise<ShowZoneRow[]> {
  const { rows } = await client.query<ShowZoneRow>(
    'SELECT id, type, price_paise, capacity FROM show_zones WHERE show_id = $1 ORDER BY sort_order',
    [showId],
  );
  return rows;
}

/** Fill a show to roughly `fillRatio` with bookings from random "other" attendees. */
async function fillShow(
  client: PoolClient,
  showId: string,
  fillRatio: number,
  buyers: string[],
): Promise<void> {
  for (const zone of await zonesOf(client, showId)) {
    if (zone.type === 'standing') {
      let remaining = Math.floor(zone.capacity * fillRatio);
      while (remaining > 0) {
        const qty = Math.min(remaining, 2 + Math.floor(rand() * 5)); // 2..6
        await seedBooking(client, buyers[Math.floor(rand() * buyers.length)]!, showId, [
          { zoneId: zone.id, quantity: qty },
        ]);
        remaining -= qty;
      }
      continue;
    }

    const { rows: seats } = await client.query<{ id: string }>(
      "SELECT id FROM show_seats WHERE show_zone_id = $1 AND status = 'available' ORDER BY grid_row, grid_col",
      [zone.id],
    );
    // Book contiguous pairs/triples so the grid looks like real groups
    let i = 0;
    while (i < seats.length) {
      const group = 2 + Math.floor(rand() * 3);
      if (rand() < fillRatio) {
        const seatIds = seats.slice(i, i + group).map((s) => s.id);
        await seedBooking(client, buyers[Math.floor(rand() * buyers.length)]!, showId, [
          { zoneId: zone.id, seatIds },
        ]);
      }
      i += group;
    }
  }
}

// ---------- main ----------

async function seed(client: PoolClient): Promise<void> {
  await client.query(`
    TRUNCATE booking_items, bookings, hold_items, show_seats, holds, show_zones, shows,
             events, layout_seats, layout_zones, layouts, venues, categories, refresh_tokens, users
    RESTART IDENTITY CASCADE`);

  // Users — same hash for every demo account keeps the seed fast
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const addUser = (name: string, email: string, role: string) =>
    insertId(
      client,
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, email, passwordHash, role],
    );

  const attendee = await addUser('Asha Demo', 'attendee@demo.com', 'attendee');
  const organizer = await addUser('Orion Events', 'organizer@demo.com', 'organizer');
  await addUser('Admin Demo', 'admin@demo.com', 'admin');
  const organizer2 = await addUser('Lantern Live', 'organizer2@demo.com', 'organizer');
  const buyers = [
    await addUser('Ravi Kumar', 'ravi@demo.com', 'attendee'),
    await addUser('Meera Iyer', 'meera@demo.com', 'attendee'),
    await addUser('Kabir Shah', 'kabir@demo.com', 'attendee'),
  ];

  // Categories
  const categories: Record<string, string> = {};
  for (const name of ['Movies', 'Concerts', 'Comedy', 'Theatre', 'Workshops', 'Sports']) {
    categories[name] = await insertId(
      client,
      'INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id',
      [name, slugify(name)],
    );
  }

  // Venues + layouts
  const cinema = await insertId(
    client,
    'INSERT INTO venues (organizer_id, name, address, city) VALUES ($1, $2, $3, $4) RETURNING id',
    [organizer, 'Starlight Cinemas', '12 MG Road', 'Bengaluru'],
  );
  const screen1 = await createLayout(client, cinema, 'Screen 1', [
    { name: 'Recliner', type: 'seated', rows: 2, cols: 10, firstRow: 'A' },
    { name: 'Gold', type: 'seated', rows: 6, cols: 14, firstRow: 'C', aisleCols: [4, 11] },
    { name: 'Silver', type: 'seated', rows: 6, cols: 14, firstRow: 'I', aisleCols: [4, 11] },
  ]);

  const arena = await insertId(
    client,
    'INSERT INTO venues (organizer_id, name, address, city) VALUES ($1, $2, $3, $4) RETURNING id',
    [organizer, 'Horizon Arena', 'Bandra Reclamation', 'Mumbai'],
  );
  const mainArena = await createLayout(client, arena, 'Main Arena', [
    { name: 'Fan Pit', type: 'standing', capacity: 500 },
    { name: 'Gold', type: 'standing', capacity: 1500 },
    { name: 'East Stand', type: 'seated', rows: 10, cols: 20, firstRow: 'A' },
  ]);

  const hall = await insertId(
    client,
    'INSERT INTO venues (organizer_id, name, address, city) VALUES ($1, $2, $3, $4) RETURNING id',
    [organizer2, 'The Loft Hall', '7 Koregaon Park Lane', 'Pune'],
  );
  const mainHall = await createLayout(client, hall, 'Main Hall', [
    { name: 'General', type: 'standing', capacity: 80 },
  ]);

  // Events
  interface EventDef {
    title: string;
    category: string;
    organizerId: string;
    description: string;
    language: string;
    durationMin: number;
    status?: 'published' | 'pending' | 'draft';
    venueId: string;
    layout: { layoutId: string; zoneIds: string[] };
    prices: number[]; // paise, one per layout zone
    shows: [day: number, hour: number, minute?: number][];
  }

  const cinemaPrices = [65000, 35000, 22000];
  const arenaPrices = [450000, 199900, 299900];

  const events: EventDef[] = [
    // Movies @ Starlight Cinemas
    {
      title: 'Echoes of the Monsoon',
      category: 'Movies',
      organizerId: organizer,
      language: 'Hindi',
      durationMin: 142,
      description:
        'A rain-soaked family drama about three siblings who return to their coastal hometown.',
      venueId: cinema,
      layout: screen1,
      prices: cinemaPrices,
      shows: [
        [1, 18, 30],
        [2, 21],
        [5, 15],
        [9, 19],
      ],
    },
    {
      title: 'The Last Lighthouse',
      category: 'Movies',
      organizerId: organizer,
      language: 'English',
      durationMin: 118,
      description: 'A lighthouse keeper discovers a signal from a ship that sank fifty years ago.',
      venueId: cinema,
      layout: screen1,
      prices: cinemaPrices,
      shows: [
        [0, 22],
        [3, 18],
        [7, 20, 30],
        [12, 17],
      ],
    },
    {
      title: 'Neon Drift',
      category: 'Movies',
      organizerId: organizer,
      language: 'Tamil',
      durationMin: 131,
      description: 'Street racers in a futuristic Chennai chase one last midnight run.',
      venueId: cinema,
      layout: screen1,
      prices: cinemaPrices,
      shows: [
        [2, 13],
        [4, 21, 30],
        [15, 19],
      ],
    },
    {
      title: 'Paper Kites',
      category: 'Movies',
      organizerId: organizer,
      language: 'Kannada',
      durationMin: 104,
      description: 'An animated tale of a girl whose kites carry messages across the city.',
      venueId: cinema,
      layout: screen1,
      prices: cinemaPrices,
      shows: [
        [6, 11],
        [13, 11],
        [20, 16],
      ],
    },
    // Concerts & sports @ Horizon Arena
    {
      title: 'Midnight Raga Live',
      category: 'Concerts',
      organizerId: organizer,
      language: 'Hindi',
      durationMin: 180,
      description: 'The fictional fusion band Midnight Raga brings their stadium tour home.',
      venueId: arena,
      layout: mainArena,
      prices: arenaPrices,
      shows: [
        [8, 19],
        [22, 19],
      ],
    },
    {
      title: 'Bassline Carnival',
      category: 'Concerts',
      organizerId: organizer,
      language: 'English',
      durationMin: 240,
      description: 'A night of electronic music with DJ Solenne and the Tidewater Collective.',
      venueId: arena,
      layout: mainArena,
      prices: arenaPrices,
      shows: [[14, 20]],
    },
    {
      title: 'Coastal Kings vs Desert Hawks',
      category: 'Sports',
      organizerId: organizer,
      language: 'English',
      durationMin: 210,
      description: 'League-deciding T20 clash between two invented franchise teams.',
      venueId: arena,
      layout: mainArena,
      prices: [150000, 79900, 120000],
      shows: [
        [10, 19, 30],
        [25, 15, 30],
      ],
    },
    // Comedy, theatre, workshops @ The Loft Hall
    {
      title: 'Chai & Chuckles',
      category: 'Comedy',
      organizerId: organizer2,
      language: 'Hinglish',
      durationMin: 90,
      description: 'Stand-up from Tara Menon on office life, aunties and very strong tea.',
      venueId: hall,
      layout: mainHall,
      prices: [79900],
      shows: [
        [1, 20],
        [8, 20],
        [15, 20],
      ],
    },
    {
      title: 'Open Mic Mayhem',
      category: 'Comedy',
      organizerId: organizer2,
      language: 'English',
      durationMin: 120,
      description: 'Ten new comics, five minutes each, one very forgiving audience.',
      venueId: hall,
      layout: mainHall,
      prices: [29900],
      shows: [
        [4, 21],
        [11, 21],
        [18, 21],
      ],
    },
    {
      title: "The Clockmaker's Daughter",
      category: 'Theatre',
      organizerId: organizer2,
      language: 'English',
      durationMin: 110,
      description: 'An original two-act play about time, grief and a stubborn grandfather clock.',
      venueId: hall,
      layout: mainHall,
      prices: [59900],
      shows: [
        [6, 19],
        [7, 19],
        [21, 19],
      ],
    },
    {
      title: 'Pottery for Beginners',
      category: 'Workshops',
      organizerId: organizer2,
      language: 'English',
      durationMin: 150,
      description: 'Hands-on wheel throwing session. All materials and firing included.',
      venueId: hall,
      layout: mainHall,
      prices: [149900],
      shows: [
        [3, 10],
        [17, 10],
      ],
    },
    {
      title: 'Street Photography Walk & Talk',
      category: 'Workshops',
      organizerId: organizer2,
      language: 'English',
      durationMin: 180,
      description:
        'Learn composition and light, then shoot the old city with a working photographer.',
      venueId: hall,
      layout: mainHall,
      prices: [99900],
      shows: [
        [5, 7],
        [19, 7],
      ],
    },
    {
      title: 'Improv Nights: Yes, And',
      category: 'Theatre',
      organizerId: organizer2,
      language: 'English',
      durationMin: 75,
      description: 'Fully improvised scenes from audience suggestions. No two nights alike.',
      venueId: hall,
      layout: mainHall,
      prices: [49900],
      shows: [
        [2, 20],
        [9, 20],
        [27, 20],
      ],
    },
    // Pending (admin approval demo) and draft
    {
      title: 'Indie Shorts Night',
      category: 'Movies',
      organizerId: organizer,
      language: 'English',
      durationMin: 95,
      description: 'Six short films from first-time directors, followed by a Q&A.',
      status: 'pending',
      venueId: cinema,
      layout: screen1,
      prices: cinemaPrices,
      shows: [[16, 19]],
    },
    {
      title: 'Retro Synthwave Night',
      category: 'Concerts',
      organizerId: organizer,
      language: 'English',
      durationMin: 200,
      description: 'Eighties-inspired synth acts under a sea of neon.',
      status: 'pending',
      venueId: arena,
      layout: mainArena,
      prices: arenaPrices,
      shows: [],
    },
    {
      title: 'Watercolour Basics',
      category: 'Workshops',
      organizerId: organizer2,
      language: 'English',
      durationMin: 120,
      description: 'Learn washes, wet-on-wet and layering in a relaxed weekend session.',
      status: 'pending',
      venueId: hall,
      layout: mainHall,
      prices: [89900],
      shows: [],
    },
    {
      title: 'Untitled Comedy Special',
      category: 'Comedy',
      organizerId: organizer2,
      language: 'Hindi',
      durationMin: 60,
      description: 'Work in progress.',
      status: 'draft',
      venueId: hall,
      layout: mainHall,
      prices: [39900],
      shows: [],
    },
  ];

  const showsByEvent: Record<string, string[]> = {};
  for (const ev of events) {
    const slug = slugify(ev.title);
    const eventId = await insertId(
      client,
      `INSERT INTO events (organizer_id, category_id, title, slug, description, poster_url, language, duration_min, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        ev.organizerId,
        categories[ev.category],
        ev.title,
        slug,
        ev.description,
        poster(slug),
        ev.language,
        ev.durationMin,
        ev.status ?? 'published',
      ],
    );
    showsByEvent[ev.title] = [];
    for (const [day, hour, minute] of ev.shows) {
      showsByEvent[ev.title]!.push(
        await createShowWithInventory(client, {
          eventId,
          venueId: ev.venueId,
          layoutId: ev.layout.layoutId,
          startsAt: istDate(day, hour, minute),
          zonePrices: ev.layout.zoneIds.map((layoutZoneId, i) => ({
            layoutZoneId,
            pricePaise: ev.prices[i]!,
          })),
        }),
      );
    }
  }

  // A completed show in the past, so "past bookings" isn't empty
  const lighthouseEventId = (
    await client.query<{ id: string }>("SELECT id FROM events WHERE slug = 'the-last-lighthouse'")
  ).rows[0]!.id;
  const pastShow = await createShowWithInventory(client, {
    eventId: lighthouseEventId,
    venueId: cinema,
    layoutId: screen1.layoutId,
    startsAt: istDate(-5, 19),
    zonePrices: screen1.zoneIds.map((layoutZoneId, i) => ({
      layoutZoneId,
      pricePaise: cinemaPrices[i]!,
    })),
  });
  await client.query("UPDATE shows SET status = 'completed' WHERE id = $1", [pastShow]);

  // Make seat maps and zone pickers look lived-in
  const fills: [string, number, number][] = [
    ['Echoes of the Monsoon', 0, 0.6],
    ['Echoes of the Monsoon', 1, 0.3],
    ['The Last Lighthouse', 0, 0.85],
    ['Neon Drift', 0, 0.4],
    ['Midnight Raga Live', 0, 0.93], // "Filling fast"
    ['Chai & Chuckles', 0, 0.95],
    ['Open Mic Mayhem', 0, 0.5],
  ];
  for (const [title, showIndex, ratio] of fills) {
    await fillShow(client, showsByEvent[title]![showIndex]!, ratio, buyers);
  }

  // Bookings for attendee@demo.com
  const pickSeats = async (showId: string, zoneIndex: number, count: number) => {
    const zone = (await zonesOf(client, showId))[zoneIndex]!;
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM show_seats WHERE show_zone_id = $1 AND status = 'available'
       ORDER BY grid_row DESC, grid_col LIMIT $2`,
      [zone.id, count],
    );
    return { zoneId: zone.id, seatIds: rows.map((r) => r.id) };
  };

  const echoes = showsByEvent['Echoes of the Monsoon']![1]!;
  await seedBooking(
    client,
    attendee,
    echoes,
    [await pickSeats(echoes, 1, 2)],
    new Date(Date.now() - 2 * DAY),
  );

  const raga = showsByEvent['Midnight Raga Live']![0]!;
  const ragaZones = await zonesOf(client, raga);
  await seedBooking(
    client,
    attendee,
    raga,
    [{ zoneId: ragaZones[0]!.id, quantity: 2 }],
    new Date(Date.now() - DAY),
  );

  const improv = showsByEvent['Improv Nights: Yes, And']![0]!;
  const improvZones = await zonesOf(client, improv);
  await seedBooking(client, attendee, improv, [{ zoneId: improvZones[0]!.id, quantity: 3 }]);

  await seedBooking(
    client,
    attendee,
    pastShow,
    [await pickSeats(pastShow, 0, 2)],
    new Date(Date.now() - 8 * DAY),
  );
}

async function main(): Promise<void> {
  if (env.isProd && !process.argv.includes('--force')) {
    throw new Error(
      'Refusing to seed in production (wipes all data). Pass --force if you really mean it.',
    );
  }
  const started = Date.now();
  await withTransaction(seed);

  const { rows } = await pool.query<Record<string, string>>(`
    SELECT (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM events) AS events,
           (SELECT COUNT(*) FROM shows) AS shows,
           (SELECT COUNT(*) FROM show_seats) AS seats,
           (SELECT COUNT(*) FROM bookings) AS bookings`);
  console.log('Seed complete in', Date.now() - started, 'ms:', rows[0]);
  console.log(
    `Demo logins (password ${DEMO_PASSWORD}): attendee@demo.com, organizer@demo.com, admin@demo.com`,
  );
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
