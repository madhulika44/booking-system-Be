import type { PoolClient } from 'pg';
import { pool, type Queryable } from '../../config/db';
import type { ZoneType } from '../shows/shows.repository';
import type { CellKind, GridCell } from './layout-grid';
import type { CreateVenueInput, LayoutInput } from './venues.schemas';

/**
 * ownerId = the organizer whose data may be touched, or null for admins (no restriction).
 * Ownership is part of every WHERE clause, so another organizer's rows simply aren't found.
 */
export type OwnerId = string | null;

export interface Venue {
  id: string;
  organizerId: string;
  name: string;
  address: string;
  city: string;
  createdAt: Date;
  layoutCount: number;
}

export interface LayoutSummary {
  id: string;
  venueId: string;
  name: string;
  createdAt: Date;
  zones: { id: string; name: string; type: ZoneType; capacity: number }[];
}

export interface LayoutDetail {
  id: string;
  venueId: string;
  name: string;
  createdAt: Date;
  zones: {
    id: string;
    name: string;
    type: ZoneType;
    sortOrder: number;
    capacity: number; // standing: as configured; seated: number of sellable seats
    rows: number | null;
    cols: number | null;
    cells: GridCell[];
  }[];
}

interface VenueRow {
  id: string;
  organizer_id: string;
  name: string;
  address: string;
  city: string;
  created_at: Date;
  layout_count: number;
}

const toVenue = (r: VenueRow): Venue => ({
  id: r.id,
  organizerId: r.organizer_id,
  name: r.name,
  address: r.address,
  city: r.city,
  createdAt: r.created_at,
  layoutCount: r.layout_count,
});

const VENUE_SELECT = `
  SELECT v.*, (SELECT COUNT(*)::int FROM layouts l WHERE l.venue_id = v.id) AS layout_count
  FROM venues v`;

// ---------- venues ----------

export async function listVenues(ownerId: OwnerId): Promise<Venue[]> {
  const { rows } = await pool.query<VenueRow>(
    `${VENUE_SELECT} WHERE ($1::uuid IS NULL OR v.organizer_id = $1) ORDER BY v.created_at DESC`,
    [ownerId],
  );
  return rows.map(toVenue);
}

export async function findVenue(
  id: string,
  ownerId: OwnerId,
  db: Queryable = pool,
): Promise<Venue | undefined> {
  const { rows } = await db.query<VenueRow>(
    `${VENUE_SELECT} WHERE v.id = $1 AND ($2::uuid IS NULL OR v.organizer_id = $2)`,
    [id, ownerId],
  );
  return rows[0] && toVenue(rows[0]);
}

export async function insertVenue(organizerId: string, input: CreateVenueInput): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO venues (organizer_id, name, address, city) VALUES ($1, $2, $3, $4) RETURNING id',
    [organizerId, input.name, input.address, input.city],
  );
  return rows[0]!.id;
}

export async function updateVenue(id: string, input: CreateVenueInput): Promise<void> {
  await pool.query('UPDATE venues SET name = $2, address = $3, city = $4 WHERE id = $1', [
    id,
    input.name,
    input.address,
    input.city,
  ]);
}

export async function deleteVenue(id: string): Promise<void> {
  await pool.query('DELETE FROM venues WHERE id = $1', [id]);
}

// ---------- layouts ----------

export async function listLayouts(venueId: string): Promise<LayoutSummary[]> {
  const { rows } = await pool.query<{
    id: string;
    venue_id: string;
    name: string;
    created_at: Date;
    zones: { id: string; name: string; type: ZoneType; capacity: number }[] | null;
  }>(
    `SELECT l.id, l.venue_id, l.name, l.created_at,
            (SELECT json_agg(json_build_object(
                      'id', lz.id, 'name', lz.name, 'type', lz.type,
                      'capacity', CASE WHEN lz.type = 'standing' THEN lz.capacity
                                       ELSE (SELECT COUNT(*) FROM layout_seats ls
                                             WHERE ls.layout_zone_id = lz.id AND ls.kind = 'seat') END
                    ) ORDER BY lz.sort_order)
             FROM layout_zones lz WHERE lz.layout_id = l.id) AS zones
     FROM layouts l
     WHERE l.venue_id = $1
     ORDER BY l.created_at`,
    [venueId],
  );
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    name: r.name,
    createdAt: r.created_at,
    zones: r.zones ?? [],
  }));
}

/** Layout with ownership checked through its venue. */
export async function findLayout(
  id: string,
  ownerId: OwnerId,
  db: Queryable = pool,
): Promise<{ id: string; venueId: string; organizerId: string } | undefined> {
  const { rows } = await db.query<{ id: string; venue_id: string; organizer_id: string }>(
    `SELECT l.id, l.venue_id, v.organizer_id
     FROM layouts l JOIN venues v ON v.id = l.venue_id
     WHERE l.id = $1 AND ($2::uuid IS NULL OR v.organizer_id = $2)`,
    [id, ownerId],
  );
  const r = rows[0];
  return r && { id: r.id, venueId: r.venue_id, organizerId: r.organizer_id };
}

export async function getLayoutDetail(id: string, db: Queryable = pool): Promise<LayoutDetail> {
  const layout = await db.query<{ id: string; venue_id: string; name: string; created_at: Date }>(
    'SELECT id, venue_id, name, created_at FROM layouts WHERE id = $1',
    [id],
  );
  const zones = await db.query<{
    id: string;
    name: string;
    type: ZoneType;
    sort_order: number;
    capacity: number | null;
    grid_rows: number | null;
    grid_cols: number | null;
  }>(
    `SELECT id, name, type, sort_order, capacity, grid_rows, grid_cols
     FROM layout_zones WHERE layout_id = $1 ORDER BY sort_order`,
    [id],
  );
  const cells = await db.query<{
    layout_zone_id: string;
    row_label: string;
    seat_number: number;
    grid_row: number;
    grid_col: number;
    kind: CellKind;
  }>(
    `SELECT ls.layout_zone_id, ls.row_label, ls.seat_number, ls.grid_row, ls.grid_col, ls.kind
     FROM layout_seats ls JOIN layout_zones lz ON lz.id = ls.layout_zone_id
     WHERE lz.layout_id = $1
     ORDER BY ls.grid_row, ls.grid_col`,
    [id],
  );

  const l = layout.rows[0]!;
  return {
    id: l.id,
    venueId: l.venue_id,
    name: l.name,
    createdAt: l.created_at,
    zones: zones.rows.map((z) => {
      const zoneCells: GridCell[] = cells.rows
        .filter((c) => c.layout_zone_id === z.id)
        .map((c) => ({
          rowLabel: c.row_label,
          seatNumber: c.seat_number,
          gridRow: c.grid_row,
          gridCol: c.grid_col,
          kind: c.kind,
        }));
      return {
        id: z.id,
        name: z.name,
        type: z.type,
        sortOrder: z.sort_order,
        capacity:
          z.type === 'standing' ? z.capacity! : zoneCells.filter((c) => c.kind === 'seat').length,
        rows: z.grid_rows,
        cols: z.grid_cols,
        cells: zoneCells,
      };
    }),
  };
}

export async function insertLayout(
  client: PoolClient,
  venueId: string,
  name: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO layouts (venue_id, name) VALUES ($1, $2) RETURNING id',
    [venueId, name],
  );
  return rows[0]!.id;
}

export async function renameLayout(client: PoolClient, id: string, name: string): Promise<void> {
  await client.query('UPDATE layouts SET name = $2 WHERE id = $1', [id, name]);
}

/** Replaces all zones and cells of a layout. Existing shows keep their own snapshot. */
export async function replaceLayoutZones(
  client: PoolClient,
  layoutId: string,
  zones: LayoutInput['zones'],
  grid: GridCell[][],
): Promise<void> {
  await client.query('DELETE FROM layout_zones WHERE layout_id = $1', [layoutId]); // cascades cells

  for (const [i, zone] of zones.entries()) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO layout_zones (layout_id, name, type, capacity, grid_rows, grid_cols, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      zone.type === 'standing'
        ? [layoutId, zone.name, 'standing', zone.capacity, null, null, i]
        : [layoutId, zone.name, 'seated', null, zone.rows, zone.cols, i],
    );
    const cells = grid[i]!;
    if (!cells.length) continue;
    await client.query(
      `INSERT INTO layout_seats (layout_zone_id, row_label, seat_number, grid_row, grid_col, kind)
       SELECT $1, * FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::text[])`,
      [
        rows[0]!.id,
        cells.map((c) => c.rowLabel),
        cells.map((c) => c.seatNumber),
        cells.map((c) => c.gridRow),
        cells.map((c) => c.gridCol),
        cells.map((c) => c.kind),
      ],
    );
  }
}

export async function deleteLayout(id: string): Promise<void> {
  await pool.query('DELETE FROM layouts WHERE id = $1', [id]);
}
