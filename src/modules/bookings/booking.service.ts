import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/db';
import { AppError, badRequest, conflict, notFound } from '../../utils/app-error';
import { generateBookingRef, generatePaymentRef } from '../../utils/booking-ref';
import { offsetOf, type Paginated, type Pagination } from '../../utils/pagination';
import * as holdsRepo from '../holds/holds.repository';
import type { HoldItemRecord, HoldRecord, HoldStatus } from '../holds/holds.repository';
import type { CreateHoldInput } from '../holds/holds.schemas';
import * as showsRepo from '../shows/shows.repository';
import type { ZoneType } from '../shows/shows.repository';
import * as bookingRepo from './booking.repository';
import type { BookingView } from './booking.repository';
import type { ConfirmBookingInput } from './booking.schemas';
import { strategyFor } from './strategies';
import type { ReservedItem, ZoneInventory } from './strategies/booking-strategy';

export const MAX_TICKETS_PER_BOOKING = 6;
export const HOLD_TTL_MINUTES = 10;

// ---------- helpers ----------

/**
 * Postgres aborts one side of a deadlock (40P01). Our lock ordering makes that rare, but if it
 * happens the whole transaction was rolled back, so it is safe to simply run it again.
 */
async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '40P01' || attempt >= attempts) throw err;
    }
  }
}

type InventoryRow = { zoneId: string; zoneType: ZoneType; seatId: string | null; quantity: number };

/** Groups hold/booking rows per zone, sorted by zone id (lock order rule). */
function groupByZone(rows: InventoryRow[]): (ZoneInventory & { zoneType: ZoneType })[] {
  const zones = new Map<string, ZoneInventory & { zoneType: ZoneType }>();
  for (const row of rows) {
    const zone = zones.get(row.zoneId) ?? {
      zoneId: row.zoneId,
      zoneType: row.zoneType,
      quantity: 0,
      seatIds: [],
    };
    zone.quantity += row.quantity;
    if (row.seatId) zone.seatIds.push(row.seatId);
    zones.set(row.zoneId, zone);
  }
  return [...zones.values()].sort((a, b) => a.zoneId.localeCompare(b.zoneId));
}

/**
 * Returns the inventory of the given holds (seats → available, counters −) and sets their status.
 * Used for: user release, replacing the user's previous hold, and expiry.
 */
async function releaseHolds(
  client: PoolClient,
  holdIds: string[],
  status: HoldStatus,
): Promise<void> {
  if (!holdIds.length) return;
  const items = await holdsRepo.listHoldItems(client, holdIds);
  for (const zone of groupByZone(items)) {
    await strategyFor(zone.zoneType).release(client, holdIds, zone);
  }
  await holdsRepo.setHoldStatus(client, holdIds, status);
}

/** Expires lapsed holds (optionally only for one show). Returns how many were expired. */
export async function releaseExpiredHolds(
  client: PoolClient,
  options: { showId?: string; limit?: number } = {},
): Promise<number> {
  const ids = await holdsRepo.lockExpiredHoldIds(
    client,
    options.showId ?? null,
    options.limit ?? 500,
  );
  await releaseHolds(client, ids, 'expired');
  return ids.length;
}

// ---------- hold view ----------

export interface HoldView {
  holdId: string;
  showId: string;
  status: HoldStatus;
  expiresAt: Date;
  items: {
    zoneId: string;
    zoneName: string;
    zoneType: ZoneType;
    unitPricePaise: number;
    quantity: number;
    seats: { id: string; rowLabel: string; seatNumber: number }[];
  }[];
  totalQuantity: number;
  totalPaise: number;
}

function buildHoldView(hold: HoldRecord, rows: HoldItemRecord[]): HoldView {
  const items = new Map<string, HoldView['items'][number]>();
  for (const r of rows) {
    const item = items.get(r.zoneId) ?? {
      zoneId: r.zoneId,
      zoneName: r.zoneName,
      zoneType: r.zoneType,
      unitPricePaise: r.pricePaise,
      quantity: 0,
      seats: [],
    };
    item.quantity += r.quantity;
    if (r.seatId) {
      item.seats.push({ id: r.seatId, rowLabel: r.rowLabel!, seatNumber: r.seatNumber! });
    }
    items.set(r.zoneId, item);
  }
  const list = [...items.values()];
  return {
    holdId: hold.id,
    showId: hold.showId,
    // lazy expiry: an "active" hold past its time is reported as expired
    status: hold.status === 'active' && hold.isExpired ? 'expired' : hold.status,
    expiresAt: hold.expiresAt,
    items: list,
    totalQuantity: list.reduce((sum, i) => sum + i.quantity, 0),
    totalPaise: list.reduce((sum, i) => sum + i.quantity * i.unitPricePaise, 0),
  };
}

// ---------- holds (SPEC §5.1, §5.3) ----------

function validateHoldRequest(input: CreateHoldInput): void {
  const zoneIds = input.items.map((i) => i.zoneId);
  if (new Set(zoneIds).size !== zoneIds.length) {
    throw badRequest('DUPLICATE_ZONE', 'Each zone may appear only once per hold');
  }
  const seatIds = input.items.flatMap((i) => ('seatIds' in i ? i.seatIds : []));
  if (new Set(seatIds).size !== seatIds.length) {
    throw badRequest('DUPLICATE_SEAT', 'A seat was selected more than once');
  }
  const total = input.items.reduce(
    (sum, i) => sum + ('seatIds' in i ? i.seatIds.length : i.quantity),
    0,
  );
  if (total > MAX_TICKETS_PER_BOOKING) {
    throw badRequest(
      'MAX_TICKETS_EXCEEDED',
      `You can book at most ${MAX_TICKETS_PER_BOOKING} tickets at a time`,
      { max: MAX_TICKETS_PER_BOOKING, requested: total },
    );
  }
}

export async function createHold(userId: string, input: CreateHoldInput): Promise<HoldView> {
  validateHoldRequest(input);

  try {
    return await retryOnDeadlock(() =>
      withTransaction(async (client) => {
        // 1. show must be bookable; items must match the show's zones
        const show = await showsRepo.findShowForBooking(client, input.showId);
        if (!show) throw notFound('Show');
        if (!show.bookable) {
          throw conflict('SHOW_NOT_BOOKABLE', 'This show is not open for booking');
        }

        const zones = new Map(
          (await showsRepo.listZonesForShow(client, input.showId)).map((z) => [z.id, z]),
        );
        for (const item of input.items) {
          const zone = zones.get(item.zoneId);
          if (!zone) {
            throw badRequest('INVALID_ZONE', 'Zone does not belong to this show', {
              zoneId: item.zoneId,
            });
          }
          const expected: ZoneType = 'seatIds' in item ? 'seated' : 'standing';
          if (zone.type !== expected) {
            throw badRequest(
              'ZONE_TYPE_MISMATCH',
              zone.type === 'seated'
                ? 'Pick specific seats for this zone'
                : 'Send a quantity for this zone',
              { zoneId: item.zoneId },
            );
          }
        }

        // 2. tidy up first: lapsed holds on this show (fixes counts before stale seats are
        //    taken over), then this user's previous active hold (one active hold per show)
        await releaseExpiredHolds(client, { showId: input.showId });
        const previous = await holdsRepo.lockActiveHoldIdsForUserShow(client, userId, input.showId);
        await releaseHolds(client, previous, 'released');

        // 3. the hold row (expires_at = now() + 10 min)
        const hold = await holdsRepo.insertHold(client, userId, input.showId, HOLD_TTL_MINUTES);
        const ctx = { holdId: hold.id, showId: input.showId, expiresAt: hold.expiresAt };

        // 4–5. reserve inventory zone by zone, in zone id order (lock order rule)
        const reserved: ReservedItem[] = [];
        const items = [...input.items].sort((a, b) => a.zoneId.localeCompare(b.zoneId));
        for (const item of items) {
          const strategy = strategyFor(zones.get(item.zoneId)!.type);
          reserved.push(...(await strategy.hold(client, ctx, item)));
        }

        // 6. hold items, then read back the full view inside the same transaction
        await holdsRepo.insertHoldItems(client, hold.id, reserved);
        const record = (await holdsRepo.findHoldForUser(hold.id, userId, client))!;
        return buildHoldView(record, await holdsRepo.listHoldItems(client, [hold.id]));
      }),
    );
  } catch (err) {
    // Two simultaneous hold requests from the same user for the same show
    if ((err as { constraint?: string }).constraint === 'holds_one_active_per_user_show_idx') {
      throw conflict(
        'HOLD_IN_PROGRESS',
        'Another hold for this show is being created for you. Please try again.',
      );
    }
    throw err;
  }
}

export async function getHold(userId: string, holdId: string): Promise<HoldView> {
  const hold = await holdsRepo.findHoldForUser(holdId, userId);
  if (!hold) throw notFound('Hold');
  return buildHoldView(hold, await holdsRepo.listHoldItems(pool, [holdId]));
}

export async function releaseHold(userId: string, holdId: string): Promise<void> {
  await retryOnDeadlock(() =>
    withTransaction(async (client) => {
      const hold = await holdsRepo.lockHoldForUser(client, holdId, userId);
      if (!hold) throw notFound('Hold');
      if (hold.status !== 'active') {
        throw conflict('HOLD_NOT_ACTIVE', `This hold is already ${hold.status}`);
      }
      await releaseHolds(client, [holdId], 'released');
    }),
  );
}

// ---------- bookings (SPEC §5.2, §5.3) ----------

async function loadBooking(bookingId: string, userId: string): Promise<BookingView> {
  const booking = await bookingRepo.findBookingForUser(bookingId, userId);
  if (!booking) throw notFound('Booking');
  return booking;
}

export async function confirmBooking(
  userId: string,
  input: ConfirmBookingInput,
  idempotencyKey: string,
): Promise<{ booking: BookingView; created: boolean }> {
  // Idempotency: a retried request (same key) returns the original booking, never a second one
  const existing = await bookingRepo.findBookingIdByIdempotencyKey(pool, idempotencyKey);
  if (existing) {
    if (existing.userId !== userId) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used');
    }
    return { booking: await loadBooking(existing.id, userId), created: false };
  }

  const outcome = await retryOnDeadlock(() =>
    withTransaction(async (client) => {
      // Lock the hold row: a parallel confirm of the same hold waits here until we commit
      const hold = await holdsRepo.lockHoldForUser(client, input.holdId, userId);
      if (!hold) throw notFound('Hold');

      // A parallel duplicate (same key) that was waiting on the lock sees our committed booking
      const duplicate = await bookingRepo.findBookingIdByIdempotencyKey(client, idempotencyKey);
      if (duplicate) return { bookingId: duplicate.id, created: false };

      if (hold.status === 'converted') {
        throw conflict('HOLD_ALREADY_CONVERTED', 'This hold has already been booked');
      }
      if (hold.status !== 'active' || hold.isExpired) {
        throw conflict('HOLD_EXPIRED', 'Your hold has expired. Please select tickets again.');
      }

      // Mock payment. Failure changes nothing, so the hold stays active for a retry until expiry.
      if (input.payment.simulate === 'failure') {
        throw new AppError(402, 'PAYMENT_FAILED', 'Payment was declined. You can try again.');
      }

      // Held → sold, zone by zone in zone id order
      const items = await holdsRepo.listHoldItems(client, [hold.id]);
      for (const zone of groupByZone(items)) {
        await strategyFor(zone.zoneType).confirm(client, hold.id, zone);
      }

      // Price is captured per item at booking time
      const totalPaise = items.reduce((sum, i) => sum + i.quantity * i.pricePaise, 0);
      const bookingId = await bookingRepo.insertBooking(client, {
        bookingRef: generateBookingRef(),
        userId,
        showId: hold.showId,
        holdId: hold.id,
        idempotencyKey,
        totalPaise,
        paymentRef: generatePaymentRef(),
      });
      await bookingRepo.insertBookingItems(
        client,
        bookingId,
        items.map((i) => ({
          zoneId: i.zoneId,
          seatId: i.seatId,
          quantity: i.quantity,
          unitPricePaise: i.pricePaise,
        })),
      );
      await holdsRepo.setHoldStatus(client, [hold.id], 'converted');
      return { bookingId, created: true };
    }),
  );

  return { booking: await loadBooking(outcome.bookingId, userId), created: outcome.created };
}

export async function cancelBooking(userId: string, bookingId: string): Promise<BookingView> {
  await retryOnDeadlock(() =>
    withTransaction(async (client) => {
      const booking = await bookingRepo.lockBookingForUser(client, bookingId, userId);
      if (!booking) throw notFound('Booking');
      if (booking.status === 'cancelled') {
        throw conflict('BOOKING_ALREADY_CANCELLED', 'This booking is already cancelled');
      }
      if (booking.withinCutoff) {
        throw conflict(
          'CANCELLATION_WINDOW_CLOSED',
          'Bookings can only be cancelled up to 2 hours before the show',
        );
      }

      // Sold → available, zone by zone in zone id order
      const items = await bookingRepo.listBookingInventory(client, bookingId);
      for (const zone of groupByZone(items)) {
        await strategyFor(zone.zoneType).cancel(client, zone);
      }
      await bookingRepo.markCancelled(client, bookingId);
    }),
  );
  return loadBooking(bookingId, userId);
}

export const getBooking = (userId: string, bookingId: string) => loadBooking(bookingId, userId);

export async function listMyBookings(
  userId: string,
  query: Pagination & { status?: 'upcoming' | 'past' },
): Promise<Paginated<BookingView>> {
  const { rows, total } = await bookingRepo.listBookingsForUser(
    userId,
    query.status,
    query.limit,
    offsetOf(query),
  );
  return { data: rows, page: query.page, limit: query.limit, total };
}

/**
 * Show cancelled by the organizer/admin: release every active hold and cancel every confirmed
 * booking, returning inventory exactly like a user cancellation would (mock payments, so there
 * is no refund to issue). Must run inside the caller's transaction.
 */
export async function cancelAllForShow(
  client: PoolClient,
  showId: string,
): Promise<{ releasedHolds: number; cancelledBookings: number }> {
  const holdIds = await holdsRepo.lockActiveHoldIdsForShow(client, showId);
  await releaseHolds(client, holdIds, 'released');

  const bookingIds = await bookingRepo.lockConfirmedBookingIdsForShow(client, showId);
  for (const bookingId of bookingIds) {
    const items = await bookingRepo.listBookingInventory(client, bookingId);
    for (const zone of groupByZone(items)) {
      await strategyFor(zone.zoneType).cancel(client, zone);
    }
    await bookingRepo.markCancelled(client, bookingId);
  }
  return { releasedHolds: holdIds.length, cancelledBookings: bookingIds.length };
}
