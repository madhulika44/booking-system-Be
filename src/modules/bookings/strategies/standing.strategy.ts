import { conflict } from '../../../utils/app-error';
import type { BookingStrategy } from './booking-strategy';

/**
 * Standing zones are just counters on show_zones (capacity / sold_count / held_count).
 */
export const standingZoneStrategy: BookingStrategy = {
  async hold(client, ctx, item) {
    const quantity = item.quantity!;
    // Atomic check-and-increment (SPEC §5.1): the capacity check and the increment happen in one
    // statement while Postgres holds the row lock, so two buyers can never both take the last spot.
    // A concurrent request waits for our row lock, then re-evaluates the WHERE against the new counts.
    const { rowCount } = await client.query(
      `UPDATE show_zones SET held_count = held_count + $3
       WHERE id = $1 AND show_id = $2 AND type = 'standing'
         AND sold_count + held_count + $3 <= capacity
       RETURNING id`,
      [item.zoneId, ctx.showId, quantity],
    );
    if (!rowCount) {
      throw conflict('ZONE_SOLD_OUT', 'Not enough tickets left in this zone', {
        zoneId: item.zoneId,
        requested: quantity,
      });
    }
    return [{ zoneId: item.zoneId, seatId: null, quantity }];
  },

  async confirm(client, _holdId, zone) {
    await client.query(
      `UPDATE show_zones
       SET held_count = held_count - $2, sold_count = sold_count + $2
       WHERE id = $1`,
      [zone.zoneId, zone.quantity],
    );
  },

  async release(client, _holdIds, zone) {
    await client.query('UPDATE show_zones SET held_count = held_count - $2 WHERE id = $1', [
      zone.zoneId,
      zone.quantity,
    ]);
  },

  async cancel(client, zone) {
    await client.query('UPDATE show_zones SET sold_count = sold_count - $2 WHERE id = $1', [
      zone.zoneId,
      zone.quantity,
    ]);
  },
};
