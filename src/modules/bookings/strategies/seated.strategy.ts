import { conflict } from '../../../utils/app-error';
import { sortIds, type BookingStrategy } from './booking-strategy';

/**
 * Seated zones track each seat in show_seats, plus the same counters on show_zones
 * so availability numbers work the same way for both zone types.
 */
export const seatedZoneStrategy: BookingStrategy = {
  async hold(client, ctx, item) {
    // Sorted ids → every transaction locks seats in the same order → no lock-order deadlocks
    const seatIds = sortIds(item.seatIds!);

    // Zone counter first (lock order rule: zone row before seat rows)
    const zone = await client.query(
      `UPDATE show_zones SET held_count = held_count + $3
       WHERE id = $1 AND show_id = $2 AND type = 'seated'
         AND sold_count + held_count + $3 <= capacity
       RETURNING id`,
      [item.zoneId, ctx.showId, seatIds.length],
    );
    if (!zone.rowCount) {
      throw conflict('SEATS_UNAVAILABLE', 'Some of the selected seats are no longer available', {
        seatIds,
      });
    }

    // Conditional UPDATE (SPEC §5.1): only seats that are free (or whose hold has lapsed) are taken.
    // If another transaction holds a row lock on one of these seats we wait, then re-check the
    // WHERE clause — so only one of many concurrent requests for the same seat can win it.
    const taken = await client.query<{ id: string }>(
      `UPDATE show_seats
       SET status = 'held', hold_id = $4, held_until = $5
       WHERE id = ANY($1::uuid[]) AND show_id = $2 AND show_zone_id = $3
         AND (status = 'available' OR (status = 'held' AND held_until < now()))
       RETURNING id`,
      [seatIds, ctx.showId, item.zoneId, ctx.holdId, ctx.expiresAt],
    );

    if (taken.rowCount !== seatIds.length) {
      // Throwing rolls back the whole transaction, including any seats we did grab
      const got = new Set(taken.rows.map((r) => r.id));
      throw conflict('SEATS_UNAVAILABLE', 'Some of the selected seats are no longer available', {
        seatIds: seatIds.filter((id) => !got.has(id)),
      });
    }

    return seatIds.map((seatId) => ({ zoneId: item.zoneId, seatId, quantity: 1 }));
  },

  async confirm(client, holdId, zone) {
    await client.query(
      `UPDATE show_zones
       SET held_count = held_count - $2, sold_count = sold_count + $2
       WHERE id = $1`,
      [zone.zoneId, zone.quantity],
    );
    const booked = await client.query(
      `UPDATE show_seats SET status = 'booked', held_until = NULL
       WHERE id = ANY($1::uuid[]) AND hold_id = $2 AND status = 'held'`,
      [sortIds(zone.seatIds), holdId],
    );
    // If a seat was taken over after this hold lapsed, it no longer carries our hold_id
    if (booked.rowCount !== zone.seatIds.length) {
      throw conflict(
        'HOLD_EXPIRED',
        'Your hold expired and some seats were taken. Please pick again.',
      );
    }
  },

  async release(client, holdIds, zone) {
    // held_count was incremented once per seat when the hold was created, so undo exactly that
    await client.query('UPDATE show_zones SET held_count = held_count - $2 WHERE id = $1', [
      zone.zoneId,
      zone.quantity,
    ]);
    // Only free seats that still belong to these holds (an expired seat may already be re-held)
    await client.query(
      `UPDATE show_seats SET status = 'available', hold_id = NULL, held_until = NULL
       WHERE id = ANY($1::uuid[]) AND hold_id = ANY($2::uuid[]) AND status = 'held'`,
      [sortIds(zone.seatIds), holdIds],
    );
  },

  async cancel(client, zone) {
    await client.query('UPDATE show_zones SET sold_count = sold_count - $2 WHERE id = $1', [
      zone.zoneId,
      zone.quantity,
    ]);
    await client.query(
      `UPDATE show_seats SET status = 'available', hold_id = NULL, held_until = NULL
       WHERE id = ANY($1::uuid[]) AND status = 'booked'`,
      [sortIds(zone.seatIds)],
    );
  },
};
