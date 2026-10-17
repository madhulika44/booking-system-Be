import type { PoolClient } from 'pg';
import { badRequest } from '../../utils/app-error';

export interface CreateShowInput {
  eventId: string;
  venueId: string;
  layoutId: string;
  startsAt: Date;
  zonePrices: { layoutZoneId: string; pricePaise: number }[];
}

/**
 * Creates a show and snapshots its inventory from the layout (SPEC §3, §4):
 * layout_zones → show_zones and layout_seats (kind = 'seat') → show_seats.
 * Later edits to the layout never touch these rows.
 * Must be called inside a transaction.
 */
export async function createShowWithInventory(
  client: PoolClient,
  input: CreateShowInput,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO shows (event_id, venue_id, layout_id, starts_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.eventId, input.venueId, input.layoutId, input.startsAt],
  );
  const showId = rows[0]!.id;

  for (const { layoutZoneId, pricePaise } of input.zonePrices) {
    // Seated zone capacity = number of real seats (aisles / disabled cells excluded)
    const zone = await client.query<{ id: string; type: 'standing' | 'seated' }>(
      `INSERT INTO show_zones (show_id, name, type, price_paise, capacity, sort_order)
       SELECT $1, lz.name, lz.type, $3,
              CASE WHEN lz.type = 'standing' THEN lz.capacity
                   ELSE (SELECT COUNT(*)::int FROM layout_seats ls
                         WHERE ls.layout_zone_id = lz.id AND ls.kind = 'seat')
              END,
              lz.sort_order
       FROM layout_zones lz
       WHERE lz.id = $2 AND lz.layout_id = $4
       RETURNING id, type`,
      [showId, layoutZoneId, pricePaise, input.layoutId],
    );
    const showZone = zone.rows[0];
    if (!showZone) {
      throw badRequest('INVALID_LAYOUT_ZONE', 'Zone does not belong to this layout', {
        layoutZoneId,
      });
    }

    if (showZone.type === 'seated') {
      await client.query(
        `INSERT INTO show_seats (show_id, show_zone_id, row_label, seat_number, grid_row, grid_col)
         SELECT $1, $2, ls.row_label, ls.seat_number, ls.grid_row, ls.grid_col
         FROM layout_seats ls
         WHERE ls.layout_zone_id = $3 AND ls.kind = 'seat'`,
        [showId, showZone.id, layoutZoneId],
      );
    }
  }

  return showId;
}
