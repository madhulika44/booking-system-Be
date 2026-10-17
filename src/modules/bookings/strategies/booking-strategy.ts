import type { PoolClient } from 'pg';
import type { ZoneType } from '../../shows/shows.repository';

/** What the client asked to hold in one zone. */
export interface HoldRequestItem {
  zoneId: string;
  quantity?: number; // standing
  seatIds?: string[]; // seated
}

export interface HoldContext {
  holdId: string;
  showId: string;
  expiresAt: Date;
}

/** One hold_items / booking_items row: a seat (quantity 1) or a standing quantity. */
export interface ReservedItem {
  zoneId: string;
  seatId: string | null;
  quantity: number;
}

/** Inventory of one zone inside a hold or booking, aggregated. */
export interface ZoneInventory {
  zoneId: string;
  quantity: number;
  seatIds: string[];
}

/**
 * Each zone type reserves inventory differently; BookingService picks the strategy per zone
 * and owns the transaction (every method receives the transaction's client).
 *
 * Lock order rule (prevents deadlocks): always lock the show_zones row first, then show_seats
 * rows in ascending id order. Callers process zones in ascending zone id order.
 */
export interface BookingStrategy {
  /** Reserve inventory for a new hold. Throws 409 if not available. */
  hold(client: PoolClient, ctx: HoldContext, item: HoldRequestItem): Promise<ReservedItem[]>;
  /** Held → sold (booking confirmed). */
  confirm(client: PoolClient, holdId: string, zone: ZoneInventory): Promise<void>;
  /** Held → available (user released, hold replaced, or hold expired). */
  release(client: PoolClient, holdIds: string[], zone: ZoneInventory): Promise<void>;
  /** Sold → available (booking cancelled). */
  cancel(client: PoolClient, zone: ZoneInventory): Promise<void>;
}

export type { ZoneType };

export const sortIds = (ids: string[]) => [...ids].sort();
